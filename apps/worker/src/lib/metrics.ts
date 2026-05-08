import { performance, monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import os from 'node:os';
import { redis } from './redis.js';
import { logger } from './logger.js';

/**
 * Lightweight in-process metrics for the worker. Designed for the
 * "self-hosted, single-operator" deployment shape — full Prometheus
 * is overkill; we just need enough visibility to answer "is the
 * worker keeping up?" and "is web research costing me?" from the
 * Settings → Diagnostics view in the SPA.
 *
 * The worker process maintains:
 *   • Counters    (events; e.g. emails-ingested, fetches-attempted)
 *   • Histograms  (durations; we keep p50/p95/p99 + count)
 *   • Gauges      (point-in-time; e.g. worker mode, process uptime)
 *
 * Every 30s the snapshot is flushed to Redis under a per-process
 * key with 60s TTL — the API reads + aggregates across the live
 * keys to render the dashboard. No durable storage; if the worker
 * restarts, counters reset (the dashboard should make this clear
 * with an "uptime" reading).
 *
 * Safe across the four worker-mode split: each process gets its
 * own Redis key tagged with its WORKER_MODE + a random shard so
 * the API sees N different snapshots when N workers run.
 */

type Bucket = number[];
type Histogram = {
  /** Reservoir sample of recent observations. Bounded so the
   *  worker doesn't grow unboundedly under sustained load. */
  samples: Bucket;
  count: number;
  sum: number;
  max: number;
};

const MAX_SAMPLES = 1024;

// One global registry per process. The constants below are the
// canonical metric names — adding a new one means adding it here
// AND consuming it on the API side. Keep the list short.
const counters = new Map<string, number>();
const histograms = new Map<string, Histogram>();
const gauges = new Map<string, number>();

/** Per-host fetch tallies for the topic-research surface. Keyed
 *  by `${counter}:${host}`. */
function counterKey(name: string, labels?: Record<string, string>): string {
  if (!labels) return name;
  const parts = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`);
  return `${name}|${parts.join(',')}`;
}

export function inc(name: string, n = 1, labels?: Record<string, string>): void {
  const key = counterKey(name, labels);
  counters.set(key, (counters.get(key) ?? 0) + n);
}

export function setGauge(name: string, value: number): void {
  gauges.set(name, value);
}

export function observe(
  name: string,
  durationMs: number,
  labels?: Record<string, string>,
): void {
  const key = counterKey(name, labels);
  let h = histograms.get(key);
  if (!h) {
    h = { samples: [], count: 0, sum: 0, max: 0 };
    histograms.set(key, h);
  }
  h.count += 1;
  h.sum += durationMs;
  if (durationMs > h.max) h.max = durationMs;
  if (h.samples.length < MAX_SAMPLES) {
    h.samples.push(durationMs);
  } else {
    // Reservoir-style replacement so old observations don't
    // dominate the percentile calc indefinitely.
    const idx = Math.floor(Math.random() * h.count);
    if (idx < MAX_SAMPLES) h.samples[idx] = durationMs;
  }
}

/** Time an async operation and observe its duration. Catches +
 *  rethrows so failures are recorded too (with `outcome=failed`). */
export async function timeAsync<T>(
  name: string,
  fn: () => Promise<T>,
  labels?: Record<string, string>,
): Promise<T> {
  const t0 = performance.now();
  try {
    const r = await fn();
    observe(name, performance.now() - t0, { ...labels, outcome: 'ok' });
    return r;
  } catch (err) {
    observe(name, performance.now() - t0, { ...labels, outcome: 'failed' });
    throw err;
  }
}

function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

/** Snapshot for serialisation. Counters/gauges flatten cleanly;
 *  histograms summarise to count/sum/max + p50/p95/p99 so the
 *  Redis payload stays small even with thousands of samples. */
export type MetricsSnapshot = {
  workerId: string;
  workerMode: string;
  pid: number;
  hostname: string;
  uptimeSec: number;
  startedAt: number;
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  /** Event-loop delay percentiles, milliseconds. */
  loopDelay: { p50: number; p95: number; p99: number; max: number };
  counters: Record<string, number>;
  gauges: Record<string, number>;
  histograms: Record<
    string,
    { count: number; sum: number; max: number; p50: number; p95: number; p99: number }
  >;
};

let elDelay: IntervalHistogram | null = null;
const startedAt = Date.now();
const workerId = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

function ensureElDelay(): IntervalHistogram {
  if (!elDelay) {
    elDelay = monitorEventLoopDelay({ resolution: 20 });
    elDelay.enable();
  }
  return elDelay;
}

export function snapshot(): MetricsSnapshot {
  const mem = process.memoryUsage();
  const el = ensureElDelay();
  const histos: MetricsSnapshot['histograms'] = {};
  for (const [k, h] of histograms) {
    histos[k] = {
      count: h.count,
      sum: h.sum,
      max: h.max,
      p50: percentile(h.samples, 50),
      p95: percentile(h.samples, 95),
      p99: percentile(h.samples, 99),
    };
  }
  return {
    workerId,
    workerMode: process.env.WORKER_MODE ?? 'all',
    pid: process.pid,
    hostname: os.hostname(),
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    startedAt,
    rssBytes: mem.rss,
    heapUsedBytes: mem.heapUsed,
    heapTotalBytes: mem.heapTotal,
    loopDelay: {
      // perf_hooks histogram returns ns; convert to ms.
      p50: Math.round(el.percentile(50) / 1e6),
      p95: Math.round(el.percentile(95) / 1e6),
      p99: Math.round(el.percentile(99) / 1e6),
      max: Math.round(el.max / 1e6),
    },
    counters: Object.fromEntries(counters),
    gauges: Object.fromEntries(gauges),
    histograms: histos,
  };
}

/**
 * Flush the in-process snapshot to Redis. The API reads the live
 * set every poll. TTL keeps the registry self-cleaning when a
 * worker process exits without unregistering.
 */
async function publishSnapshot(): Promise<void> {
  try {
    const snap = snapshot();
    await redis.set(
      `rose:metrics:${workerId}`,
      JSON.stringify(snap),
      'EX',
      60,
    );
    await redis.sadd('rose:metrics:workers', workerId);
    await redis.expire('rose:metrics:workers', 600);
  } catch (err) {
    logger.debug({ err }, 'metrics: publish failed (non-fatal)');
  }
}

/**
 * Start the periodic publisher. Called once from the worker
 * bootstrap regardless of WORKER_MODE — every process publishes
 * its own slice so the API can render per-process detail in the
 * Diagnostics view.
 */
export function startMetricsPublisher(): void {
  ensureElDelay();
  // Initial publish so the dashboard has data before the first
  // 30s tick.
  void publishSnapshot();
  const interval = setInterval(() => {
    void publishSnapshot();
  }, 30_000);
  interval.unref();

  // Graceful unregister on shutdown — cleans up the worker's row
  // from the registry set so the dashboard doesn't show stale
  // entries.
  const cleanup = async () => {
    try {
      await redis.del(`rose:metrics:${workerId}`);
      await redis.srem('rose:metrics:workers', workerId);
    } catch {
      // best-effort
    }
  };
  process.on('beforeExit', () => void cleanup());
  process.on('SIGINT', () => void cleanup());
  process.on('SIGTERM', () => void cleanup());
}

/** Standard metric names. Adding a new one means adding to this
 *  registry AND consuming on the API + UI side. */
export const METRIC = {
  /** generatePage worker job durations. */
  GENERATE_PAGE_DURATION_MS: 'generate_page_duration_ms',
  /** Topic-research orchestrator end-to-end run duration. */
  TOPIC_RESEARCH_DURATION_MS: 'topic_research_duration_ms',
  /** Topic-research per-fetch durations. */
  TOPIC_RESEARCH_FETCH_MS: 'topic_research_fetch_ms',
  /** Topic-research counters. */
  TOPIC_RESEARCH_FETCHES: 'topic_research_fetches',
  TOPIC_RESEARCH_KEPT: 'topic_research_kept',
  TOPIC_RESEARCH_OFF_TOPIC: 'topic_research_off_topic',
  TOPIC_RESEARCH_ROBOTS_BLOCKED: 'topic_research_robots_blocked',
  /** Per-Ollama-call latency for generation + embedding. */
  OLLAMA_GEN_MS: 'ollama_gen_ms',
  OLLAMA_EMBED_MS: 'ollama_embed_ms',
  /** Email ingest events. */
  EMAIL_INGESTED: 'email_ingested',
  EMAIL_DUP_SKIPPED: 'email_dup_skipped',
  EMAIL_BLOCKED_AT_INGEST: 'email_blocked_at_ingest',
} as const;
