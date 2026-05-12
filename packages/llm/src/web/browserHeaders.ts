import { createHash } from 'node:crypto';

/**
 * Realistic browser-shape headers, rotated per host. The point is to
 * stop looking like the kind of bot WAFs auto-deny — most of those
 * gates check User-Agent + the presence of `Accept-Language` and the
 * `Sec-Fetch-*` set + (for Chrome/Edge) `sec-ch-ua` Client Hints. A
 * request that gets all of those right looks indistinguishable from
 * a freshly-launched browser tab.
 *
 * The pool is intentionally small. Every entry is a current,
 * commonly-deployed combination — picking something obscure is its
 * own fingerprint. Bumping the versions periodically keeps the pool
 * from drifting into "no real browser sends this" territory; six-
 * month rolling refresh is fine.
 *
 * Selection is hash-of-host based by default so the same site always
 * sees the same UA across attempts, which is *less* suspicious than
 * a fingerprint that flips between requests. The `attempt` parameter
 * intentionally rotates to a different bucket only on retry (after
 * a 403/429), at which point we've already failed once and have
 * nothing to lose by trying a different fingerprint.
 */

export type BrowserProfile = {
  /** Display label for logs/metrics. */
  name: string;
  ua: string;
  /** sec-ch-ua brand list. Chromium-family only; null for Firefox/Safari. */
  secChUa: string | null;
  /** sec-ch-ua-platform value (with quotes). */
  platform: string;
  /** sec-ch-ua-mobile value. Always ?0 for our pool — desktop only. */
  mobile: '?0';
  /** Accept-Language. en-US first since most sites optimise for it. */
  acceptLanguage: string;
};

/**
 * Six current desktop browser fingerprints. Versions bumped 2026-05;
 * refresh every couple of releases. Ordering is irrelevant — selection
 * is hash-based.
 */
export const BROWSER_POOL: readonly BrowserProfile[] = [
  {
    name: 'chrome-win',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
    secChUa: '"Not A(Brand";v="8", "Chromium";v="132", "Google Chrome";v="132"',
    platform: '"Windows"',
    mobile: '?0',
    acceptLanguage: 'en-US,en;q=0.9',
  },
  {
    name: 'chrome-mac',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
    secChUa: '"Not A(Brand";v="8", "Chromium";v="132", "Google Chrome";v="132"',
    platform: '"macOS"',
    mobile: '?0',
    acceptLanguage: 'en-US,en;q=0.9',
  },
  {
    name: 'edge-win',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 Edg/132.0.0.0',
    secChUa: '"Not A(Brand";v="8", "Chromium";v="132", "Microsoft Edge";v="132"',
    platform: '"Windows"',
    mobile: '?0',
    acceptLanguage: 'en-US,en;q=0.9',
  },
  {
    name: 'firefox-win',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:134.0) Gecko/20100101 Firefox/134.0',
    secChUa: null,
    platform: '"Windows"',
    mobile: '?0',
    acceptLanguage: 'en-US,en;q=0.5',
  },
  {
    name: 'firefox-mac',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:134.0) Gecko/20100101 Firefox/134.0',
    secChUa: null,
    platform: '"macOS"',
    mobile: '?0',
    acceptLanguage: 'en-US,en;q=0.5',
  },
  {
    name: 'safari-mac',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15',
    secChUa: null,
    platform: '"macOS"',
    mobile: '?0',
    acceptLanguage: 'en-US,en;q=0.9',
  },
] as const;

/** Pick a profile from the pool, seeded by `seed` and offset by `attempt`. */
export function pickBrowserProfile(seed: string, attempt = 0): BrowserProfile {
  const h = createHash('sha1').update(seed).digest();
  const base = h.readUInt32BE(0);
  const idx = (base + attempt) % BROWSER_POOL.length;
  return BROWSER_POOL[idx]!;
}

/**
 * Build the full header set for an HTML document fetch. Mirrors what a
 * real browser sends on a top-level navigation: Accept that prefers
 * HTML, Sec-Fetch-* indicating a navigate-from-address-bar, and the
 * sec-ch-ua Client Hint set when the chosen profile is Chromium.
 */
export function browserNavHeaders(profile: BrowserProfile): Record<string, string> {
  const h: Record<string, string> = {
    'User-Agent': profile.ua,
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': profile.acceptLanguage,
    'Accept-Encoding': 'gzip, deflate, br',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-User': '?1',
    'Sec-Fetch-Dest': 'document',
  };
  if (profile.secChUa) {
    h['sec-ch-ua'] = profile.secChUa;
    h['sec-ch-ua-mobile'] = profile.mobile;
    h['sec-ch-ua-platform'] = profile.platform;
  }
  return h;
}

/**
 * Pick a profile + build navigation headers in one call. `urlOrSeed`
 * may be a URL or any stable seed string — when it parses as a URL we
 * use the hostname so every page on the same site picks the same
 * profile (a real visitor wouldn't switch browsers between page
 * loads).
 */
export function browserHeadersFor(urlOrSeed: string, attempt = 0): Record<string, string> {
  let seed = urlOrSeed;
  try {
    seed = new URL(urlOrSeed).hostname.toLowerCase();
  } catch {
    // not a URL — fine, hash whatever we got
  }
  return browserNavHeaders(pickBrowserProfile(seed, attempt));
}

/**
 * XML-fetch variant: same UA + language but Accept tuned for RSS/Atom.
 * The Sec-Fetch-Dest changes from `document` to `empty` because real
 * browsers fetch feed XML via subscription clients or fetch(), not
 * top-level navigation.
 */
export function browserFeedHeaders(urlOrSeed: string, attempt = 0): Record<string, string> {
  const profile = pickBrowserProfile(
    (() => {
      try {
        return new URL(urlOrSeed).hostname.toLowerCase();
      } catch {
        return urlOrSeed;
      }
    })(),
    attempt,
  );
  const h: Record<string, string> = {
    'User-Agent': profile.ua,
    Accept:
      'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5',
    'Accept-Language': profile.acceptLanguage,
    'Accept-Encoding': 'gzip, deflate, br',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
  };
  if (profile.secChUa) {
    h['sec-ch-ua'] = profile.secChUa;
    h['sec-ch-ua-mobile'] = profile.mobile;
    h['sec-ch-ua-platform'] = profile.platform;
  }
  return h;
}
