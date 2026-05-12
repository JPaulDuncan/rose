import { Parser as Htmlparser2 } from 'htmlparser2';
import { assertSafeHttpUrl } from './safeUrl.js';
import { browserFeedHeaders } from './browserHeaders.js';

/**
 * Find an RSS or Atom feed for a site that's blocking direct HTML
 * fetches. Two strategies, in order:
 *
 *   1. **Parse `<link rel="alternate">` from HTML we already have.**
 *      If the caller managed to fetch the page once (even a partial
 *      response — Cloudflare's challenge page itself often includes
 *      the real site's `<link>` set), the autodiscovery tag points
 *      straight at the canonical feed.
 *
 *   2. **Probe well-known feed paths.** When step 1 yields nothing,
 *      try the seven most common conventions (`/feed`, `/feed.xml`,
 *      `/rss`, `/rss.xml`, `/atom.xml`, `/index.xml`, `/.rss`)
 *      against the site's origin. Validate each by content-type
 *      sniffing the response — anything that comes back as
 *      `application/rss+xml`, `application/atom+xml`, or generic XML
 *      with a recognisable feed root element counts.
 *
 * The whole probe takes at most ~7 HEAD-equivalent round-trips and
 * we short-circuit on the first hit. In practice step 1 catches the
 * majority of news/blog/Substack-style sites; step 2 picks up
 * Wordpress installs that don't advertise `<link>` from the home
 * page.
 */

/** Common Wordpress / Hugo / Jekyll / Substack feed conventions. */
const WELL_KNOWN_FEED_PATHS = [
  '/feed',
  '/feed/',
  '/feed.xml',
  '/rss',
  '/rss.xml',
  '/atom.xml',
  '/index.xml',
  '/.rss',
] as const;

/** Content-types that unambiguously indicate a feed payload. */
const FEED_CT_RE = /(application|text)\/(rss|atom|xml)/i;

/** Root elements that mean "this is a feed" if we have to inspect the body. */
const FEED_ROOT_RE = /<(rss|feed|rdf:RDF)\b/i;

/** Pull every `<link rel="alternate" type="application/...+xml">` href. */
export function parseFeedLinks(html: string, baseUrl: string): string[] {
  const out: string[] = [];
  const parser = new Htmlparser2(
    {
      onopentag(name, attrs) {
        if (name !== 'link') return;
        const rel = (attrs.rel ?? '').toLowerCase();
        if (!rel.split(/\s+/).includes('alternate')) return;
        const type = (attrs.type ?? '').toLowerCase();
        if (!type.includes('rss') && !type.includes('atom') && !type.includes('xml')) return;
        const href = attrs.href;
        if (!href) return;
        try {
          out.push(new URL(href, baseUrl).toString());
        } catch {
          // skip unparseable href
        }
      },
    },
    { lowerCaseTags: true, lowerCaseAttributeNames: true },
  );
  parser.write(html);
  parser.end();
  return out;
}

async function looksLikeFeed(url: string, signal: AbortSignal): Promise<boolean> {
  try {
    await assertSafeHttpUrl(url);
    const res = await fetch(url, { headers: browserFeedHeaders(url), signal });
    if (!res.ok) return false;
    const ct = (res.headers.get('content-type') ?? '').toLowerCase();
    if (FEED_CT_RE.test(ct)) {
      // Drain so the connection can be reused.
      await res.arrayBuffer().catch(() => null);
      return true;
    }
    // Some hosts mis-serve feeds as text/html. Sniff the first 2KB.
    const head = (await res.text()).slice(0, 2048);
    return FEED_ROOT_RE.test(head);
  } catch {
    return false;
  }
}

export type FeedDiscoveryResult = {
  feedUrl: string;
  via: 'autodiscovery' | 'well-known';
} | null;

/**
 * Try to find a usable feed for `pageUrl`. `html` is optional — when
 * provided (because the caller managed to fetch *something*), step
 * 1 runs against it first. Either way step 2 probes well-known paths
 * if step 1 turns up empty.
 *
 * Caller controls the overall budget via `signal`; without one we
 * impose a 10s soft-cap.
 */
export async function discoverFeed(
  pageUrl: string,
  html?: string,
  signal?: AbortSignal,
): Promise<FeedDiscoveryResult> {
  const ctrl = signal ? null : new AbortController();
  const sig = signal ?? ctrl!.signal;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), 10_000) : null;
  try {
    if (html) {
      const candidates = parseFeedLinks(html, pageUrl);
      for (const candidate of candidates) {
        if (await looksLikeFeed(candidate, sig)) {
          return { feedUrl: candidate, via: 'autodiscovery' };
        }
      }
    }
    let origin: string;
    try {
      origin = new URL(pageUrl).origin;
    } catch {
      return null;
    }
    for (const path of WELL_KNOWN_FEED_PATHS) {
      const candidate = `${origin}${path}`;
      if (await looksLikeFeed(candidate, sig)) {
        return { feedUrl: candidate, via: 'well-known' };
      }
    }
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
