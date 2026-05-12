import { describe, it, expect } from 'vitest';
import { extractOutboundLinks } from '../services/outboundLinks.js';

/**
 * Outbound-link extraction. Page.outboundLinks feeds the lineage
 * endpoint's "cited-by" lookup; if the regex misses a real link or
 * captures something garbage the inbound list either under-counts
 * or pollutes the result. Lock down the shape.
 */
describe('extractOutboundLinks', () => {
  it('finds /p/<slug> mentions', () => {
    expect(
      extractOutboundLinks(
        'See [the other page](/p/other-thing) and [more](/p/another).',
        'self',
      ),
    ).toEqual(['other-thing', 'another']);
  });

  it('dedupes repeated references', () => {
    expect(
      extractOutboundLinks(
        '[a](/p/foo) and again [b](/p/foo) plus [c](/p/foo).',
        'self',
      ),
    ).toEqual(['foo']);
  });

  it('skips the own slug so a page never cites itself', () => {
    expect(
      extractOutboundLinks(
        '[me](/p/self) and [other](/p/other).',
        'self',
      ),
    ).toEqual(['other']);
  });

  it('returns empty for null or empty contentMd', () => {
    expect(extractOutboundLinks(null, 'self')).toEqual([]);
    expect(extractOutboundLinks('', 'self')).toEqual([]);
    expect(extractOutboundLinks(undefined, 'self')).toEqual([]);
  });

  it('does not match URLs that just happen to contain /p/', () => {
    // The slug pattern requires lowercase-alphanumeric-then-kebab,
    // and stops at any other character. Trailing `/foo` is fine
    // (extracts `slug`); a hash inline isn\'t.
    const got = extractOutboundLinks(
      'See [a](/p/valid-slug) but not [b](https://other.example/p/),',
      'self',
    );
    expect(got).toContain('valid-slug');
  });

  it('preserves first-seen ordering across multiple slugs', () => {
    expect(
      extractOutboundLinks(
        '[b](/p/banana) then [a](/p/apple) then [c](/p/cherry) then [b](/p/banana)',
        'self',
      ),
    ).toEqual(['banana', 'apple', 'cherry']);
  });

  it('caps very long lists at MAX_OUTBOUND', () => {
    const links = Array.from({ length: 250 }, (_, i) => `(/p/slug-${i})`).join(
      ' ',
    );
    const out = extractOutboundLinks(links, 'self');
    expect(out.length).toBeLessThanOrEqual(200);
  });
});
