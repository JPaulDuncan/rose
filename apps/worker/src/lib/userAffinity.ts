import { Types } from 'mongoose';
import { MemoryGroup, MemoryComponent } from '@rose/db';
import { cosine } from './vec.js';

/**
 * User-affinity scoring — the personalization primitive that makes
 * Rose feel user-centric. Cosine-similarity against the user's
 * xMemory MemoryGroup centroids; returns 0..1 where higher means
 * "this looks like something the user cares about" based on the
 * atomic facts Rose has extracted from their archive.
 *
 * Designed against the echo-chamber tradeoffs called out in design:
 *
 *   • AFFINITY IS A WEIGHT, NOT A FILTER. Callers (home rankScore,
 *     daydream sweeper, library suggester) add it to existing
 *     signals; they never gate purely on it. Today's mail still
 *     surfaces regardless of affinity.
 *
 *   • CONFIDENCE FLOOR. Only contribute groups whose constituent
 *     components had confidence ≥ 0.5 on average. The extractor's
 *     low-confidence inferences (e.g. "user maybe likes hiking
 *     because page mentioned a trail") shouldn't drive ranking
 *     without stronger evidence.
 *
 *   • SIZE WEIGHTING. A group with 12 components is a stronger
 *     interest signal than a one-off. Multiply each group's
 *     centroid-similarity by sqrt(componentCount / totalComponents)
 *     so popular themes dominate without small groups dropping to
 *     zero.
 *
 *   • COLD-START SAFE. Zero groups → returns 0 for everything.
 *     Callers see no behavioural change.
 *
 *   • CACHING. The centroids load once per call site; callers
 *     scoring N pages should pass the loaded groups in rather than
 *     hitting Mongo per page. `loadUserAffinityProfile` returns the
 *     loaded shape; `affinityForCentroid` is the pure scorer.
 */

export type UserAffinityProfile = {
  groups: { centroid: number[]; weight: number; label: string }[];
  /** True when the user has zero qualifying user-fact groups — the
   *  caller can short-circuit and skip affinity scoring entirely. */
  empty: boolean;
};

/** Minimum average component confidence for a group to contribute.
 *  Below this we treat the group as "Rose's guess" and don't let it
 *  influence ranking. */
const MIN_GROUP_CONFIDENCE = 0.5;

export async function loadUserAffinityProfile(
  userId: Types.ObjectId,
): Promise<UserAffinityProfile> {
  // Only the 'user'-subject groups drive personalization — world-
  // facts are about subjects in the archive, not about the user
  // themselves. Boost-by-affinity would echo-chamber on subjects
  // the user already sees, defeating the point.
  const groups = (await MemoryGroup.find({ userId, subject: 'user' })
    .select('+centroid label componentCount')
    .lean()) as Array<{
    _id: Types.ObjectId;
    label: string;
    centroid: number[];
    componentCount: number;
  }>;
  if (groups.length === 0) return { groups: [], empty: true };

  // Compute average confidence per group from the component table.
  // One aggregation, cheap because (userId, groupId) is indexed.
  const avgs = await MemoryComponent.aggregate<{
    _id: Types.ObjectId;
    avg: number;
  }>([
    {
      $match: {
        userId,
        subject: 'user',
        status: 'active',
        groupId: { $in: groups.map((g) => g._id) },
      },
    },
    { $group: { _id: '$groupId', avg: { $avg: '$confidence' } } },
  ]);
  const avgById = new Map(avgs.map((r) => [String(r._id), r.avg]));

  const eligible = groups.filter(
    (g) => (avgById.get(String(g._id)) ?? 0) >= MIN_GROUP_CONFIDENCE,
  );
  if (eligible.length === 0) return { groups: [], empty: true };

  // Size weighting — sqrt so the difference between a 3-component
  // group and a 12-component one is meaningful but a 50-component
  // group doesn't swallow everything.
  const total = eligible.reduce((n, g) => n + Math.max(1, g.componentCount), 0);
  const profile = eligible.map((g) => ({
    centroid: g.centroid,
    label: g.label,
    weight: Math.sqrt(Math.max(1, g.componentCount) / total),
  }));
  return { groups: profile, empty: false };
}

/**
 * Score a single subject embedding against the profile. Returns
 * 0..1 where higher = stronger affinity.
 *
 * The score is `max(cos(subject, group.centroid) * group.weight)`
 * across groups, clamped to [0, 1]. Max rather than sum because a
 * subject that matches ONE group strongly is a clear hit; summing
 * across groups would dilute a strong single-theme match.
 */
export function affinityForCentroid(
  centroid: number[] | null | undefined,
  profile: UserAffinityProfile,
): number {
  if (!centroid || centroid.length === 0 || profile.empty) return 0;
  let best = 0;
  for (const g of profile.groups) {
    if (g.centroid.length !== centroid.length) continue;
    const sim = Math.max(0, cosine(centroid, g.centroid));
    const score = sim * g.weight;
    if (score > best) best = score;
  }
  return Math.min(1, best);
}

/**
 * Score a list of items by their topicCentroid in one pass. Cheap;
 * the dominant cost is the loaded profile (one Mongo round-trip)
 * plus N × K cosines where K = group count (typically < 20).
 */
export function rankByAffinity<T extends { topicCentroid?: number[] | null }>(
  items: readonly T[],
  profile: UserAffinityProfile,
): { item: T; affinity: number }[] {
  if (profile.empty) return items.map((item) => ({ item, affinity: 0 }));
  return items
    .map((item) => ({
      item,
      affinity: affinityForCentroid(item.topicCentroid ?? null, profile),
    }))
    .sort((a, b) => b.affinity - a.affinity);
}
