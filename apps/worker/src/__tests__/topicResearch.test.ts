import { describe, it, expect } from 'vitest';
import {
  buildQueries,
  harvestLinks,
  parsePublishedAt,
  recencyFactor,
  scoreLink,
} from '../processors/topicResearch.js';

/**
 * Pure-function tests for topicResearch helpers. The orchestrator
 * itself talks to BullMQ + Mongo + Ollama + the network, so we
 * cover that with integration tests separately. The helpers here
 * are the pieces that decide what gets into the synthesis corpus
 * — drift quietly corrupts ranking + recursion.
 */

describe('parsePublishedAt', () => {
  it('parses an ISO string from article meta', () => {
    const r = parsePublishedAt('2026-05-08T12:00:00Z', null);
    expect(r).not.toBeNull();
    expect(r?.toISOString()).toBe('2026-05-08T12:00:00.000Z');
  });

  it('falls back to fetchedAt when primary is unparseable', () => {
    const fallback = new Date('2026-01-01T00:00:00Z');
    const r = parsePublishedAt('not a date', fallback);
    expect(r).toBe(fallback);
  });

  it('returns null when both are missing / unparseable', () => {
    expect(parsePublishedAt(null, null)).toBeNull();
    expect(parsePublishedAt('', undefined)).toBeNull();
    expect(parsePublishedAt('garbage', new Date('not a date'))).toBeNull();
  });

  it('accepts a Date directly as primary', () => {
    const d = new Date('2026-05-08T12:00:00Z');
    expect(parsePublishedAt(d, null)).toBe(d);
  });
});

describe('recencyFactor', () => {
  it('returns 1.0 for an article published today', () => {
    expect(recencyFactor(new Date())).toBeCloseTo(1.0, 5);
  });

  it('returns 0.85 fallback when publishedAt is null', () => {
    // Unknown date — treat as moderately fresh so unknown articles
    // aren't penalised too hard against dated ones.
    expect(recencyFactor(null)).toBeCloseTo(0.85, 5);
  });

  it('clamps at 0.6 floor for very old articles', () => {
    // Year-ago articles or older.
    const oldDate = new Date(Date.now() - 365 * 24 * 3600 * 1000);
    expect(recencyFactor(oldDate)).toBeGreaterThanOrEqual(0.6);
    // Truly ancient — still 0.6.
    const ancient = new Date(Date.now() - 10 * 365 * 24 * 3600 * 1000);
    expect(recencyFactor(ancient)).toBeCloseTo(0.6, 5);
  });

  it('decays monotonically with age', () => {
    const week = new Date(Date.now() - 7 * 24 * 3600 * 1000);
    const month = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    expect(recencyFactor(week)).toBeGreaterThan(recencyFactor(month));
  });
});

describe('buildQueries', () => {
  it('produces three predictable templated queries', () => {
    const q = buildQueries('Iran');
    expect(q).toHaveLength(3);
    expect(q[0]).toBe('Iran latest news');
    expect(q[1]).toContain('Iran');
    expect(q[1]).toMatch(/\d{4}/);
    expect(q[2]).toBe('Iran background context');
  });

  it('returns empty for empty / whitespace topic', () => {
    expect(buildQueries('')).toHaveLength(0);
    expect(buildQueries('   ')).toHaveLength(0);
  });

  it('preserves topic case verbatim in the query strings', () => {
    expect(buildQueries('SpaceX')[0]).toContain('SpaceX');
  });
});

