import { assertSafeHttpUrl, UnsafeUrlError } from './safeUrl.js';
import { browserHeadersFor, pickBrowserProfile } from './browserHeaders.js';
import { discoverFeed } from './feedDiscovery.js';

/**
 * Front-door HTML fetch for "watch a website" sources. Wraps the raw
 * network call in a four-step fallback chain designed around the
 * specific failure modes we see in the wild — most "this source
 * stopped working" reports trace to one of these:
 *
 *   1. **Direct fetch with browser-shaped headers.** Hash-of-host
 *      picks a stable profile from the BROWSER_POOL so the same
 *      site always sees the same UA across reschedules. Steady
 *      state — clears the cheapest WAF rules (UA blocklists,
 *      missing Accept-Language, missing Sec-Fetch-*).
 *
 *   2. **UA rotation.** On 401/403/429/451 from step 1, retry once
 *      with a different profile. Buys us through hosts that block a
 *      *specific* browser (e.g. "deny Firefox") rather than all
 *      bots.
 *
 *   3. **Feed discovery.** When step 2 also fails, look for an
 *      RSS/Atom feed: `<link rel="alternate">` autodiscovery if we
 *      grabbed any HTML, then probe well-known paths against the
 *      origin. Sites that aggressively block bot HTML almost always
 *      leave their feed endpoint open — different infra, different
 *      rate limits. Returns a `feed` outcome so the caller can flip
 *      the source over to the RSS pipeline for this and future
 *      syncs.
 *
 *   4. **Wayback Machine.** Last resort — query the availability
 *      API for the closest snapshot, fetch the archived HTML.
 *      Stale-by-hours-to-days but unblockable; returns a `wayback`
 *      outcome so the UI can warn the user that the content is from
 *      an archive.
 *
 * Conditional GET (`If-None-Match` / `If-Modified-Since`) is honored
 * on the direct path; a 304 short-circuits the rest of the chain.
 * Wayback obviously can't honor cache validators.
 */

export type ConditionalCache = {
  etag: string | null;
  lastModified: string | null;
};

export type ResilientFetchOptions = {
  cache?: ConditionalCache;
  /** 5MB default — same as safeFetch. */
  maxBytes?: number;
  /** 15s per attempt; the chain may take ~60s end-to-end with all retries. */
  timeoutMs?: number;
  /**
   * Skip steps the caller knows are pointless. Default: try everything.
   */
  enableUaRotate?: boolean;
  enableFeedFallback?: boolean;
  enableWaybackFallback?: boolean;
};

export type ResilientFetchOutcome =
  | { kind: 'unchanged' }
  | {
      kind: 'html';
      via: 'direct' | 'rotated-ua' | 'wayback';
      finalUrl: string;
      bodyHtml: string;
      etag: string | null;
      lastModified: string | null;
      profileName: string;
    }
  | {
      kind: 'feed';
      via: 'feed-fallback';
      feedUrl: string;
      discoveredVia: 'autodiscovery' | 'well-known';
    };

const RETRY_STATUSES = new Set([401, 403, 429, 451]);

/** True if the body looks like a Cloudflare/Imperva interstitial. */
function isChallengeBody(html: string): boolean {
  if (html.length > 50_000) return false; // real pages don't fit the shape
  const head = html.slice(0, 4096).toLowerCase();
  return (
    head.includes('just a moment') ||
    head.includes('checking your browser') ||
    head.includes('cf-browser-verification') ||
    head.includes('cf-challenge') ||
    head.includes('attention required') ||
    head.includes('please enable cookies and javascript')
  );
}

type DirectAttempt =
  | {
      kind: 'ok';
      finalUrl: string;
      bodyHtml: string;
      etag: string | null;
      lastModified: string | null;
      profileName: string;
    }
  | { kind: 'unchanged' }
  | { kind: 'blocked'; status: number; bodyForDiscovery: string | null }
  | { kind: 'blocked-challenge'; bodyForDiscovery: string };

