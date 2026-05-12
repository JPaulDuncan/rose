import { describe, it, expect } from 'vitest';
import { scoreWikidataHit } from '../services/wikidataResolver.js';

/**
 * Confidence-scoring math for Wikidata top-hit candidates.
 * resolveWikidata wraps fetch + cache around this; the routing it
 * does on the result depends entirely on the score. Keep this
 * locked down so loosening one of the kind-match regexes doesn't
 * silently degrade resolver precision.
 */

describe('scoreWikidataHit', () => {
  describe('organizations', () => {
    it('returns 1.0 on exact label + matching description', () => {
      expect(
        scoreWikidataHit('Anthropic', 'organization', {
          label: 'Anthropic',
          description: 'American artificial intelligence company',
        }),
      ).toBe(1);
    });

    it('returns 0.7 on exact label, generic description', () => {
      expect(
        scoreWikidataHit('Anthropic', 'organization', {
          label: 'Anthropic',
          description: 'philosophical concept',
        }),
      ).toBe(0.7);
    });

    it('returns 0.5 on non-exact label', () => {
      expect(
        scoreWikidataHit('Anthropic Inc', 'organization', {
          label: 'Anthropic',
          description: 'American company',
        }),
      ).toBe(0.5);
    });

    it('handles missing description as a generic match', () => {
      expect(
        scoreWikidataHit('Foo', 'organization', { label: 'Foo' }),
      ).toBe(0.7);
    });

    it('is case-insensitive on label comparison', () => {
      expect(
        scoreWikidataHit('OPENAI', 'organization', {
          label: 'OpenAI',
          description: 'AI research company',
        }),
      ).toBe(1);
    });
  });

  describe('products', () => {
    it('matches product descriptions', () => {
      expect(
        scoreWikidataHit('iPhone', 'product', {
          label: 'iPhone',
          description: 'consumer electronics product line',
        }),
      ).toBe(1);
    });

    it('does not double-credit unrelated descriptions', () => {
      expect(
        scoreWikidataHit('Apple', 'product', {
          label: 'Apple',
          description: 'fruit',
        }),
      ).toBe(0.7);
    });
  });

  describe('persons', () => {
    it('matches a person description', () => {
      expect(
        scoreWikidataHit('Dario Amodei', 'person', {
          label: 'Dario Amodei',
          description: 'Italian-American AI researcher and entrepreneur',
        }),
      ).toBe(1);
    });

    it('rejects person hits that look like a place', () => {
      expect(
        scoreWikidataHit('Paris', 'person', {
          label: 'Paris',
          description: 'capital of France',
        }),
      ).toBe(0.7);
    });

    it('matches a politician description', () => {
      expect(
        scoreWikidataHit('Angela Merkel', 'person', {
          label: 'Angela Merkel',
          description: 'former Chancellor of Germany, politician',
        }),
      ).toBe(1);
    });
  });

  describe('places', () => {
    it('matches a city description', () => {
      expect(
        scoreWikidataHit('Paris', 'place', {
          label: 'Paris',
          description: 'capital and largest city of France',
        }),
      ).toBe(1);
    });

    it('matches a country description', () => {
      expect(
        scoreWikidataHit('France', 'place', {
          label: 'France',
          description: 'country in Western Europe',
        }),
      ).toBe(1);
    });

    it('matches a continent description', () => {
      expect(
        scoreWikidataHit('Europe', 'place', {
          label: 'Europe',
          description: 'continent',
        }),
      ).toBe(1);
    });

    it('does not credit unrelated description', () => {
      expect(
        scoreWikidataHit('Mercury', 'place', {
          label: 'Mercury',
          description: 'chemical element',
        }),
      ).toBe(0.7);
    });
  });

  describe('robustness', () => {
    it('handles missing label safely (returns 0.5)', () => {
      expect(scoreWikidataHit('whatever', 'place', {})).toBe(0.5);
    });

    it('trims whitespace when comparing labels', () => {
      expect(
        scoreWikidataHit('  Anthropic  ', 'organization', {
          label: 'Anthropic',
          description: 'company',
        }),
      ).toBe(1);
    });
  });
});