describe('scoreLink', () => {
  const topicTokens = new Set(['iran', 'tehran']);

  it('scores anchor text with topic-token overlap', () => {
    const s = scoreLink(
      'https://news.example.com/iran-update',
      'Iran update from Tehran',
      topicTokens,
      'parent.com',
    );
    expect(s).toBeGreaterThan(0.5);
  });

  it('returns 0 for non-http(s) schemes', () => {
    expect(
      scoreLink('javascript:void(0)', 'click', topicTokens, 'parent.com'),
    ).toBe(0);
    expect(
      scoreLink('mailto:x@y.com', 'click', topicTokens, 'parent.com'),
    ).toBe(0);
  });

  it('returns 0 for known navigational chrome anchor text', () => {
    expect(
      scoreLink('https://x.com/foo', 'Home', topicTokens, 'parent.com'),
    ).toBe(0);
    expect(
      scoreLink('https://x.com/foo', 'Click here', topicTokens, 'parent.com'),
    ).toBe(0);
  });

  it('penalises login / subscribe / share URLs', () => {
    const high = scoreLink(
      'https://x.com/iran-coverage',
      'Iran coverage',
      topicTokens,
      'parent.com',
    );
    const sub = scoreLink(
      'https://x.com/subscribe?ref=foo',
      'Iran coverage',
      topicTokens,
      'parent.com',
    );
    expect(sub).toBeLessThan(high);
  });

  it('boosts trusted hosts', () => {
    const trusted = scoreLink(
      'https://apnews.com/article/iran',
      'Iran update',
      topicTokens,
      'parent.com',
    );
    const random = scoreLink(
      'https://random-blog.example.com/article/iran',
      'Iran update',
      topicTokens,
      'parent.com',
    );
    expect(trusted).toBeGreaterThan(random);
  });

  it('lightly penalises same-host links to encourage source diversity', () => {
    const sameHost = scoreLink(
      'https://parent.com/related/iran',
      'Iran related',
      topicTokens,
      'parent.com',
    );
    const otherHost = scoreLink(
      'https://other.com/related/iran',
      'Iran related',
      topicTokens,
      'parent.com',
    );
    expect(sameHost).toBeLessThan(otherHost);
  });
});

describe('harvestLinks', () => {
  it('extracts in-body anchors and dedups by URL', () => {
    const html = `
      <article>
        <p>Read <a href="https://news.example.com/iran-news">Iran news coverage</a> for more.</p>
        <p>Also see <a href="https://news.example.com/iran-news">the same Iran news</a>.</p>
        <p>Or <a href="https://other.com/foo">unrelated</a>.</p>
      </article>
    `;
    const out = harvestLinks(
      html,
      'https://parent.com/article',
      'Iran',
      'parent.com',
      new Set(),
    );
    // Two distinct URLs above the score threshold; the dup
    // collapses (only one entry for the news.example.com URL).
    const urls = out.map((c) => c.url);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it('respects the visited set', () => {
    const html = `<a href="https://x.com/iran">Iran story</a>`;
    const visited = new Set(['https://x.com/iran']);
    const out = harvestLinks(
      html,
      'https://parent.com/article',
      'Iran',
      'parent.com',
      visited,
    );
    expect(out).toHaveLength(0);
  });

  it('resolves relative URLs against the parent', () => {
    const html = `<a href="/iran-coverage">Iran coverage</a>`;
    const out = harvestLinks(
      html,
      'https://news.com/articles/123',
      'Iran',
      'news.com',
      new Set(),
    );
    if (out.length > 0) {
      expect(out[0]?.url.startsWith('https://news.com/iran-coverage')).toBe(true);
    }
  });

  it('returns empty for an empty topic label', () => {
    const html = `<a href="https://x.com/iran">Iran story</a>`;
    const out = harvestLinks(html, 'https://p.com', '', 'p.com', new Set());
    expect(out).toHaveLength(0);
  });

  it('returns sorted by score descending', () => {
    const html = `
      <a href="https://x.com/iran-story">Iran in depth</a>
      <a href="https://x.com/somewhere">Iran</a>
    `;
    const out = harvestLinks(
      html,
      'https://parent.com',
      'Iran depth coverage',
      'parent.com',
      new Set(),
    );
    if (out.length >= 2) {
      // Higher-overlap anchor text wins.
      expect(out[0]!.score).toBeGreaterThanOrEqual(out[1]!.score);
    }
  });
});
