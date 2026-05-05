import type { WebFetchCache } from '@rose/llm';
import { redis } from './redis.js';

/** ioredis-backed adapter for webFetch's pluggable cache. */
export const webCache: WebFetchCache = {
  async get(key) {
    return redis.get(key);
  },
  async set(key, value, ttlSec) {
    await redis.set(key, value, 'EX', ttlSec);
  },
};
