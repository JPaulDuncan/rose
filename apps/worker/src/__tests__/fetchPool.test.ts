import { describe, it, expect } from 'vitest';
import { hostKeyOf, urlHashOf } from '../services/fetchPool.js';

/**
 * Pure-function tests for fetchPool's URL helpers. The fetch loop
 * itself talks to undici + Redis + the network, so we don't try to
 * unit-test it here — that belongs in an integration suite. The
 * helpers below ARE pure and can drift quietly if they ever stop
 * agreeing with the rate-limiter and unique-index callers, so a
 * regression net is worth having.
 */

describe('hostKeyOf', () => {
  it('returns the eTLD+1 for typical hosts', () => {
    expect(hostKeyOf('https://www.apnews.com/article/123')).toBe('apnews.com');
    expect(hostKeyOf('https://news.example.org/foo')).toBe('example.org');
    expect(hostKeyOf('https://en.wikipedia.org/wiki/Iran')).toBe('wikipedia.org');
  });

  it('handles country-code public suffixes via tldts', () => {
    expect(hostKeyOf('https://www.bbc.co.uk/news')).toBe('bbc.co.uk');
    expect(hostKeyOf('https://www.theguardian.co.uk/world')).toBe('theguardian.co.uk');
  });

  it('returns the bare hostname for unknown / local TLDs', () => {
    // tldts can't classify localhost; the helper falls back to the
    // raw hostname.
    expect(hostKeyOf('http://localhost:3000/foo')).toBe('localhost');
  });

  it('returns empty string on an unparseable URL', () => {
    expect(hostKeyOf('not-a-url')).toBe('');
    expect(hostKeyOf('')).toBe('');
  });

  it('lowercases the host', () => {
    expect(hostKeyOf('https://WWW.Example.COM/x')).toBe('example.com');
  });

  it('strips port from the hostKey result', () => {
    // tldts.parse(hostname) drops :port at the URL parse step,
    // so the hostKey is unaffected by ports — important so the
    // per-host rate limiter doesn't treat localhost:3000 and
    // localhost:8080 as different hosts.
    expect(hostKeyOf('http://example.com:8080/foo')).toBe('example.com');
  });
});

describe('urlHashOf', () => {
  it('produces a stable 64-char hex hash', () => {
    const a = urlHashOf('https://example.com/foo');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    // Stable across calls.
    expect(urlHashOf('https://example.com/foo')).toBe(a);
  });

  it('treats different URLs as distinct (including casing + query)', () => {
    expect(urlHashOf('https://example.com/foo')).not.toBe(
      urlHashOf('https://example.com/Foo'),
    );
    expect(urlHashOf('https://example.com/foo?q=1')).not.toBe(
      urlHashOf('https://example.com/foo'),
    );
    expect(urlHashOf('https://example.com/foo')).not.toBe(
      urlHashOf('http://example.com/foo'),
    );
  });

  it('does NOT canonicalise — caller is responsible for normalising', () => {
    // We deliberately don't trim trailing slashes, normalise scheme,
    // strip fragments, etc. The unique-index contract is "exact URL
    // post-redirects", not "canonical URL." If this changes, the
    // dedup behaviour in topicResearch's cache reuse would change
    // too.
    expect(urlHashOf('https://example.com/foo/')).not.toBe(
      urlHashOf('https://example.com/foo'),
    );
    expect(urlHashOf('https://example.com/foo#section')).not.toBe(
      urlHashOf('https://example.com/foo'),
    );
  });
});
