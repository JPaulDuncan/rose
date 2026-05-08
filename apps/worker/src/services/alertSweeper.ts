import mongoose from 'mongoose';
import { Queue } from 'bullmq';
import { AlertRule, type AlertRuleDoc } from '@rose/db';
import { bullConnection } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { pushToUser } from '../processors/pushNotify.js';

/**
 * Operator-facing alert sweeper (Phase D follow-on). Runs every 60s
 * in worker-bg mode. Reads the same primitives the diagnostics
 * dashboard surfaces (BullMQ queue counts, Mongo system.profile)
 * and fires a push notification for every enabled AlertRule whose
 * threshold is currently crossed AND whose cooldown has elapsed.
 *
 * Lives outside the BullMQ queue topology because there's no per-
 * job payload — it's just a periodic poll. Co-located with bg in
 * the WORKER_MODE split since the metrics + slow-query data is
 * cheap to read but the push fan-out belongs alongside the rest of
 * the user-notification machinery.
 *
 * Three rule kinds:
 *
 *   queue-failed   — `value` = max queue.failed across (or at)
 *                     queueName. Fires when value >= threshold.
 *   queue-backlog  — `value` = max queue.waiting. Fires similarly.
 *   collscan       — `value` = count of COLLSCAN entries in
 *                     system.profile in the last sweep window.
 *                     Fires when value >= threshold.
 *
 * Cooldown is per-rule: lastFiredAt + cooldownMin minutes >= now
 * suppresses the next fire. Recovery (value back below threshold)
 * does NOT fire a "resolved" notification — that's deliberate, since
 * push-spam from oscillating thresholds is worse than the operator
 * checking the dashboard themselves.
 */

/** How far back the collscan sweep looks each tick. Should be ≥ the
 *  sweep cadence so we don't miss entries between ticks. */
const COLLSCAN_LOOKBACK_MS = 90 * 1000;

const SWEEP_INTERVAL_MS = 60 * 1000;

/** Cache of Queue handles so the sweep doesn't re-construct them
 *  every tick. Keys are queue names (e.g. 'rose.imap-sync'). */
const queueHandles = new Map<string, Queue>();

function queueFor(name: string): Queue {
  let q = queueHandles.get(name);
  if (!q) {
    q = new Queue(name, { connection: bullConnection() });
    queueHandles.set(name, q);
  }
  return q;
}

async function snapshotQueueCounts(
  names: Set<string>,
): Promise<Record<string, { waiting: number; failed: number }>> {
  const out: Record<string, { waiting: number; failed: number }> = {};
  await Promise.all(
    [...names].map(async (n) => {
      try {
        const c = await queueFor(n).getJobCounts('waiting', 'failed');
        out[n] = {
          waiting: Number(c.waiting ?? 0),
          failed: Number(c.failed ?? 0),
        };
      } catch (err) {
        logger.debug(
          { err: (err as Error).message, queue: n },
          'alert-sweep: queue count failed',
        );
        out[n] = { waiting: 0, failed: 0 };
      }
    }),
  );
  return out;
}

async function snapshotCollscanCount(sinceMs: number): Promise<number> {
  if (!mongoose.connection.db) return 0;
  try {
    const since = new Date(Date.now() - sinceMs);
    const count = await mongoose.connection.db
      .collection('system.profile')
      .countDocuments({
        ts: { $gte: since },
        planSummary: 'COLLSCAN',
      });
    return count;
  } catch (err) {
    logger.debug(
      { err: (err as Error).message },
      'alert-sweep: collscan count failed',
    );
    return 0;
  }
}

function shouldFire(rule: AlertRuleDoc, now: Date): boolean {
  const last = rule.lastFiredAt as Date | null | undefined;
  if (!last) return true;
  const elapsedMin = (now.getTime() - new Date(last).getTime()) / 60_000;
  return elapsedMin >= (rule.cooldownMin ?? 60);
}

function describeRule(kind: AlertRuleDoc['kind'], value: number, queueName: string): string {
  if (kind === 'queue-failed') {
    return `Queue ${queueName || '(any)'}: ${value} failed`;
  }
  if (kind === 'queue-backlog') {
    return `Queue ${queueName || '(any)'}: ${value} waiting`;
  }
  if (kind === 'collscan') {
    return `MongoDB: ${value} collection-scan${value === 1 ? '' : 's'} in last ${COLLSCAN_LOOKBACK_MS / 1000}s`;
  }
  return `Alert: value ${value}`;
}

