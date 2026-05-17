import { Queue } from 'bullmq';
import { Source } from '@rose/db';
import { bullConnection } from '../lib/redis.js';
import { logger } from '../lib/logger.js';

/**
 * Reconcile each Source row with a corresponding BullMQ repeatable
 * for its sync queue. Without this, every source's schedule lives
 * only in Redis — wipe the redis_data volume (or hit any persistence
 * gap) and IMAP / RSS / website / Slack / Discord / Gcal mailboxes
 * silently stop polling forever, since the API only adds the
 * repeatable on Source create or interval edit.
 *
 * Runs on worker boot. For every active source we:
 *   1. Look up the existing repeatable by jobId (`<type>:<id>`).
 *   2. If it's missing or its `every` doesn't match the current
 *      `pollIntervalMinutes`, drop it and re-add.
 *   3. If a one-shot job is also queued (immediate kick after a
 *      reconnect), it lands on the existing queue and runs through
 *      the normal worker — we don't enqueue one here to avoid
 *      stampedes when the operator restarts the worker.
 *
 * Safe to run repeatedly; idempotent in steady state.
 */

const QUEUE_BY_TYPE: Record<string, string> = {
  imap: 'rose.imap-sync',
  gmail: 'rose.gmail-sync',
  rss: 'rose.rss-sync',
  website: 'rose.website-sync',
  slack: 'rose.slack-sync',
  discord: 'rose.discord-sync',
  gcal: 'rose.gcal-sync',
  ics: 'rose.ics-sync',
};

const SYNCABLE_TYPES = Object.keys(QUEUE_BY_TYPE);

export async function reconcileSourceSchedules(): Promise<{
  total: number;
  reArmed: number;
  alreadyArmed: number;
}> {
  const sources = await Source.find({
    type: { $in: SYNCABLE_TYPES },
    status: { $ne: 'paused' },
  })
    .select('type pollIntervalMinutes userId')
    .lean();

  // One Queue handle per type; close them all at the end.
  const queues = new Map<string, Queue>();
  function queueFor(type: string): Queue {
    let q = queues.get(type);
    if (!q) {
      q = new Queue(QUEUE_BY_TYPE[type]!, { connection: bullConnection() });
      queues.set(type, q);
    }
    return q;
  }

  /**
   * Page through every repeatable for the given queue and build a
   * lookup of repeatKey → repeatable. Without paging, the previous
   * `getRepeatableJobs(0, 5000)` call silently truncated above 5000
   * entries, leaving sources past the cap silently un-armed. Also a
   * meaningful CPU win: we used to call this once per source, now
   * once per type.
   */
  const repeatablesByType = new Map<
    string,
    Map<string, { id: string | null; key: string; every: number | null }>
  >();
  async function loadRepeatables(type: string): Promise<
    Map<string, { id: string | null; key: string; every: number | null }>
  > {
    const cached = repeatablesByType.get(type);
    if (cached) return cached;
    const queue = queueFor(type);
    const PAGE = 1000;
    const map = new Map<string, { id: string | null; key: string; every: number | null }>();
    for (let start = 0; ; start += PAGE) {
      const batch = await queue.getRepeatableJobs(start, start + PAGE - 1, true);
      for (const r of batch) {
        if (!r.id) continue;
        const every =
          typeof r.every === 'number'
            ? r.every
            : r.every
              ? Number(r.every)
              : null;
        map.set(r.id, { id: r.id, key: r.key, every });
      }
      if (batch.length < PAGE) break;
    }
    repeatablesByType.set(type, map);
    return map;
  }

  let reArmed = 0;
  let alreadyArmed = 0;
  try {
    for (const s of sources) {
      const type = s.type as string;
      const interval = (s.pollIntervalMinutes as number | undefined) ?? 30;
      const every = Math.max(1, interval) * 60_000;
      const repeatKey = `${type}:${String(s._id)}`;

      const queue = queueFor(type);
      const existing = await loadRepeatables(type);
      const match = existing.get(repeatKey);
      if (match && match.every === every) {
        alreadyArmed += 1;
        continue;
      }
      // Only call removeRepeatableByKey when a stale match exists —
      // and pass BullMQ's internal `key`, not the friendly jobId. The
      // previous code passed `repeatKey` (the jobId) which is the
      // wrong identifier; removeRepeatableByKey would silently fail
      // and the duplicate add below would land alongside the stale
      // schedule, doubling up the polling cadence.
      if (match) {
        try {
          await queue.removeRepeatableByKey(match.key);
        } catch (err) {
          logger.debug(
            { err, repeatKey, key: match.key },
            'reconcile: removeRepeatableByKey failed (continuing)',
          );
        }
      }
      try {
        await queue.add(
          'sync',
          {
            sourceId: String(s._id),
            userId: String(s.userId),
          },
          {
            repeat: { every },
            jobId: repeatKey,
          },
        );
        reArmed += 1;
      } catch (err) {
        logger.warn({ err, repeatKey, every }, 'reconcile: failed to re-arm source schedule');
      }
    }
  } finally {
    for (const q of queues.values()) await q.close().catch(() => null);
  }
  return { total: sources.length, reArmed, alreadyArmed };
}
