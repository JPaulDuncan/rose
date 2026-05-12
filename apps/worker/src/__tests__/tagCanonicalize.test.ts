import { describe, it, expect } from 'vitest';
import {
  trySuffixCollapse,
  tryEditDistance,
  boundedLevenshtein,
} from '../services/tagCanonicalize.js';

/**
 * The cascade pins. These rules decide how much LLM cost the
 * canonicaliser avoids on the common path — regressions here are
 * cost regressions. Real-shape fixtures only.
 */

describe('boundedLevenshtein', () => {
  it('returns 0 for identical strings', () => {
    expect(boundedLevenshtein('invoice', 'invoice', 2)).toBe(0);
  });

  it('returns the right distance for one edit', () => {
    expect(boundedLevenshtein('invoice', 'invoices', 2)).toBe(1);
    expect(boundedLevenshtein('color', 'colour', 2)).toBe(1);
  });

  it('bails early when the answer is over the threshold', () => {
    // 6 edits — much more than threshold 1
    expect(boundedLevenshtein('invoice', 'shipment', 1)).toBeGreaterThan(1);
  });

  it('handles length-mismatch via the shortcut', () => {
    expect(boundedLevenshtein('a', 'abcdef', 2)).toBeGreaterThan(2);
  });
});

describe('trySuffixCollapse', () => {
  const canonicals = new Set([
    'invoice',
    'remote-work',
    'company',
    'meeting',
    'job-listing',
    'category', // explicitly singular
  ]);
  const aliases = new Map<string, string>([
    ['receipts-2024', 'receipt'],
  ]);

  it('collapses plural -s to singular canonical', () => {
    expect(trySuffixCollapse('invoices', canonicals, aliases)).toBe('invoice');
    expect(trySuffixCollapse('meetings', canonicals, aliases)).toBe('meeting');
  });

  it('collapses plural -ies to -y singular', () => {
    expect(trySuffixCollapse('companies', canonicals, aliases)).toBe('company');
    expect(trySuffixCollapse('categories', canonicals, aliases)).toBe('category');
  });

  it('pluralises when canonical happened to be singular', () => {
    // canonical 'meeting' exists; if user emits 'meeting' it's a
    // direct hit upstream — this test exercises the inverse
    // direction where the canonical IS plural.
    const cans = new Set(['invoices']);
    expect(trySuffixCollapse('invoice', cans, new Map())).toBe('invoices');
  });

  it('rejects very-short stems to avoid news → ne', () => {
    const cans = new Set(['ne', 'bu']);
    expect(trySuffixCollapse('news', cans, new Map())).toBeNull();
    expect(trySuffixCollapse('bus', cans, new Map())).toBeNull();
  });

  it('falls back to the alias index when an alias matches', () => {
    expect(
      trySuffixCollapse('receipts-2024s', canonicals, aliases),
    ).toBe('receipt');
  });

  it('returns null when nothing close exists', () => {
    expect(
      trySuffixCollapse('helicopter-evac', canonicals, aliases),
    ).toBeNull();
  });
});

describe('tryEditDistance', () => {
  const canonicals = [
    'invoice',
    'remote-work',
    'machine-learning',
    'transcript',
    'restaurant',
  ];

  it('catches a one-character typo on a medium-length tag', () => {
    expect(tryEditDistance('imvoice', canonicals)).toBe('invoice');
  });

  it('catches a two-character variant on a long tag', () => {
    // remote-work vs remote-working = 3 edits, fails the threshold
    // (we want suffix collapse to handle that). But
    // remote-worke vs remote-work = 1 edit → matches.
    expect(tryEditDistance('remote-worke', canonicals)).toBe('remote-work');
  });

  it('refuses to match short tags below the threshold', () => {
    // Short tags are noisy — "ci" vs "cd" shouldn't match even
    // though it's 1 edit. We require exact match below 5 chars.
    expect(tryEditDistance('ci', ['cd'])).toBeNull();
  });

  it('returns null when nothing is within the threshold', () => {
    expect(tryEditDistance('helicopter-evac', canonicals)).toBeNull();
  });

  it('picks the closest canonical when multiple are within range', () => {
    // 'restaurand' is 1 from 'restaurant' and 5 from 'transcript'
    expect(tryEditDistance('restaurand', canonicals)).toBe('restaurant');
  });
});
