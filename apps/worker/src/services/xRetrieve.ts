import { Types } from 'mongoose';
import { MemoryComponent, MemoryGroup } from '@rose/db';
import { resolveProviderForUser } from '../lib/providers.js';
import { cosine } from '../lib/vec.js';
import { logger } from '../lib/logger.js';

/**
 * xMemory's two-stage retrieval (arXiv:2602.02007) over the
 * user-facts substrate.  Returns at most `maxComponents` atomic
 * claims relevant to the query, picked to *cover* the relevant
 * theme regions rather than pile up near-duplicates.
 *
 * Stage I is implemented here: greedy-coverage selection over
 * MemoryGroup centroids, walking the kNN neighbour links each
 * group maintains so we discover related theme regions instead
 * of just re-picking similar groups.  At each step we trade off
 *
 *     score(i) = (1/Z) · Σ_{u ∈ ΔNeighbours(i; R)} w_iu  +  s̃(q, i)
 *
 * where ΔNeighbours(i; R) is the set of neighbours i would newly
 * cover if added to the selection R.  The first term rewards
 * *complementary* selections; the second keeps the selection
 * relevant to the query.
 *
 * Stage II in the paper expands to raw text only when uncertainty
 * drops.  We elide it for v1 — the consumer (daydream context
 * builder) needs a small fixed-budget set of claims, not an
 * uncertainty-driven expansion.  When/if a chat-RAG consumer needs
 * full Stage II, the implementation lives in this same file.
 */

export type XRetrieveOpts = {
  /** Hard cap on returned components. Default 5. */
  maxComponents?: number;
  /** Hard cap on candidate groups Stage I considers. Default 8. */
  groupCandidatePool?: number;
  /** Weight on the coverage term vs the raw similarity term. The
   *  paper uses 1:1; we default to 0.5 so similarity dominates a
   *  bit — coverage is a tiebreaker between equally-relevant
   *  candidates, not the primary signal. */
  coverageWeight?: number;
};

export type RetrievedComponent = {
  id: string;
  text: string;
  type: string;
  groupId: string | null;
  groupLabel: string | null;
  similarity: number;
};

type GroupRow = {
  _id: Types.ObjectId;
  label: string;
  centroid: number[];
  componentCount: number;
  neighborGroupIds: Types.ObjectId[];
};

type ComponentRow = {
  _id: Types.ObjectId;
  text: string;
  type: string;
  embedding?: number[] | null;
  groupId?: Types.ObjectId | null;
};

/**
 * Run Stage I greedy-coverage and return the selected components.
 * Cheap-paths:
 *   • No active components → return [] without embedding the query.
 *   • Components exist but none have embeddings yet → fall back to
 *     similarity-naïve recency order.
 */
