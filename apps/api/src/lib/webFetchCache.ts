import type { WebFetchCache } from '@rose/llm';
import { redis } from './redis.js';

/**
 * Adapter that wraps the existing ioredis client into the
 * `WebFetchCache` shape webFetch expects. Sharing one Redis
 * instance with the rest of the API process keeps connections
 * bounded.
 */
export const webCache: WebFetchCache = {
  async get(key) {
    return redis.get(key);
  },
  async set(key, value, ttlSec) {
    await redis.set(key, value, 'EX', ttlSec);
  },
};
