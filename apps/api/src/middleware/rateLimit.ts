import rateLimit, { type Options } from 'express-rate-limit';
import { RedisStore, type RedisReply } from 'rate-limit-redis';
import { redis } from '../lib/redis.js';

/**
 * Plan 12 (G7) — Redis-backed rate-limit store. Replaces the
 * in-memory default so counts survive multi-process deployments and
 * a horizontally-scaled API stays under one quota.
 *
 * The `sendCommand` shim adapts ioredis to the rate-limit-redis
 * interface (which expects a node-redis-compatible `sendCommand`
 * method that returns the typed reply union).
 */
function makeStore(prefix: string) {
  return new RedisStore({
    prefix,
    sendCommand: ((...args: string[]) =>
      // ioredis returns Buffer | string | number | etc.; the
      // adapter is happy with anything in the typed union.
      redis.call(args[0]!, ...args.slice(1)) as Promise<RedisReply>),
  });
}

const baseOpts = (extra: Partial<Options>): Partial<Options> => ({
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // Don't rate-limit by client IP when behind a load balancer that
  // doesn't set X-Forwarded-For — `express-rate-limit` uses
  // `req.ip` by default which already respects `trust proxy`. The
  // app sets `app.set('trust proxy', 1)` in index.ts.
  ...extra,
});

export const authLimiter = rateLimit({
  ...baseOpts({ windowMs: 15 * 60 * 1000, limit: 30 }),
  store: makeStore('rl:auth:'),
});

export const apiLimiter = rateLimit({
  ...baseOpts({ windowMs: 60 * 1000, limit: 240 }),
  store: makeStore('rl:api:'),
});

export const webhookLimiter = rateLimit({
  ...baseOpts({ windowMs: 60 * 1000, limit: 60 }),
  store: makeStore('rl:webhook:'),
});

/**
 * Tighter limit for endpoints that fan out an LLM call per request
 * (Daydream Now, force regenerate, etc.). 5 per minute per IP +
 * user. Replaces the per-route in-memory `Map` ad-hoc limiters
 * sprinkled around `routes/pages.ts` and `routes/entities.ts`.
 */
export const llmForceLimiter = rateLimit({
  ...baseOpts({ windowMs: 60 * 1000, limit: 5 }),
  store: makeStore('rl:llm-force:'),
});
