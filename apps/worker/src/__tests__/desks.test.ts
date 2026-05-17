import { describe, it, expect } from 'vitest';
import { Types } from 'mongoose';
import { snapToDesk } from '../services/desks.js';

/**
 * `snapToDesk` is the gate between LLM-emitted free text and the
 * desk vocabulary. Pin every fallback rung — exact match,
 * prefix-on-spaces, Levenshtein typo — because the generator's
 * categoryId assignment depends on each in turn.
 */

const id = (s: string) => new Types.ObjectId(s.padEnd(24, '0'));

const desks = [
  { id: id('1'), name: 'Local' },
  { id: id('2'), name: 'Sports' },
  { id: id('3'), name: 'Advertising' },
  { id: id('4'), name: 'Uncategorized' },
];

describe('snapToDesk — exact match', () => {
  it('matches verbatim', () => {
    expect(snapToDesk('Local', desks)).toEqual(id('1'));
  });

  it('matches case-insensitively', () => {
    expect(snapToDesk('local', desks)).toEqual(id('1'));
    expect(snapToDesk('SPORTS', desks)).toEqual(id('2'));
  });

  it('matches through normalisation (whitespace, punctuation)', () => {
    // Surrounding whitespace + case differences collapse via
    // normalizeCategoryName.
    expect(snapToDesk('  Advertising  ', desks)).toEqual(id('3'));
    // Punctuation-folded variants snap to the matching desk via
    // the prefix rule ("advertising and promos" starts with
    // "advertising " on a word boundary).
    expect(snapToDesk('advertising-and-promos', desks)).toEqual(id('3'));
  });
});

describe('snapToDesk — prefix on word boundary', () => {
  it('matches a desk name that prefixes the emitted text', () => {
    // The LLM occasionally emits "Sports / NBA" or "Sports — week
    // recap" when it wants to add detail. The prefix rule lets the
    // category snap to "Sports" without inventing a new row.
    expect(snapToDesk('Sports recap', desks)).toEqual(id('2'));
  });

  it("doesn't match a prefix that crosses into another word", () => {
    // "Spo" is a prefix substring of "Sports" but NOT a word prefix
    // on the input. We require the desk name to end on a word
    // boundary in the emitted string.
    expect(snapToDesk('Spo', desks)).toBeNull();
  });
});

describe('snapToDesk — Levenshtein fallback', () => {
  it('catches a one-character typo', () => {
    expect(snapToDesk('Atvertising', desks)).toEqual(id('3'));
  });

  it('catches a two-character typo', () => {
    expect(snapToDesk('Adverttsng', desks)).toEqual(id('3'));
  });

  it("doesn't snap when the typo is large enough to be a different word", () => {
    expect(snapToDesk('Astrology', desks)).toBeNull();
  });
});

describe('snapToDesk — degenerate inputs', () => {
  it('returns null for empty / whitespace input', () => {
    expect(snapToDesk('', desks)).toBeNull();
    expect(snapToDesk('   ', desks)).toBeNull();
    expect(snapToDesk(null, desks)).toBeNull();
    expect(snapToDesk(undefined, desks)).toBeNull();
  });

  it('returns null when the desk list is empty (no vocabulary)', () => {
    expect(snapToDesk('anything', [])).toBeNull();
  });
});
