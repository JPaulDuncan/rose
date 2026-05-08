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

diagnosticsRouter.get('/', async (_req, res, next) => {
  try {
    const [workers, queues, mongo] = await Promise.all([
      collectWorkerSnapshots(),
      collectQueueStats(),
      collectMongoStats(),
    ]);
    const totals = aggregateSnapshots(workers);
    res.json({
      generatedAt: new Date().toISOString(),
      workers,
      totals,
      queues,
      mongo,
    });
  } catch (err) {
    next(err);
  }
});