async function attemptDirect(
  rawUrl: string,
  cache: ConditionalCache,
  attempt: number,
  maxBytes: number,
  timeoutMs: number,
): Promise<DirectAttempt> {
  const profile = pickBrowserProfile(
    (() => {
      try {
        return new URL(rawUrl).hostname.toLowerCase();
      } catch {
        return rawUrl;
      }
    })(),
    attempt,
  );
  let current = rawUrl;
  for (let hop = 0; hop < 6; hop += 1) {
    await assertSafeHttpUrl(current);
    const headers = { ...browserHeadersFor(current, attempt) };
    if (cache.etag) headers['If-None-Match'] = cache.etag;
    if (cache.lastModified) headers['If-Modified-Since'] = cache.lastModified;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(current, { headers, redirect: 'manual', signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 304) return { kind: 'unchanged' };
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new UnsafeUrlError('Redirect without Location header');
      current = new URL(loc, current).toString();
      continue;
    }
    if (RETRY_STATUSES.has(res.status)) {
      // Some WAFs return their interstitial in the 403 body — keep
      // it for feed-link sniffing in step 3.
      const body = await res.text().catch(() => '');
      return { kind: 'blocked', status: res.status, bodyForDiscovery: body || null };
    }
    if (!res.ok) {
      // Other 4xx/5xx — surface the original error rather than
      // falling through, so the user sees an honest message
      // (404 = wrong URL, 500 = upstream broken).
      throw new Error(`Upstream responded ${res.status} ${res.statusText}`);
    }
    const ct = (res.headers.get('content-type') ?? '').toLowerCase();
    if (!ct.includes('text/html') && !ct.includes('application/xhtml+xml')) {
      throw new Error(`Unsupported content-type: ${ct || 'unknown'}`);
    }
    const reader = res.body?.getReader();
    if (!reader) throw new Error('Empty response body');
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          ctrl.abort();
          throw new Error(`Body exceeded ${maxBytes} byte cap`);
        }
        chunks.push(value);
      }
    }
    const bodyHtml = Buffer.concat(chunks).toString('utf-8');
    if (isChallengeBody(bodyHtml)) {
      return { kind: 'blocked-challenge', bodyForDiscovery: bodyHtml };
    }
    return {
      kind: 'ok',
      finalUrl: current,
      bodyHtml,
      etag: res.headers.get('etag'),
      lastModified: res.headers.get('last-modified'),
      profileName: profile.name,
    };
  }
  throw new Error('Too many redirects');
}

type WaybackAvailability = {
  archived_snapshots?: { closest?: { available?: boolean; url?: string } };
};

async function fetchWayback(
  rawUrl: string,
  maxBytes: number,
  timeoutMs: number,
): Promise<{ html: string; finalUrl: string } | null> {
  try {
    const apiUrl = `https://archive.org/wayback/available?url=${encodeURIComponent(rawUrl)}`;
    await assertSafeHttpUrl(apiUrl);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let api: Response;
    try {
      api = await fetch(apiUrl, {
        headers: browserHeadersFor(apiUrl),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!api.ok) return null;
    const json = (await api.json()) as WaybackAvailability;
    const snap = json.archived_snapshots?.closest;
    if (!snap?.available || !snap.url) return null;
    // Wayback returns a `web.archive.org/web/...` URL; rewrite to
    // `if_` (iframe-mode) which strips Wayback's nav-bar injection.
    const cleanUrl = snap.url.replace(/\/web\/(\d+)\//, '/web/$1if_/');
    await assertSafeHttpUrl(cleanUrl);
    const ctrl2 = new AbortController();
    const timer2 = setTimeout(() => ctrl2.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(cleanUrl, {
        headers: browserHeadersFor(cleanUrl),
        redirect: 'follow',
        signal: ctrl2.signal,
      });
    } finally {
      clearTimeout(timer2);
    }
    if (!res.ok) return null;
    const reader = res.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          ctrl2.abort();
          return null;
        }
        chunks.push(value);
      }
    }
    return { html: Buffer.concat(chunks).toString('utf-8'), finalUrl: cleanUrl };
  } catch {
    return null;
  }
}

