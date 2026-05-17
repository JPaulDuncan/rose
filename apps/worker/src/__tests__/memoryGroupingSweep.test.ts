import { describe, it, expect } from 'vitest';
import {
  centroidOf,
  medianPairwiseCosine,
  twoMeansSplit,
} from '../services/memoryGroupingSweep.js';

/**
 * The pure helpers in the grouping sweeper. `runMemoryGroupingForUser`
 * itself touches Mongo + the LLM provider so we skip it here; the
 * math underneath is what's worth pinning.
 */

describe('centroidOf', () => {
  it('returns the empty array on no inputs', () => {
    expect(centroidOf([])).toEqual([]);
  });

  it('returns the input vector when there is exactly one', () => {
    expect(centroidOf([[1, 2, 3]])).toEqual([1, 2, 3]);
  });

  it('averages componentwise', () => {
    const out = centroidOf([
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]);
    expect(out).toEqual([1 / 3, 1 / 3, 1 / 3]);
  });

  it('handles negative components correctly', () => {
    expect(centroidOf([
      [-1, 1],
      [1, -1],
    ])).toEqual([0, 0]);
  });
});

describe('medianPairwiseCosine', () => {
  it('returns 1 for a single-element set (degenerate cohesion)', () => {
    expect(medianPairwiseCosine([[1, 0]])).toBe(1);
  });

  it('returns 1 for identical vectors', () => {
    expect(
      medianPairwiseCosine([
        [1, 0, 0],
        [1, 0, 0],
        [1, 0, 0],
      ]),
    ).toBeCloseTo(1);
  });

  it('returns ~0 for orthogonal vectors', () => {
    const out = medianPairwiseCosine([
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]);
    expect(out).toBeCloseTo(0);
  });

  it('returns the median, not the mean, when an outlier is present', () => {
    // Three vectors: A,B aligned; C orthogonal. Pairs sims: (A,B)=1,
    // (A,C)=0, (B,C)=0 → sorted [0, 0, 1] → median = 0. Mean would be
    // 0.33 which would mask the outlier.
    expect(
      medianPairwiseCosine([
        [1, 0],
        [1, 0],
        [0, 1],
      ]),
    ).toBeCloseTo(0);
  });
});

describe('twoMeansSplit', () => {
  it('returns a degenerate split for n < 2', () => {
    expect(twoMeansSplit([])).toEqual([[], []]);
    expect(twoMeansSplit([[1, 0]])).toEqual([[0], []]);
  });

  it('cleanly separates two distant clusters', () => {
    // Two clear clusters: three near [1,0], three near [0,1].
    const vectors = [
      [1, 0],
      [0.9, 0.1],
      [0.95, 0.05],
      [0, 1],
      [0.1, 0.9],
      [0.05, 0.95],
    ];
    const [a, b] = twoMeansSplit(vectors);
    expect(a.length + b.length).toBe(6);
    const aIs = new Set(a);
    // Either {0,1,2} on one side and {3,4,5} on the other, or the
    // reverse — both are correct splits.
    const cleanForwards =
      aIs.has(0) && aIs.has(1) && aIs.has(2) && !aIs.has(3) && !aIs.has(4) && !aIs.has(5);
    const cleanReverse =
      aIs.has(3) && aIs.has(4) && aIs.has(5) && !aIs.has(0) && !aIs.has(1) && !aIs.has(2);
    expect(cleanForwards || cleanReverse).toBe(true);
  });

  it("doesn't crash on dimension-zero vectors", () => {
    // If somehow we get called with empty embeddings (e.g. provider
    // returned []), the split returns whatever; just don't throw.
    expect(() => twoMeansSplit([[], []])).not.toThrow();
  });
});
