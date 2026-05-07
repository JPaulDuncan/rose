/**
 * Map a content date (email received, RSS pubDate, web-page fetched-at)
 * to a BullMQ job priority. BullMQ uses **lower numbers = higher
 * priority**, so newer items produce smaller values and hop the
 * queue in front of older backfill items.
 *
 * Goals:
 * - "Today" beats "yesterday" beats "last week" beats "last month".
 * - Slope is steepest for the recent past (minute-level granularity)
 *   so a flood of 3-day-old backfill emails can't starve out a fresh
 *   message that just arrived.
 * - Stable bounded range so BullMQ's internal priority sort stays
 *   cheap.
 *
 * Curve (rough):
 *   minutes(0..120)  → priority  0..120        (1 per minute)
 *   hours (2..48)    → priority  120..1320     (~25 per hour)
 *   days  (2..30)    → priority  1320..15000   (~485 per day)
 *   older than 30d   → priority  15000..1_000_000 (clamped)
 *
 * Missing or future-dated values are treated as "right now" — better
 * to err on the side of fresh.
 */
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const BULLMQ_MAX_PRIORITY = 1_000_000;

export function priorityForDate(date: Date | string | null | undefined): number {
  if (!date) return 1;
  const t = typeof date === 'string' ? Date.parse(date) : date.getTime();
  if (!Number.isFinite(t)) return 1;

  const now = Date.now();
  const ageMs = now - t;
  if (ageMs <= 0) return 1;

  if (ageMs < 2 * HOUR) {
    return Math.max(1, Math.floor(ageMs / MINUTE));
  }
  if (ageMs < 2 * DAY) {
    const hoursOver = (ageMs - 2 * HOUR) / HOUR;
    return Math.floor(120 + hoursOver * 25);
  }
  if (ageMs < 30 * DAY) {
    const daysOver = (ageMs - 2 * DAY) / DAY;
    return Math.floor(1320 + daysOver * 485);
  }
  const daysOver = Math.min(3650, (ageMs - 30 * DAY) / DAY);
  return Math.min(BULLMQ_MAX_PRIORITY, Math.floor(15000 + daysOver * 270));
}