export async function resilientFetchHtml(
  rawUrl: string,
  opts: ResilientFetchOptions = {},
): Promise<ResilientFetchOutcome> {
  const cache = opts.cache ?? { etag: null, lastModified: null };
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const tryRotate = opts.enableUaRotate !== false;
  const tryFeed = opts.enableFeedFallback !== false;
  const tryWayback = opts.enableWaybackFallback !== false;

  // Step 1: direct fetch with the host's stable profile.
  let blockedBodies: string[] = [];
  let firstAttempt: DirectAttempt;
  try {
    firstAttempt = await attemptDirect(rawUrl, cache, 0, maxBytes, timeoutMs);
  } catch (err) {
    // Hard fail (404, 5xx, content-type, redirect loop, SSRF) — no
    // fallback can rescue these honestly. Surface as-is.
    throw err;
  }
  if (firstAttempt.kind === 'unchanged') return { kind: 'unchanged' };
  if (firstAttempt.kind === 'ok') {
    return {
      kind: 'html',
      via: 'direct',
      finalUrl: firstAttempt.finalUrl,
      bodyHtml: firstAttempt.bodyHtml,
      etag: firstAttempt.etag,
      lastModified: firstAttempt.lastModified,
      profileName: firstAttempt.profileName,
    };
  }
  if ('bodyForDiscovery' in firstAttempt && firstAttempt.bodyForDiscovery) {
    blockedBodies.push(firstAttempt.bodyForDiscovery);
  }

  // Step 2: rotate UA, retry once. Fresh cache headers — we want the
  // full body even if the previous fingerprint was cached upstream.
  if (tryRotate) {
    let secondAttempt: DirectAttempt;
    try {
      secondAttempt = await attemptDirect(
        rawUrl,
        { etag: null, lastModified: null },
        1,
        maxBytes,
        timeoutMs,
      );
    } catch {
      secondAttempt = { kind: 'blocked', status: 0, bodyForDiscovery: null };
    }
    if (secondAttempt.kind === 'unchanged') return { kind: 'unchanged' };
    if (secondAttempt.kind === 'ok') {
      return {
        kind: 'html',
        via: 'rotated-ua',
        finalUrl: secondAttempt.finalUrl,
        bodyHtml: secondAttempt.bodyHtml,
        etag: secondAttempt.etag,
        lastModified: secondAttempt.lastModified,
        profileName: secondAttempt.profileName,
      };
    }
    if ('bodyForDiscovery' in secondAttempt && secondAttempt.bodyForDiscovery) {
      blockedBodies.push(secondAttempt.bodyForDiscovery);
    }
  }

  // Step 3: feed discovery. Use any HTML we did manage to grab as a
  // hint for `<link rel="alternate">` parsing.
  if (tryFeed) {
    const sniffSource = blockedBodies.find((b) => b.length > 200) ?? undefined;
    const feed = await discoverFeed(rawUrl, sniffSource);
    if (feed) {
      return {
        kind: 'feed',
        via: 'feed-fallback',
        feedUrl: feed.feedUrl,
        discoveredVia: feed.via,
      };
    }
  }

  // Step 4: archive.org. Stale but unblockable.
  if (tryWayback) {
    const wb = await fetchWayback(rawUrl, maxBytes, timeoutMs);
    if (wb) {
      return {
        kind: 'html',
        via: 'wayback',
        finalUrl: wb.finalUrl,
        bodyHtml: wb.html,
        // Wayback snapshots have their own etag/last-modified that
        // refer to the *snapshot*, not the live page. Returning null
        // means the next sync re-runs the chain instead of trusting
        // a snapshot validator that won't change until a new crawl.
        etag: null,
        lastModified: null,
        profileName: 'wayback',
      };
    }
  }

  // Out of options — surface a useful error mentioning what we tried.
  const tried: string[] = ['direct'];
  if (tryRotate) tried.push('rotated-ua');
  if (tryFeed) tried.push('feed-discovery');
  if (tryWayback) tried.push('wayback');
  throw new Error(`Upstream blocked all fallbacks (tried: ${tried.join(', ')})`);
}
