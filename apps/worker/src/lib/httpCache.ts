import { createHash } from 'node:crypto';
import { redis } from './redis.js';
import { assertSafeHttpUrl } from './safeFetch.js';

const KEY_PREFIX = 'rose:daydream:http:';
const DEFAULT_TTL_SEC = 7 * 24 * 60 * 60; // 7 days

/**
 * Redis-backed wrapper around fetch with SSRF guard + body cache.
 * Daydream adapters route through this so:
 *   - the same Wikipedia article fetched for many pages within a week
 *     is one upstream call,
 *   - every external URL is validated through assertSafeHttpUrl before
 *     fetch (no internal IPs, no file://, no exotic schemes),
 *   - cached responses serialise body + content-type + status, so
 *     Response.json() / .text() still works as expected.
 *
 * Only GETs that respond 200 are cached. Anything else is passed
 * through and not memoised so a transient 5xx doesn't poison the
 * adapter for the next 7 days.
 */
export async function cachedFetch(
  url: string,
  init: RequestInit & { cacheTtlSec?: number } = {},
): Promise<Response> {
  await assertSafeHttpUrl(url);
  const method = (init.method ?? 'GET').toUpperCase();
  const ttl = init.cacheTtlSec ?? DEFAULT_TTL_SEC;
  // Cache key includes accept header and any caller-controlled bits
  // that affect the response shape.
  const accept =
    typeof init.headers === 'object' && init.headers
      ? ((init.headers as Record<string, string>)['accept'] ?? '')
      : '';
  const key =
    KEY_PREFIX +
    createHash('sha256').update(`${method}\0${url}\0${accept}`).digest('hex');

  if (method === 'GET') {
    const cached = await redis.get(key);
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as {
          status: number;
          contentType: string;
          body: string;
        };
        return new Response(parsed.body, {
          status: parsed.status,
          headers: { 'content-type': parsed.contentType },
        });
      } catch {
        // Stale/corrupt entry — fall through to a real fetch.
      }
    }
  }

  const res = await fetch(url, init);
  if (method === 'GET' && res.ok) {
    const contentType = res.headers.get('content-type') ?? 'text/plain';
    const body = await res.text();
    await redis.set(
      key,
      JSON.stringify({ status: res.status, contentType, body }),
      'EX',
      ttl,
    );
    return new Response(body, {
      status: res.status,
      headers: { 'content-type': contentType },
    });
  }
  return res;
}
