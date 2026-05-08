import { Router } from 'express';
import mongoose from 'mongoose';
import { Queue } from 'bullmq';
import { redis } from '../lib/redis.js';
import { QUEUE_NAMES } from '../lib/queues.js';
import { logger } from '../lib/logger.js';

/**
 * Read-only diagnostics endpoint backing Settings → Diagnostics.
 *
 * Aggregates three sources:
 *   1. BullMQ queue counts (waiting / active / completed / failed
 *      / delayed) for every known queue. Read directly from Redis;
 *      no worker required.
 *   2. Per-worker snapshots — every running worker process
 *      publishes its in-process counters / gauges / histograms to
 *      `rose:metrics:<workerId>` every 30s with 60s TTL. We read
 *      the live set under `rose:metrics:workers` and pull each
 *      JSON blob.
 *   3. Mongo health — connection state + collection counts for
 *      the largest tables.
 *
 * No auth gate beyond the standard requireAuth middleware that
 * mounts the router; per-user data isn't exposed here so admin-
 * only would be paranoid for a single-user self-host. Operators
 * running multi-tenant should layer admin-role enforcement on
 * top.
 */

export const diagnosticsRouter: Router = Router();

type WorkerSnapshot = {
  workerId: string;
  workerMode: string;
  pid: number;
  hostname: string;
  uptimeSec: number;
  startedAt: number;
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  loopDelay: { p50: number; p95: number; p99: number; max: number };
  counters: Record<string, number>;
  gauges: Record<string, number>;
  histograms: Record<
    string,
    { count: number; sum: number; max: number; p50: number; p95: number; p99: number }
  >;
};

async function collectWorkerSnapshots(): Promise<WorkerSnapshot[]> {
  const ids = (await redis.smembers('rose:metrics:workers')) ?? [];
  if (ids.length === 0) return [];
  const keys = ids.map((id) => `rose:metrics:${id}`);
  const blobs = (await redis.mget(...keys)) ?? [];
  const snapshots: WorkerSnapshot[] = [];
  for (let i = 0; i < blobs.length; i += 1) {
    const raw = blobs[i];
    if (!raw) {
      // TTL expired — clean up the stale set entry.
      await redis.srem('rose:metrics:workers', ids[i]!);
      continue;
    }
    try {
      snapshots.push(JSON.parse(raw) as WorkerSnapshot);
    } catch (err) {
      logger.debug({ err, id: ids[i] }, 'diagnostics: snapshot parse failed');
    }
  }
  // Stable order: by mode then start time.
  return snapshots.sort((a, b) => {
    if (a.workerMode !== b.workerMode) return a.workerMode.localeCompare(b.workerMode);
    return a.startedAt - b.startedAt;
  });
}

/**
 * Sum counters / max gauges / weighted-mean histograms across all
 * snapshots so the UI can render single per-metric numbers in
 * addition to the per-worker breakdown. Histogram p50/p95/p99 are
 * NOT mathematically combinable across processes; we just average
 * them, which is good enough for an at-a-glance dashboard.
 */
function aggregateSnapshots(snaps: WorkerSnapshot[]) {
  const counters: Record<string, number> = {};
  const gauges: Record<string, number> = {};
  const hCounts: Record<string, number> = {};
  const hMaxes: Record<string, number> = {};
  const hSums: Record<string, number> = {};
  const hP50: Record<string, number[]> = {};
  const hP95: Record<string, number[]> = {};
  const hP99: Record<string, number[]> = {};
  for (const s of snaps) {
    for (const [k, v] of Object.entries(s.counters)) {
      counters[k] = (counters[k] ?? 0) + v;
    }
    for (const [k, v] of Object.entries(s.gauges)) {
      gauges[k] = Math.max(gauges[k] ?? -Infinity, v);
    }
    for (const [k, h] of Object.entries(s.histograms)) {
      hCounts[k] = (hCounts[k] ?? 0) + h.count;
      hSums[k] = (hSums[k] ?? 0) + h.sum;
      hMaxes[k] = Math.max(hMaxes[k] ?? 0, h.max);
      (hP50[k] ??= []).push(h.p50);
      (hP95[k] ??= []).push(h.p95);
      (hP99[k] ??= []).push(h.p99);
    }
  }
  const histograms: Record<
    string,
    { count: number; sum: number; max: number; p50: number; p95: number; p99: number }
  > = {};
  for (const k of Object.keys(hCounts)) {
    const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    histograms[k] = {
      count: hCounts[k] ?? 0,
      sum: hSums[k] ?? 0,
      max: hMaxes[k] ?? 0,
      p50: avg(hP50[k] ?? []),
      p95: avg(hP95[k] ?? []),
      p99: avg(hP99[k] ?? []),
    };
  }
  return { counters, gauges, histograms };
}

async function collectQueueStats(): Promise<
  {
    name: string;
    waiting: number;
    active: number;
    delayed: number;
    failed: number;
    completed: number;
  }[]