async function evaluateOnce(): Promise<{ checked: number; fired: number }> {
  const now = new Date();
  const rules = (await AlertRule.find({ enabled: true }).lean()) as AlertRuleDoc[];
  if (rules.length === 0) return { checked: 0, fired: 0 };

  // Pre-compute the union of queue names we need across all
  // queue-* rules so we make N queue.getJobCounts calls per
  // tick rather than rule-count calls.
  const watchedQueues = new Set<string>();
  let needsCollscan = false;
  for (const r of rules) {
    if ((r.kind === 'queue-failed' || r.kind === 'queue-backlog') && r.queueName) {
      watchedQueues.add(r.queueName);
    } else if (r.kind === 'queue-failed' || r.kind === 'queue-backlog') {
      // No filter set — fan out across every known queue. Worker
      // process knows the BullMQ queue names; the API's queues.ts
      // is the canonical source but the sweeper imports the
      // rose.<*> prefix shape so we just snapshot the set we have
      // locally.
      for (const q of [
        'rose.parse-email',
        'rose.generate-page',
        'rose.embed-page',
        'rose.imap-sync',
        'rose.gmail-sync',
        'rose.rss-sync',
        'rose.website-sync',
        'rose.summarize-sender',
        'rose.fetch-and-parse',
        'rose.send-outbound',
        'rose.digest-email',
        'rose.webhook-deliver',
        'rose.briefing',
        'rose.slack-sync',
        'rose.discord-sync',
        'rose.gcal-sync',
        'rose.daydream',
        'rose.library-sync',
        'rose.library-embed',
        'rose.tag-digest',
        'rose.post-write-hooks',
        'rose.recipes',
        'rose.topic-research',
      ]) {
        watchedQueues.add(q);
      }
    } else if (r.kind === 'collscan') {
      needsCollscan = true;
    }
  }
  const [counts, collscanCount] = await Promise.all([
    snapshotQueueCounts(watchedQueues),
    needsCollscan ? snapshotCollscanCount(COLLSCAN_LOOKBACK_MS) : Promise.resolve(0),
  ]);

  let fired = 0;
  for (const rule of rules) {
    let value = 0;
    if (rule.kind === 'queue-failed') {
      if (rule.queueName) {
        value = counts[rule.queueName]?.failed ?? 0;
      } else {
        for (const c of Object.values(counts)) value = Math.max(value, c.failed);
      }
    } else if (rule.kind === 'queue-backlog') {
      if (rule.queueName) {
        value = counts[rule.queueName]?.waiting ?? 0;
      } else {
        for (const c of Object.values(counts)) value = Math.max(value, c.waiting);
      }
    } else if (rule.kind === 'collscan') {
      value = collscanCount;
    }

    // Always update lastEvaluatedAt + lastValue so the UI can show
    // current state regardless of fire status.
    await AlertRule.updateOne(
      { _id: rule._id },
      { $set: { lastEvaluatedAt: now, lastValue: value } },
    );

    if (value < (rule.threshold ?? 1)) continue;
    if (!shouldFire(rule, now)) continue;

    try {
      const title = rule.name?.trim() || 'Rose alert';
      const body = describeRule(rule.kind, value, rule.queueName ?? '');
      await pushToUser(rule.userId, {
        title,
        body,
        url: '/settings/diagnostics',
      });
      await AlertRule.updateOne(
        { _id: rule._id },
        { $set: { lastFiredAt: now } },
      );
      fired += 1;
      logger.info(
        {
          ruleId: String(rule._id),
          kind: rule.kind,
          value,
          threshold: rule.threshold,
        },
        'alert-sweep: fired',
      );
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, ruleId: String(rule._id) },
        'alert-sweep: push failed (continuing)',
      );
    }
  }
  return { checked: rules.length, fired };
}

/**
 * Start the periodic alert sweeper. Returns the timer handle so
 * tests can clear it; in the bootstrap path we let it run
 * unref'd so it doesn't block worker shutdown.
 */
export function startAlertSweeper(): NodeJS.Timeout {
  const tick = async () => {
    try {
      const r = await evaluateOnce();
      if (r.fired > 0) {
        logger.info(r, 'alert-sweep: tick');
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'alert-sweep: tick failed');
    }
  };
  // First tick after a small delay so we don't race with worker
  // boot when the queues are still being constructed.
  setTimeout(() => void tick(), 5_000).unref();
  const interval = setInterval(() => void tick(), SWEEP_INTERVAL_MS);
  interval.unref();
  return interval;
}
