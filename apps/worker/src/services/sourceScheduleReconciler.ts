import { Queue } from 'bullmq';
import { Source } from '@rose/db';
import { redis } from '../lib/redis.js';
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
      q = new Queue(QUEUE_BY_TYPE[type]!, { connection: redis });
      queues.set(type, q);
    }
    return q;
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
      // BullMQ stores repeatables in a sorted set per queue. We can't
      // query by our friendly jobId directly; getRepeatableJobs()
      // returns the live list and we filter by `id` (which mirrors
      // the jobId we passed at add-time).
      const existing = await queue.getRepeatableJobs(0, 5000, true);
      const match = existing.find((r) => r.id === repeatKey);
      // `every` comes back from BullMQ as a string-encoded number on
      // recent versions; normalise to a number before comparing.
      const matchEvery = match
        ? typeof match.every === 'number'
          ? match.every
          : match.every
            ? Number(match.every)
            : null
        : null;
      if (match && matchEvery === every) {
        alreadyArmed += 1;
        continue;
      }
      // Drop whatever stale entry exists (mismatched interval, or
      // none — both are no-ops from removeRepeatableByKey's perspective).
      try {
        await queue.removeRepeatableByKey(repeatKey);
      } catch (err) {
        logger.debug({ err, repeatKey }, 'reconcile: removeRepeatableByKey failed (continuing)');
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