> {
  const conn = { connection: redis };
  const queues = Object.values(QUEUE_NAMES).map((name) => ({
    name,
    queue: new Queue(name, conn),
  }));
  try {
    const out = await Promise.all(
      queues.map(async ({ name, queue }) => {
        const c = await queue.getJobCounts(
          'waiting',
          'active',
          'delayed',
          'failed',
          'completed',
        );
        return {
          name,
          waiting: Number(c.waiting ?? 0),
          active: Number(c.active ?? 0),
          delayed: Number(c.delayed ?? 0),
          failed: Number(c.failed ?? 0),
          completed: Number(c.completed ?? 0),
        };
      }),
    );
    return out;
  } finally {
    // We constructed handles solely for this read; close them so
    // the API doesn't leak a connection per request.
    for (const q of queues) {
      await q.queue.close().catch(() => null);
    }
  }
}

async function collectMongoStats() {
  const state = mongoose.connection.readyState;
  const stateLabel =
    state === 0
      ? 'disconnected'
      : state === 1
        ? 'connected'
        : state === 2
          ? 'connecting'
          : state === 3
            ? 'disconnecting'
            : 'unknown';
  const tracked = ['emails', 'pages', 'webdocuments', 'librarydocuments', 'senders', 'pagerevisions'];
  const counts: Record<string, number> = {};
  if (state === 1 && mongoose.connection.db) {
    const db = mongoose.connection.db;
    for (const c of tracked) {
      try {
        counts[c] = await db.collection(c).estimatedDocumentCount();
      } catch {
        counts[c] = -1;
      }
    }
  }
  return { state: stateLabel, collectionCounts: counts };
}

/**
 * Recent slow queries from MongoDB's `system.profile` capped
 * collection. The worker enables profiling at boot
 * (`profile: 1, slowms: 100`); we read the most recent N entries
 * and surface them in the diagnostics view so an operator can
 * answer "which queries actually need indexes" without ssh'ing
 * into the mongo container.
 *
 * The profiler is best-effort — Atlas tier restrictions or
 * permission issues may prevent the worker from enabling it. In
 * those cases this read returns an empty list and a `disabled`
 * flag so the UI can render "profiling unavailable."
 */
type SlowQuery = {
  ts: string;
  ns: string;
  op: string;
  millis: number;
  docsExamined: number | null;
  nreturned: number | null;
  /** Sample of the filter / pipeline / update — capped JSON. */
  query: string;
  planSummary: string | null;
  /** True iff Mongo's planner used a collection scan. The whole
   *  point of the indexes we added is to remove these — the UI
   *  highlights them. */
  collscan: boolean;
};

async function collectSlowQueries(): Promise<{
  enabled: boolean;
  level: number | null;
  slowms: number | null;
  recent: SlowQuery[];
}> {
  if (!mongoose.connection.db) {
    return { enabled: false, level: null, slowms: null, recent: [] };
  }
  const db = mongoose.connection.db;
  let level: number | null = null;
  let slowms: number | null = null;
  try {
    const status = await db.command({ profile: -1 });
    level = (status.was as number | undefined) ?? null;
    slowms = (status.slowms as number | undefined) ?? null;
  } catch (err) {
    logger.debug({ err: (err as Error).message }, 'diagnostics: profile status check failed');
    return { enabled: false, level: null, slowms: null, recent: [] };
  }

  if (!level || level === 0) {
    return { enabled: false, level, slowms, recent: [] };
  }

  let docs: Record<string, unknown>[] = [];
  try {
    docs = (await db
      .collection('system.profile')
      .find({}, { sort: { ts: -1 }, limit: 50 })
      .toArray()) as unknown as Record<string, unknown>[];
  } catch (err) {
    logger.debug({ err: (err as Error).message }, 'diagnostics: system.profile read failed');
    return { enabled: false, level, slowms, recent: [] };
  }

  const recent: SlowQuery[] = docs.map((d) => {
    const ns = String(d.ns ?? '');
    // Pick the most-likely "what was this trying to do" payload to
    // serialise. Different op types put their payload in different
    // fields; we prefer command > filter > query > pipeline.
    const cmd = (d.command ?? d.filter ?? d.query ?? d.pipeline) as unknown;
    let queryStr = '';
    try {
      queryStr = JSON.stringify(cmd ?? {});
      if (queryStr.length > 600) queryStr = queryStr.slice(0, 600) + '…';
    } catch {
      queryStr = '(unserializable)';
    }
    const planSummary = (d.planSummary as string | undefined) ?? null;
    return {
      ts: new Date((d.ts as Date | number) ?? Date.now()).toISOString(),
      ns,
      op: String(d.op ?? d.queryHash ?? 'op'),
      millis: Number(d.millis ?? 0),
      docsExamined:
        typeof d.docsExamined === 'number' ? (d.docsExamined as number) : null,
      nreturned:
        typeof d.nreturned === 'number' ? (d.nreturned as number) : null,
      query: queryStr,
      planSummary,
      collscan: typeof planSummary === 'string' && planSummary.includes('COLLSCAN'),
    };
  });

  return { enabled: true, level, slowms, recent };
}

diagnosticsRouter.get('/', async (_req, res, next) => {
  try {
    const [workers, queues, mongo, slowQueries] = await Promise.all([
      collectWorkerSnapshots(),
      collectQueueStats(),
      collectMongoStats(),
      collectSlowQueries(),
    ]);
    const totals = aggregateSnapshots(workers);
    res.json({
      generatedAt: new Date().toISOString(),
      workers,
      totals,
      queues,
      mongo,
      slowQueries,
    });
  } catch (err) {
    next(err);
  }
});