export async function xRetrieveUserFacts(
  userId: Types.ObjectId,
  query: string,
  opts: XRetrieveOpts = {},
): Promise<RetrievedComponent[]> {
  const maxComponents = opts.maxComponents ?? 5;
  const groupCandidatePool = opts.groupCandidatePool ?? 8;
  const coverageWeight = opts.coverageWeight ?? 0.5;

  // Cheap existence gate — no embed call if there's nothing to retrieve.
  const candidateCount = await MemoryComponent.countDocuments({
    userId,
    status: 'active',
  });
  if (candidateCount === 0) return [];

  // Embed the query once.
  let queryVec: number[];
  try {
    const resolved = await resolveProviderForUser(userId, 'embedding');
    queryVec = await resolved.provider.embed(resolved.model, query);
  } catch (err) {
    logger.warn({ err }, 'xRetrieveUserFacts: embed provider unavailable');
    return [];
  }
  if (!queryVec.length) return [];

  const groups = (await MemoryGroup.find({ userId })
    .select('+centroid')
    .lean()) as GroupRow[];

  if (groups.length === 0) {
    // No groups yet (sweeper hasn't run). Fall back to direct
    // top-K over components.
    return topKComponents(userId, queryVec, maxComponents);
  }

  // Score every group by query→centroid cosine; pool the top N.
  const groupScores = groups
    .filter((g) => g.centroid.length === queryVec.length)
    .map((g) => ({ g, sim: cosine(queryVec, g.centroid) }))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, groupCandidatePool);

  if (groupScores.length === 0) return [];

  // Build the neighbourhood map: groupId → set of neighbour group
  // IDs (from the sweeper-maintained kNN links). Restricted to the
  // candidate pool — neighbours outside the pool don't earn coverage
  // points (they wouldn't be examined anyway).
  const inPool = new Set(groupScores.map((s) => String(s.g._id)));
  const neighbours = new Map<string, Set<string>>();
  for (const { g } of groupScores) {
    const set = new Set<string>();
    for (const nid of g.neighborGroupIds ?? []) {
      const k = String(nid);
      if (inPool.has(k)) set.add(k);
    }
    neighbours.set(String(g._id), set);
  }

  // Greedy-coverage selection over the candidate groups.
  const selected: string[] = [];
  const covered = new Set<string>();
  const maxGroups = Math.min(maxComponents, groupScores.length);
  while (selected.length < maxGroups) {
    let bestIdx = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < groupScores.length; i += 1) {
      const key = String(groupScores[i]!.g._id);
      if (selected.includes(key)) continue;
      const sim = Math.max(0, groupScores[i]!.sim);
      // Coverage delta: this group itself + its neighbours that
      // aren't yet covered.
      let delta = covered.has(key) ? 0 : 1;
      for (const n of neighbours.get(key) ?? []) {
        if (!covered.has(n)) delta += 1;
      }
      const coverageNorm = delta / Math.max(1, groupScores.length);
      const score = coverageWeight * coverageNorm + sim;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) break;
    const pick = groupScores[bestIdx]!;
    const key = String(pick.g._id);
    selected.push(key);
    covered.add(key);
    for (const n of neighbours.get(key) ?? []) covered.add(n);
  }

  // Pick best components from each selected group. Pull all
  // components in the selected groups in one query, then per-group
  // rank by component→query cosine.
  const components = (await MemoryComponent.find({
    userId,
    status: 'active',
    groupId: { $in: selected.map((id) => new Types.ObjectId(id)) },
  })
    .select('+embedding text type groupId')
    .lean()) as ComponentRow[];

  // Group → components map for per-group ranking.
  const byGroup = new Map<string, ComponentRow[]>();
  for (const c of components) {
    if (!c.groupId) continue;
    const k = String(c.groupId);
    const arr = byGroup.get(k) ?? [];
    arr.push(c);
    byGroup.set(k, arr);
  }

  // Pull at most ceil(maxComponents / selected.length) per group,
  // then top up by raw similarity if we're short.
  const perGroup = Math.max(1, Math.ceil(maxComponents / Math.max(1, selected.length)));
  const groupLabelById = new Map(groupScores.map((s) => [String(s.g._id), s.g.label]));
  const picked: RetrievedComponent[] = [];
  for (const gid of selected) {
    const arr = byGroup.get(gid) ?? [];
    const scored = arr
      .filter((c) => c.embedding && c.embedding.length === queryVec.length)
      .map((c) => ({ c, sim: cosine(queryVec, c.embedding!) }))
      .sort((a, b) => b.sim - a.sim)
      .slice(0, perGroup);
    for (const { c, sim } of scored) {
      picked.push({
        id: String(c._id),
        text: c.text,
        type: c.type,
        groupId: gid,
        groupLabel: groupLabelById.get(gid) ?? null,
        similarity: sim,
      });
    }
  }

  // Top up if we're under budget — pick remaining best components
  // across the whole pool by similarity.
  if (picked.length < maxComponents) {
    const seenIds = new Set(picked.map((p) => p.id));
    const remaining = components
      .filter((c) => !seenIds.has(String(c._id)))
      .filter((c) => c.embedding && c.embedding.length === queryVec.length)
      .map((c) => ({ c, sim: cosine(queryVec, c.embedding!) }))
      .sort((a, b) => b.sim - a.sim)
      .slice(0, maxComponents - picked.length);
    for (const { c, sim } of remaining) {
      picked.push({
        id: String(c._id),
        text: c.text,
        type: c.type,
        groupId: c.groupId ? String(c.groupId) : null,
        groupLabel: c.groupId ? (groupLabelById.get(String(c.groupId)) ?? null) : null,
        similarity: sim,
      });
    }
  }

  return picked.slice(0, maxComponents).sort((a, b) => b.similarity - a.similarity);
}

/** Direct top-K fallback used before the sweeper has built any
 *  groups. Same return shape as the greedy path. */
async function topKComponents(
  userId: Types.ObjectId,
  queryVec: number[],
  max: number,
): Promise<RetrievedComponent[]> {
  const all = (await MemoryComponent.find({ userId, status: 'active' })
    .select('+embedding text type groupId')
    .limit(500)
    .lean()) as ComponentRow[];
  return all
    .filter((c) => c.embedding && c.embedding.length === queryVec.length)
    .map((c) => ({
      id: String(c._id),
      text: c.text,
      type: c.type,
      groupId: c.groupId ? String(c.groupId) : null,
      groupLabel: null,
      similarity: cosine(queryVec, c.embedding!),
    }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, max);
}

/** Pure scoring helper — exposed for unit testing the greedy step
 *  without spinning up Mongo + an embed provider. */
export function greedyCoverScore(
  candidateKey: string,
  candidateSim: number,
  alreadyCovered: ReadonlySet<string>,
  candidateNeighbours: ReadonlySet<string>,
  poolSize: number,
  coverageWeight: number,
): number {
  let delta = alreadyCovered.has(candidateKey) ? 0 : 1;
  for (const n of candidateNeighbours) {
    if (!alreadyCovered.has(n)) delta += 1;
  }
  const coverageNorm = delta / Math.max(1, poolSize);
  return coverageWeight * coverageNorm + Math.max(0, candidateSim);
}
