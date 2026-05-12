import { describe, it, expect } from 'vitest';
import {
  BROWSER_POOL,
  pickBrowserProfile,
  browserHeadersFor,
  browserFeedHeaders,
} from '@rose/llm';

/**
 * Browser-fingerprint pool. The contract: pick is stable per host
 * (a real visitor doesn't switch browsers between page loads),
 * rotates predictably on retry, and every emitted header set looks
 * like an actual browser nav request — UA + Accept-Language +
 * Sec-Fetch-* present, sec-ch-ua only on Chromium-family entries.
 */

describe('pickBrowserProfile', () => {
  it('returns a profile from the pool', () => {
    const p = pickBrowserProfile('example.com');
    expect(BROWSER_POOL.includes(p)).toBe(true);
  });

  it('is stable across calls for the same seed', () => {
    const a = pickBrowserProfile('example.com');
    const b = pickBrowserProfile('example.com');
    expect(a.name).toBe(b.name);
  });

  it('different seeds usually pick different profiles (across the whole pool)', () => {
    // Across many seeds we should hit every profile at least once —
    // a hash that always returned the same bucket would be a bug.
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      seen.add(pickBrowserProfile(`host-${i}.example`).name);
    }
    expect(seen.size).toBe(BROWSER_POOL.length);
  });

  it('attempt offset rotates to a different bucket on retry', () => {
    const first = pickBrowserProfile('blocked.example', 0);
    const next = pickBrowserProfile('blocked.example', 1);
    expect(next.name).not.toBe(first.name);
  });
});

describe('browserHeadersFor', () => {
  it('emits a browser-shaped header set with the expected keys', () => {
    const h = browserHeadersFor('https://example.com/article');
    expect(h['User-Agent']).toMatch(/Mozilla\/5\.0/);
    expect(h['Accept']).toMatch(/text\/html/);
    expect(h['Accept-Language']).toMatch(/en-US/);
    expect(h['Accept-Encoding']).toBe('gzip, deflate, br');
    expect(h['Sec-Fetch-Site']).toBe('none');
    expect(h['Sec-Fetch-Mode']).toBe('navigate');
    expect(h['Sec-Fetch-Dest']).toBe('document');
    expect(h['Upgrade-Insecure-Requests']).toBe('1');
  });

  it('does NOT identify itself as Rose anywhere', () => {
    // The whole point of the rotation: do not look like our bot.
    // Spot-check across the entire pool and the rendered headers.
    for (let i = 0; i < BROWSER_POOL.length; i += 1) {
      const h = browserHeadersFor(`https://host-${i}.example`, i);
      for (const v of Object.values(h)) {
        expect(v.toLowerCase()).not.toContain('rose');
        expect(v.toLowerCase()).not.toContain('rose.local');
      }
    }
  });

  it('only emits sec-ch-ua client hints on Chromium-family profiles', () => {
    // Iterate the whole pool deterministically by passing a known
    // attempt offset; verify the Chromium-family entries get
    // sec-ch-ua and the Firefox/Safari entries don't.
    for (let i = 0; i < BROWSER_POOL.length; i += 1) {
      const profile = pickBrowserProfile('test', i);
      const headers = browserHeadersFor('https://test.example', i);
      if (profile.secChUa) {
        expect(headers['sec-ch-ua']).toBe(profile.secChUa);
        expect(headers['sec-ch-ua-platform']).toBe(profile.platform);
      } else {
        expect(headers['sec-ch-ua']).toBeUndefined();
      }
    }
  });

  it('host-derived seed: same host across full URLs picks the same profile', () => {
    const a = browserHeadersFor('https://example.com/page-a');
    const b = browserHeadersFor('https://example.com/page-b?q=1');
    expect(a['User-Agent']).toBe(b['User-Agent']);
  });
});

describe('browserFeedHeaders', () => {
  it('Accept prefers feed mimetypes over HTML', () => {
    const h = browserFeedHeaders('https://example.com/feed.xml');
    expect(h['Accept']).toMatch(/application\/rss\+xml/);
    expect(h['Accept']).toMatch(/application\/atom\+xml/);
    expect(h['Sec-Fetch-Dest']).toBe('empty');
  });

  it('shares the UA pool with the nav helper', () => {
    // Same host should pick the same UA whether we ask for nav or
    // feed headers — keeps WAFs from seeing two different
    // fingerprints from the "same" client.
    const nav = browserHeadersFor('https://example.com/');
    const feed = browserFeedHeaders('https://example.com/feed.xml');
    expect(feed['User-Agent']).toBe(nav['User-Agent']);
  });
});
