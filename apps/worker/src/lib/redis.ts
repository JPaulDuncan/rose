import { Redis, type RedisOptions } from 'ioredis';
import { env } from './env.js';

/**
 * Shared ioredis client for ad-hoc commands (caches, rate limits,
 * pub/sub-style work). Safe to share across non-blocking call sites.
 * Don't pass it directly to a BullMQ `Worker`'s `connection` field —
 * Workers issue blocking commands (BLPOP, BLMOVE) and BullMQ wants
 * its own connection it can manage independently. Use
 * `bullConnection()` for that.
 *
 * `lazyConnect: true` defers the actual TCP connect until the first
 * command. This is operationally a no-op in production (the worker
 * issues commands in the first second of boot) but saves a chunk
 * of test noise: under vitest the module graph imports redis.ts
 * transitively (e.g. via metrics → redis), and without lazy connect
 * the constructor immediately tries to resolve the `redis` hostname
 * and emits an "ENOTFOUND" warning to stderr. Lazy avoids that
 * because tests never issue commands.
 */
export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  lazyConnect: true,
});

// Kick the connect off in non-test runtimes so first-command latency
// isn't tied to TCP+auth. Tests skip this and never connect.
if (process.env.NODE_ENV !== 'test' && process.env.VITEST !== 'true') {
  void redis.connect().catch(() => {
    // ioredis retries internally; the failure surfaces on first
    // command via maxRetriesPerRequest semantics. Swallowing here
    // just keeps the boot sequence quiet.
  });
}

/**
 * Connection factory for BullMQ. Returning `RedisOptions` (not a
 * pre-built client) lets BullMQ create + own a fresh ioredis instance
 * per Worker / Queue, which is the BullMQ-recommended pattern. The
 * library guards against the foot-gun where one shared client is
 * blocked on BLPOP while another caller tries to issue a regular
 * command on the same socket.
 *
 * `maxRetriesPerRequest: null` is a BullMQ requirement: it relies on
 * commands queueing during reconnects rather than hard-failing.
 */
export function bullConnection(): RedisOptions {
  // Parse the URL once and hand BullMQ structured options. Falls
  // back to the URL string itself for ioredis to handle if parsing
  // fails (unusual schemes, custom ACLs).
  try {
    const u = new URL(env.REDIS_URL);
    const opts: RedisOptions = {
      host: u.hostname,
      port: u.port ? Number(u.port) : 6379,
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    };
    if (u.password) opts.password = decodeURIComponent(u.password);
    if (u.username) opts.username = decodeURIComponent(u.username);
    if (u.pathname && u.pathname.length > 1) {
      const db = Number(u.pathname.slice(1));
      if (Number.isFinite(db)) opts.db = db;
    }
    return opts;
  } catch {
    return {
      host: 'redis',
      port: 6379,
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    };
  }
}
