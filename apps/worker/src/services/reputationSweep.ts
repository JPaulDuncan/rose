import { Sender } from '@rose/db';
import { logger } from '../lib/logger.js';

const MARK_DECAY_DAYS = 30;
const QUARANTINE_THRESHOLD = 3;
const SWEEP_INTERVAL_MS = 6 * 3600 * 1000; // every 6h

/**
 * Walk every Sender that's currently auto-quarantined (or that has
 * accumulated spam marks) and recompute the effective mark count
 * after time-based decay. Senders whose effective count has fallen
 * below the threshold get their `autoQuarantine` flag lifted so future
 * mail from them flows through to the digest again — without needing
 * the user to click "Trust sender".
 *
 * Runs on a coarse interval; reputation drift is gradual so an
 * eventual-consistency window of a few hours is fine.
 */
export async function reputationDecaySweep(): Promise<{ scanned: number; cleared: number }> {
  const cursor = Sender.find({
    $or: [
      { autoQuarantine: true },
      { spamMarkedCount: { $gt: 0 }, rescuedCount: { $gt: 0 } },
    ],
  }).cursor();
  let scanned = 0;
  let cleared = 0;
  for await (const sender of cursor) {
    scanned += 1;
    const raw = (sender.spamMarkedCount ?? 0) - (sender.rescuedCount ?? 0);
    if (raw <= 0) {
      if (sender.autoQuarantine) {
        sender.autoQuarantine = false;
        cleared += 1;
        await sender.save();
      }
      continue;
    }
    const last = sender.lastMarkedAt ? new Date(sender.lastMarkedAt) : null;
    const days = last
      ? Math.max(0, Math.floor((Date.now() - last.getTime()) / (24 * 3600 * 1000)))
      : 0;
    const decayed = Math.floor(days / MARK_DECAY_DAYS);
    const effective = Math.max(0, raw - decayed);
    const shouldQuarantine = effective >= QUARANTINE_THRESHOLD;
    if (sender.autoQuarantine !== shouldQuarantine) {
      sender.autoQuarantine = shouldQuarantine;
      if (!shouldQuarantine) cleared += 1;
      await sender.save();
    }
  }
  return { scanned, cleared };
}

export function startReputationDecaySweep(): NodeJS.Timeout {
  const tick = () => {
    reputationDecaySweep()
      .then(({ scanned, cleared }) => {
        if (scanned > 0) {
          logger.info({ scanned, cleared }, 'reputation-decay sweep');
        }
      })
      .catch((err) => logger.warn({ err }, 'reputation-decay sweep failed'));
  };
  // Run once on boot, then on the interval. unref so it doesn't keep
  // the process alive during tests.
  const timer = setInterval(tick, SWEEP_INTERVAL_MS);
  timer.unref?.();
  setTimeout(tick, 5_000).unref?.();
  return timer;
}
