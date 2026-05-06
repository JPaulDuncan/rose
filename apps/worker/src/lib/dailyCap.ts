import { redis } from './redis.js';
import { logger } from './logger.js';

/**
 * Per-user / per-day call counter, Redis-backed so multiple worker
 * processes share the same quota. Plan 13 (D6) folded two
 * independent in-process `Map<userId, …>` counters in
 * `apps/worker/src/processors/daydream.ts` and
 * `apps/worker/src/services/describeImages.ts` into this helper —
 * the previous setup leaked `cap × workers` calls per day on a
 * horizontally-scaled deployment.
 *
 * `kind` namespaces the counter so daydream's daily cap and the
 * vision-describe daily cap stay independent; pass a stable string
 * per call site.
 *
 * Failure mode: any Redis error fails OPEN (returns true). The cost
 * of a missed cap on a transient hiccup is one extra LLM call;
 * the cost of failing closed would be silent feature outage.
 */
const TTL_SEC = 36 * 60 * 60; // 36 h — generous enough that key ages out cleanly the day after

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function redisKey(userId: string, kind: string, day: string): string {
  return `rose:dailycap:${kind}:${userId}:${day}`;
}

export async function bumpAndCheckCap(
  userId: string,
  kind: string,
  cap: number,
): Promise<boolean> {
  if (!Number.isFinite(cap) || cap <= 0) return true;
  const day = todayKey();
  const key = redisKey(userId, kind, day);
  try {
    const next = await redis.incr(key);
    if (next === 1) await redis.expire(key, TTL_SEC);
    if (next > cap) {
      // Decrement back so a future tick that races after a cap
      // hike doesn't have an inflated counter. Best-effort.
      await redis.decr(key);
      return false;
    }
    return true;
  } catch (err) {
    logger.warn(
      { err, userId, kind },
      'dailyCap: redis error, failing open',
    );
    return true;
  }
}
