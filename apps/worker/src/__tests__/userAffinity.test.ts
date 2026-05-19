import { describe, it, expect } from 'vitest';
import {
  affinityForCentroid,
  rankByAffinity,
  type UserAffinityProfile,
} from '../lib/userAffinity.js';

/**
 * Pure scoring math for user-affinity. The Mongo-touching
 * `loadUserAffinityProfile` is integration territory; the scorer
 * + ranker are what need pinning. Also serves as the spec for the
 * inline API-side copy in apps/api/src/routes/digest.ts — if either
 * implementation drifts from the other, these tests catch the
 * surface-area part of the drift.
 */

function profile(
  ...groups: { centroid: number[]; weight: number }[]
): UserAffinityProfile {
  return {
    empty: groups.length === 0,
    groups: groups.map((g) => ({ ...g, label: 'test' })),
  };
}

describe('affinityForCentroid — degenerate inputs', () => {
  it('returns 0 for an empty profile', () => {
    expect(affinityForCentroid([1, 0, 0], profile())).toBe(0);
  });

  it('returns 0 when the subject has no centroid', () => {
    expect(
      affinityForCentroid(null, profile({ centroid: [1, 0], weight: 1 })),
    ).toBe(0);
    expect(
      affinityForCentroid([], profile({ centroid: [1, 0], weight: 1 })),
    ).toBe(0);
  });

  it('returns 0 when dimensions mismatch (defensive against schema drift)', () => {
    expect(
      affinityForCentroid([1, 0, 0], profile({ centroid: [1, 0], weight: 1 })),
    ).toBe(0);
  });
});

describe('affinityForCentroid — scoring', () => {
  it('scores 1.0 (capped) for a perfectly aligned single group at weight 1', () => {
    const score = affinityForCentroid(
      [1, 0, 0],
      profile({ centroid: [1, 0, 0], weight: 1 }),
    );
    expect(score).toBeCloseTo(1.0, 5);
  });

  it('scales linearly with weight when cosine is 1', () => {
    expect(
      affinityForCentroid(
        [1, 0, 0],
        profile({ centroid: [1, 0, 0], weight: 0.5 }),
      ),
    ).toBeCloseTo(0.5, 5);
    expect(
      affinityForCentroid(
        [1, 0, 0],
        profile({ centroid: [1, 0, 0], weight: 0.2 }),
      ),
    ).toBeCloseTo(0.2, 5);
  });

  it('scores 0 for an orthogonal subject (no semantic overlap)', () => {
    expect(
      affinityForCentroid(
        [1, 0, 0],
        profile({ centroid: [0, 1, 0], weight: 1 }),
      ),
    ).toBeCloseTo(0, 5);
  });

  it('clamps negative cosine to 0 (anti-correlated subjects do not subtract)', () => {
    // Cosine of (1,0) and (-1,0) is -1. We never want negative
    // affinity contributing — the design treats off-theme as
    // neutral, not penalising.
    expect(
      affinityForCentroid(
        [1, 0, 0],
        profile({ centroid: [-1, 0, 0], weight: 1 }),
      ),
    ).toBe(0);
  });

  it('picks the MAX matching group (single strong hit > diluted spread)', () => {
    // A subject perfectly matching one group should score that
    // group's weight, NOT some aggregate across groups.
    const score = affinityForCentroid(
      [1, 0, 0],
      profile(
        { centroid: [1, 0, 0], weight: 0.4 },
        { centroid: [0, 1, 0], weight: 0.6 },
      ),
    );
    expect(score).toBeCloseTo(0.4, 5);
  });

  it('clamps the final score to [0, 1]', () => {
    // Weight > 1 is invalid by construction but defensive coverage.
    const score = affinityForCentroid(
      [1, 0, 0],
      profile({ centroid: [1, 0, 0], weight: 1.5 }),
    );
    expect(score).toBe(1);
  });
});

describe('rankByAffinity', () => {
  it('passes through with affinity=0 for an empty profile (cold-start)', () => {
    const items = [
      { _id: 'a', topicCentroid: [1, 0] },
      { _id: 'b', topicCentroid: [0, 1] },
    ];
    const ranked = rankByAffinity(items, profile());
    expect(ranked.every((r) => r.affinity === 0)).toBe(true);
    // No reordering when the profile is empty.
    expect(ranked.map((r) => r.item._id)).toEqual(['a', 'b']);
  });

  it('sorts highest-affinity first', () => {
    const items = [
      { _id: 'low', topicCentroid: [0, 1, 0] },
      { _id: 'high', topicCentroid: [1, 0, 0] },
      { _id: 'mid', topicCentroid: [0.7, 0.7, 0] },
    ];
    const ranked = rankByAffinity(
      items,
      profile({ centroid: [1, 0, 0], weight: 1 }),
    );
    expect(ranked.map((r) => r.item._id)).toEqual(['high', 'mid', 'low']);
  });

  it('handles items with missing topicCentroid (score 0)', () => {
    const items = [
      { _id: 'a', topicCentroid: [1, 0, 0] },
      { _id: 'b' as const },
      { _id: 'c', topicCentroid: null as number[] | null },
    ];
    const ranked = rankByAffinity(
      items as Array<{ _id: string; topicCentroid?: number[] | null }>,
      profile({ centroid: [1, 0, 0], weight: 1 }),
    );
    expect(ranked[0]!.item._id).toBe('a');
    expect(ranked[0]!.affinity).toBeCloseTo(1, 5);
    // Items b and c both score 0; relative order is implementation-
    // defined (stable sort), assert only that they trail the
    // scored one.
    expect(ranked.slice(1).every((r) => r.affinity === 0)).toBe(true);
  });
});
