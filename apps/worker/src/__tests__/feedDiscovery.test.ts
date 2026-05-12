import { describe, it, expect } from 'vitest';
import { parseFeedLinks } from '@rose/llm';

/**
 * `<link rel="alternate" type="...+xml">` autodiscovery. The parser
 * is the cheap part of feed discovery — pulling the right href out
 * of the raw HTML before we spend a network probe on it. Lock down
 * the shapes real sites use.
 */

describe('parseFeedLinks', () => {
  it('extracts an absolute RSS link', () => {
    const html = `
      <html><head>
        <link rel="alternate" type="application/rss+xml"
              title="Site Feed" href="https://example.com/feed.xml" />
      </head><body></body></html>
    `;
    expect(parseFeedLinks(html, 'https://example.com')).toEqual([
      'https://example.com/feed.xml',
    ]);
  });

  it('resolves relative href against the page URL', () => {
    const html = `<link rel="alternate" type="application/atom+xml" href="/atom.xml">`;
    expect(parseFeedLinks(html, 'https://example.com/blog/post-1')).toEqual([
      'https://example.com/atom.xml',
    ]);
  });

  it('accepts atom + generic xml mimetypes too', () => {
    const html = `
      <link rel="alternate" type="application/atom+xml" href="/atom.xml">
      <link rel="alternate" type="application/xml" href="/feed.xml">
    `;
    const out = parseFeedLinks(html, 'https://example.com');
    expect(out).toContain('https://example.com/atom.xml');
    expect(out).toContain('https://example.com/feed.xml');
  });

  it('ignores non-feed alternates (stylesheet, canonical, hreflang)', () => {
    const html = `
      <link rel="stylesheet" href="/css/main.css">
      <link rel="canonical" href="https://example.com/post-1">
      <link rel="alternate" hreflang="es" href="/es/post-1">
      <link rel="alternate" type="application/rss+xml" href="/feed">
    `;
    expect(parseFeedLinks(html, 'https://example.com')).toEqual([
      'https://example.com/feed',
    ]);
  });

  it('handles multi-value rel attributes (rel="alternate stylesheet")', () => {
    // Rare but legal — rel is a space-separated token list.
    const html = `<link rel="alternate stylesheet" type="application/rss+xml" href="/feed">`;
    expect(parseFeedLinks(html, 'https://example.com')).toEqual([
      'https://example.com/feed',
    ]);
  });

  it('skips entries with missing href', () => {
    const html = `<link rel="alternate" type="application/rss+xml">`;
    expect(parseFeedLinks(html, 'https://example.com')).toEqual([]);
  });

  it('returns empty for HTML with no link tags', () => {
    expect(parseFeedLinks('<html><body>hi</body></html>', 'https://example.com')).toEqual([]);
  });
});
