import { createHash } from 'node:crypto';
import type { ZodType } from 'zod';
import { assertSafeHttpUrl } from './safeUrl.js';

/**
 * Canonical fetch tool used by every server-side feature that reaches
 * external HTTP. Centralising it means SSRF rules, User-Agent, and
 * timeout policy can't drift between the API, the worker, and future
 * features (and means the LLM is *never* the source of factual data:
 * external content always comes from this tool, not from the model).
 *
 * Cache backend is pluggable so consumers in different processes
 * (api, worker) can pass their own Redis client without webFetch
 * pulling in ioredis as a dependency.
 */

const DEFAULT_USER_AGENT = 'Rose/1.0 (+https://rose.local)';
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_CACHE_TTL_SEC = 60 * 60 * 24 * 7; // 7 days

export interface WebFetchCache {
  /** Returns the cached body string (JSON-encoded envelope) or null. */
  get(key: string): Promise<string | null>;
  /** Caller is responsible for serialising the envelope. TTL in seconds. */
  set(key: string, value: string, ttlSec: number): Promise<void>;
}

export type WebFetchOptions = {
  /** HTTP method. Only GET is cached; non-GET passes through. */
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Per-call timeout. Defaults to 8s. */
  timeoutMs?: number;
  /** Override the User-Agent. Default: Rose/1.0 (+https://rose.local). */
  userAgent?: string;
  /** Pass a cache to memoise GETs. Omit to disable caching. */
  cache?: WebFetchCache;
  /** Cache TTL when `cache` is provided. Default 7 days. */
  cacheTtlSec?: number;
  /** Pre-bound caller name for log/cache key namespacing
   *  (e.g. "weather.noaa", "daydream.wikipedia"). */
  caller?: string;
  /** AbortSignal threaded into the underlying fetch — caller can cancel. */
  signal?: AbortSignal;
};

export type WebFetchResult = {
  ok: boolean;
  status: number;
  /** Always lowercased; falls back to 'application/octet-stream'. */
  contentType: string;
  /** Body as text. Use webFetchJson for parsed/validated JSON. */
  body: string;
  /** True when the result came out of the cache. */
  cached: boolean;
};

function envelopeKey(method: string, url: string, accept: string, caller: string): string {
  return (
    'rose:webfetch:' +
    createHash('sha256')
      .update(`${caller}\0${method}\0${url}\0${accept}`)
      .digest('hex')
  );
}

/**
 * Safe HTTP fetch with SSRF guard, standard UA, timeout, and optional
 * shared cache. Throws on guard violations (UnsafeUrlError) so callers
 * see misconfiguration; network/HTTP failures are returned as
 * `{ ok: false, status, body }` so callers can degrade gracefully.
 */
export async function webFetch(
  url: string,
  opts: WebFetchOptions = {},
): Promise<WebFetchResult> {
  await assertSafeHttpUrl(url);
  const method = (opts.method ?? 'GET').toUpperCase();
  const headers: Record<string, string> = {
    'user-agent': opts.userAgent ?? DEFAULT_USER_AGENT,
    accept: 'application/json, text/plain, */*',
    ...(opts.headers ?? {}),
  };
  // Normalise accept for the cache key so different code paths with
  // different accept values get distinct cache slots.
  const accept = (headers.accept ?? headers.Accept ?? '*/*').toLowerCase();
  const caller = opts.caller ?? 'webfetch';

  // Cache lookup — GET only. Anything else passes straight through.
  if (method === 'GET' && opts.cache) {
    const key = envelopeKey(method, url, accept, caller);
    try {
      const hit = await opts.cache.get(key);
      if (hit) {
        try {
          const parsed = JSON.parse(hit) as {
            status: number;
            contentType: string;
            body: string;
          };
          return {
            ok: parsed.status >= 200 && parsed.status < 300,
            status: parsed.status,
            contentType: parsed.contentType,
            body: parsed.body,
            cached: true,
          };
        } catch {
          // Corrupted cache entry — fall through to a real fetch.
        }
      }
    } catch {
      // Cache read errors must not block the network path.
    }
  }

  // Run the real fetch with a timeout, threading the caller's signal.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort();
    else opts.signal.addEventListener('abort', onAbort);
  }
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: opts.body,
      signal: ctrl.signal,
    });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      contentType: 'application/octet-stream',
      body: (err as Error).message ?? 'network error',
      cached: false,
    };
  } finally {
    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
  }
  const contentType = (res.headers.get('content-type') ?? 'application/octet-stream')
    .toLowerCase();
  const body = await res.text().catch(() => '');
  const result: WebFetchResult = {
    ok: res.ok,
    status: res.status,
    contentType,
    body,
    cached: false,
  };
  if (method === 'GET' && opts.cache && res.ok) {
    try {
      const key = envelopeKey(method, url, accept, caller);
      await opts.cache.set(
        key,
        JSON.stringify({ status: res.status, contentType, body }),
        opts.cacheTtlSec ?? DEFAULT_CACHE_TTL_SEC,
      );
    } catch {
      // Cache write errors must not block the response.
    }
  }
  return result;
}

/**
 * webFetch + JSON.parse + optional Zod validation. The schema gate
 * means a hijacked endpoint or unexpected response shape becomes a
 * typed parse error rather than a downstream `TypeError: undefined`.
 *
 * Returns `null` when the fetch fails, the body isn't JSON, or the
 * schema rejects. Throws only for unsafe URLs.
 */
export async function webFetchJson<T>(
  url: string,
  opts: WebFetchOptions & { schema?: ZodType<T> } = {},
): Promise<T | null> {
  const r = await webFetch(url, {
    ...opts,
    headers: { accept: 'application/json', ...(opts.headers ?? {}) },
  });
  if (!r.ok) return null;
  let json: unknown;
  try {
    json = JSON.parse(r.body);
  } catch {
    return null;
  }
  if (!opts.schema) return json as T;
  const parsed = opts.schema.safeParse(json);
  return parsed.success ? parsed.data : null;
}
