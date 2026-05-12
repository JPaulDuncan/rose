import { describe, it, expect } from 'vitest';
import {
  PREDICATES,
  predicateByKey,
  activePredicates,
  isSymmetric,
  PredicateKey,
  ONTOLOGY_VERSION,
} from '@rose/shared';

/**
 * Ontology vocabulary regression suite. The predicate definitions
 * are imported all over the worker + API — once a row exists in
 * EntityRelation with a given predicate key, the key has to stay
 * resolvable forever (deprecated keys still validate). These tests
 * lock down the shape so a refactor can't quietly drop a key or
 * change a subject/object type and break old rows.
 */
describe('predicateByKey', () => {
  it('returns null for an unknown key', () => {
    expect(predicateByKey('made-up-thing')).toBeNull();
  });

  it('resolves every key in PREDICATES', () => {
    for (const p of PREDICATES) {
      expect(predicateByKey(p.key)).toBe(p);
    }
  });

  it('handles empty string defensively', () => {
    expect(predicateByKey('')).toBeNull();
  });
});

describe('activePredicates', () => {
  it('returns every predicate without a deprecatedAt', () => {
    const active = activePredicates();
    expect(active.length).toBeGreaterThan(0);
    for (const p of active) {
      expect(p.deprecatedAt).toBeUndefined();
    }
  });

  it('is a subset of PREDICATES', () => {
    const keys = new Set(PREDICATES.map((p) => p.key));
    for (const p of activePredicates()) {
      expect(keys.has(p.key)).toBe(true);
    }
  });
});

describe('isSymmetric', () => {
  it('flags spouse / sibling / colleague as symmetric', () => {
    expect(isSymmetric(predicateByKey('spouse')!)).toBe(true);
    expect(isSymmetric(predicateByKey('sibling-of')!)).toBe(true);
    expect(isSymmetric(predicateByKey('colleague-of')!)).toBe(true);
  });

  it('flags partner / competitor as symmetric', () => {
    expect(isSymmetric(predicateByKey('partner-of')!)).toBe(true);
    expect(isSymmetric(predicateByKey('competitor-of')!)).toBe(true);
  });

  it('flags employer / founder / parent / creator as asymmetric', () => {
    expect(isSymmetric(predicateByKey('employer')!)).toBe(false);
    expect(isSymmetric(predicateByKey('founder-of')!)).toBe(false);
    expect(isSymmetric(predicateByKey('parent-of')!)).toBe(false);
    expect(isSymmetric(predicateByKey('creator-of')!)).toBe(false);
  });
});

describe('PredicateKey (zod)', () => {
  it('accepts a known key', () => {
    expect(() => PredicateKey.parse('employer')).not.toThrow();
  });

  it('rejects an unknown key', () => {
    expect(() => PredicateKey.parse('definitely-not-real')).toThrow();
  });

  it('rejects empty strings', () => {
    expect(() => PredicateKey.parse('')).toThrow();
  });
});

describe('Wikidata + schema.org cross-links', () => {
  /**
   * Spot-check: predicates that map to a Wikidata property in the
   * SPARQL relation enricher must keep the URI shape stable so the
   * enricher's `extractProperty(uri)` regex (`/(P\d+)$/`) still
   * matches.
   */
  it.each([
    ['employer', 'P108'],
    ['founder-of', 'P112'],
    ['spouse', 'P26'],
    ['headquartered-in', 'P159'],
    ['creator-of', 'P170'],
  ] as const)('predicate %s maps to wikidata %s', (key, want) => {
    const def = predicateByKey(key)!;
    expect(def.wikidata).toBeDefined();
    expect(def.wikidata!.startsWith('https://www.wikidata.org/wiki/Property:')).toBe(
      true,
    );
    const id = def.wikidata!.match(/(P\d+)$/)?.[1];
    expect(id).toBe(want);
  });

  it('born-in does not require a wikidata mapping (schema.org-only)', () => {
    const def = predicateByKey('born-in')!;
    // schema.org URI present even when wikidata is absent.
    expect(def.schemaOrg).toBe('https://schema.org/birthPlace');
  });
});

describe('ONTOLOGY_VERSION', () => {
  it('is a YYYY-MM-DD date', () => {
    expect(ONTOLOGY_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
