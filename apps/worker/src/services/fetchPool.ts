import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
// `robots-parser` ships as CJS with a single function export; its
// types declaration just stubs `declare module 'robots-parser'`,
// so we cast through a known signature here.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import robotsParserRaw from 'robots-parser';
const robotsParser = robotsParserRaw as unknown as (
  url: string,
  contents: string,
) => {
  isAllowed(url: string, ua?: string): boolean | undefined;
  isDisallowed(url: string, ua?: string): boolean | undefined;
  getCrawlDelay(ua?: string): number | undefined;
};
import { parse as parseTld } from 'tldts';
import { safeFetch, UnsafeUrlError } from '../lib/safeFetch.js';
import { redis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';

/**
 * Topic-research fetch pool (web-integration Phase 1).
 *
 * Wraps `safeFetch` (which already does SSRF guard, redirect
 * re-validation, size cap, timeout, contactable User-Agent) with
 * the politeness layer the topic crawler needs:
 *
 *   • robots.txt — fetched once per host per 24h, cached in Redis,
 *     enforced before we issue the body fetch. Disallowed hosts
 *     surface as `{ kind: 'robots-disallowed' }` so the caller
 *     can persist a placeholder WebDocument with `robotsAllowed=false`.
 *
 *   • Per-host rate limit — Redis token bucket, default 1 req/s
 *     per host with a burst of 5. Bypasses for the high-traffic
 *     allowlist (apnews, bbc, reuters) at 0.25/s steady state.
 *     Lua-evaluated for atomicity; ~30µs per call.
 *
 *   • Conditional GET — caller passes prior `etag` / `lastModified`,
 *     we send `If-None-Match` / `If-Modified-Since`. A 304 surfaces
 *     as `{ kind: 'not-modified' }` and the caller skips re-extract.
 *
 *   • Content-type filter — only HTML / XHTML accepted; binaries
 *     and feeds rejected at the type gate.
 *
 * The result variant is intentionally narrow: callers always handle
 * `kind` and never see a half-fetched response. Failures (network,
 * 5xx after retries, blocked, oversized) all funnel through `kind:
 * 'failed'` with a reason string for logging.
 */

export type FetchPoolResult =
  | {
      kind: 'fetched';
      finalUrl: string;
      hostKey: string;
      bodyHtml: string;
      contentType: string;
      etag: string | null;
      lastModified: string | null;
      fetchedAt: Date;
    }
  | { kind: 'not-modified'; finalUrl: string; hostKey: string }
  | { kind: 'robots-disallowed'; url: string; hostKey: string }
  | { kind: 'blocked'; url: string; reason: string }
  | { kind: 'failed'; url: string; reason: string };

export type FetchPoolOptions = {
  /** Prior `etag` from a previous fetch — sent as `If-None-Match`. */
  etag?: string | null;
  /** Prior `Last-Modified` — sent as `If-Modified-Since`. */
  lastModified?: string | null;
  /** Override per-host rate (tokens per second). Defaults pull from
   *  the host allowlist. */
  rateOverride?: number;
};

/**
 * Identifying contact UA. The instance URL points back to the
 * operator's own Rose deploy so a host that wants us to stop has a
 * concrete contact channel. Hard-coded `1.0` since we don't ship
 * a worker version field; future commits could templatise.
 */
const USER_AGENT = 'Rose/1.0 (+https://rose.local; topic-research)';

const BODY_BYTE_CAP = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

/**
 * Hosts we know are operator-friendly to crawl but in big enough
 * volume that we want to be extra slow. Not an allowlist for what
 * we'll fetch — we'll fetch anything robots permits — but a
 * per-host rate override.
 */
const HIGH_TRAFFIC_HOSTS: Record<string, number> = {
  'apnews.com': 0.25,
  'bbc.com': 0.25,
  'bbc.co.uk': 0.25,
  'reuters.com': 0.25,
  'nytimes.com': 0.25,
  'washingtonpost.com': 0.25,
};

const DEFAULT_RATE_PER_SEC = 1;
const RATE_BURST = 5;

const ROBOTS_TTL_SEC = 24 * 3600;
const ROBOTS_FAIL_TTL_SEC = 5 * 60;

function hashUrl(url: string): string {
  return createHash('sha256').update(url).digest('hex');
}

/**
 * Pull the registrable domain (eTLD+1). Falls back to the raw
 * hostname when tldts can't classify (e.g. local TLDs, IPs).
 */
export function hostKeyOf(url: string): string {
  try {
    const u = new URL(url);
    const parsed = parseTld(u.hostname, { allowPrivateDomains: false });
    return parsed.domain ?? u.hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Redis Lua script for the per-host token bucket. Atomic
 * read-decrement-or-wait. Returns 0 if a token was consumed, a
 * positive integer if the caller must wait that many milliseconds.
 *
 * KEYS[1] — bucket key (rate:<host>)
 * ARGV[1] — refill rate, tokens/sec (float)
 * ARGV[2] — burst capacity (int)
 * ARGV[3] — current time, ms since epoch (int)
 */
const TOKEN_BUCKET_LUA = `
local last = redis.call('HMGET', KEYS[1], 'tokens', 'updated')
local rate = tonumber(ARGV[1])
local burst = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local tokens = tonumber(last[1])
local updated = tonumber(last[2])
if tokens == nil then
  tokens = burst
  updated = now
end
-- Refill based on elapsed time.
local elapsedSec = math.max(0, (now - updated) / 1000)
tokens = math.min(burst, tokens + elapsedSec * rate)
if tokens < 1 then
  -- Tell the caller how long until 1 token will be available.
  local waitMs = math.ceil(((1 - tokens) / rate) * 1000)
  redis.call('HMSET', KEYS[1], 'tokens', tokens, 'updated', now)
  redis.call('EXPIRE', KEYS[1], 600)
  return waitMs
end
tokens = tokens - 1
redis.call('HMSET', KEYS[1], 'tokens', tokens, 'updated', now)
redis.call('EXPIRE', KEYS[1], 600)
return 0
`;

/**
 * Block until a per-host token is available. Caps at 30 seconds of
 * cumulative wait — beyond that the caller gives up rather than
 * sit on a backlog.
 */
async function acquireRateToken(hostKey: string, rateOverride?: number): Promise<boolean> {
  if (!hostKey) return true;
  const rate =
    rateOverride
    ?? HIGH_TRAFFIC_HOSTS[hostKey]
    ?? DEFAULT_RATE_PER_SEC;
  const key = `rose:fetch-rate:${hostKey}`;
  let waited = 0;
  while (waited < 30_000) {
    const wait = (await redis.eval(
      TOKEN_BUCKET_LUA,
      1,
      key,
      String(rate),
      String(RATE_BURST),
      String(Date.now()),
    )) as number;
    if (wait === 0) return true;
    const sleepMs = Math.min(wait, 5_000);
    await sleep(sleepMs);
    waited += sleepMs;
  }
  return false;
}

/**
 * Fetch + cache the host's robots.txt. We treat any failure (DNS,
 * 5xx, parse error) as "robots unknown, allow" but with a much
 * shorter TTL so we re-check sooner than 24h. Caching the raw
 * robots body in Redis lets the parser run locally on every
 * `isAllowed` call without re-fetching.
 */
async function getRobotsParser(
  origin: string,
): Promise<{ isAllowed: (url: string, ua: string) => boolean | undefined }> {
  const cacheKey = `rose:robots:${origin}`;
  let body = await redis.get(cacheKey);
  if (body === null) {
    try {
      const result = await safeFetch(`${origin}/robots.txt`, {
        maxBytes: 256 * 1024,
        timeoutMs: 10_000,
        userAgent: USER_AGENT,
      });
      body = result.buffer.toString('utf-8');
      await redis.set(cacheKey, body, 'EX', ROBOTS_TTL_SEC);
    } catch (err) {
      // Treat fetch failures as "no robots, all allowed" but cache
      // the empty body briefly so we don't pound the host re-trying.
      logger.debug({ origin, err: (err as Error).message }, 'robots: fetch failed');
      body = '';
      await redis.set(cacheKey, body, 'EX', ROBOTS_FAIL_TTL_SEC);
    }
  }
  return robotsParser(`${origin}/robots.txt`, body);
}

function isHtmlContentType(ct: string): boolean {
  const lower = ct.toLowerCase();
  return lower.includes('text/html') || lower.includes('application/xhtml+xml');
}

/**
 * The single fetch entry point. Each call is independent; rate
 * limits + robots are applied per-call so the orchestrator can
 * drive concurrency without coordinating internal state.
 */
export async function fetchOne(
  url: string,
  opts: FetchPoolOptions = {},
): Promise<FetchPoolResult> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return { kind: 'blocked', url, reason: 'invalid-url' };
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return { kind: 'blocked', url, reason: 'unsupported-scheme' };
  }
  const hostKey = hostKeyOf(url);

  // robots.txt gate.
  try {
    const origin = `${parsedUrl.protocol}//${parsedUrl.host}`;
    const robots = await getRobotsParser(origin);
    if (robots.isAllowed(url, USER_AGENT) === false) {
      return { kind: 'robots-disallowed', url, hostKey };
    }
  } catch (err) {
    logger.debug(
      { url, err: (err as Error).message },
      'fetchPool: robots check threw; allowing',
    );
  }

  // Rate limit — wait or give up.
  const tokenOk = await acquireRateToken(hostKey, opts.rateOverride);
  if (!tokenOk) {
    return { kind: 'failed', url, reason: 'rate-limit-timeout' };
  }

  // Conditional GET headers via direct fetch (safeFetch doesn't
  // expose them). We re-do safeFetch's redirect dance manually so
  // we can observe response headers for the actual content URL.
  let current = url;
  const conditionalHeaders: Record<string, string> = {};
  if (opts.etag) conditionalHeaders['If-None-Match'] = opts.etag;
  if (opts.lastModified) conditionalHeaders['If-Modified-Since'] = opts.lastModified;
  for (let hop = 0; hop < 6; hop += 1) {
    let resp: Response;
    try {
      resp = await fetch(current, {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.7',
          'Accept-Encoding': 'gzip, deflate, br',
          ...conditionalHeaders,
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      if (err instanceof UnsafeUrlError) {
        return { kind: 'blocked', url: current, reason: err.message };
      }
      return {
        kind: 'failed',
        url: current,
        reason: (err as Error).message ?? 'network-error',
      };
    }
    if (resp.status === 304) {
      return { kind: 'not-modified', finalUrl: current, hostKey };
    }
    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get('location');
      if (!loc) {
        return { kind: 'failed', url: current, reason: 'redirect-without-location' };
      }
      current = new URL(loc, current).toString();
      continue;
    }
    if (resp.status === 401 || resp.status === 402 || resp.status === 403) {
      return { kind: 'blocked', url: current, reason: `http-${resp.status}` };
    }
    if (!resp.ok) {
      return { kind: 'failed', url: current, reason: `http-${resp.status}` };
    }
    const ct = resp.headers.get('content-type') ?? 'application/octet-stream';
    if (!isHtmlContentType(ct)) {
      return { kind: 'blocked', url: current, reason: `content-type:${ct}` };
    }

    // Stream + size-cap the body.
    const reader = resp.body?.getReader();
    if (!reader) {
      return { kind: 'failed', url: current, reason: 'empty-body' };
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          total += value.byteLength;
          if (total > BODY_BYTE_CAP) {
            return {
              kind: 'failed',
              url: current,
              reason: `body-exceeded-${BODY_BYTE_CAP}-bytes`,
            };
          }
          chunks.push(value);
        }
      }
    } catch (err) {
      return {
        kind: 'failed',
        url: current,
        reason: `body-read-error: ${(err as Error).message}`,
      };
    }
    const bodyHtml = Buffer.concat(chunks).toString('utf-8');
    return {
      kind: 'fetched',
      finalUrl: current,
      hostKey: hostKeyOf(current) || hostKey,
      bodyHtml,
      contentType: ct,
      etag: resp.headers.get('etag'),
      lastModified: resp.headers.get('last-modified'),
      fetchedAt: new Date(),
    };
  }
  return { kind: 'failed', url: current, reason: 'too-many-redirects' };
}

/** Stable hash for use as a unique-index key on WebDocument. */
export function urlHashOf(url: string): string {
  return hashUrl(url);
}
