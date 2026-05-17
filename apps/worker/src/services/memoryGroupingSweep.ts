import { Types } from 'mongoose';
import { MemoryComponent, MemoryGroup, User } from '@rose/db';
import { resolveProviderForUser } from '../lib/providers.js';
import { cosine } from '../lib/vec.js';
import { logger } from '../lib/logger.js';

/**
 * xMemory grouping sweeper. Runs the four maintenance operations
 * from the paper's section 3.1 against a single user's
 * MemoryComponent collection:
 *
 *   1. **Embed** any newly-extracted components whose `embedding`
 *      is null. Batched per user — single provider session, all
 *      pending components for that user in one pass.
 *   2. **Attach** each ungrouped component to its nearest group
 *      (or create a new group when no group is close enough).
 *   3. **Split** any group that has grown past MAX_GROUP_SIZE OR
 *      whose internal cohesion has dropped below SPLIT_COHESION
 *      using a 2-means split. Re-label both halves.
 *   4. **Merge** any pair of groups whose centroids are closer
 *      than MERGE_DISTANCE.
 *
 * Plus: refresh `neighborGroupIds` (the Stage I kNN links from the
 * paper) on every group so the retrieval helper has a current
 * neighbourhood map.
 *
 * Idempotent and incremental. Runs on a 5-minute setInterval (see
 * `startMemoryGroupingSweeper`) so a burst of page generation
 * doesn't keep the user's "What Rose knows" view stale for long.
 */

/** Cosine ≥ this to attach to an existing group. Below → new group. */
const ATTACH_THRESHOLD = 0.65;
/** Above this many components in a group, consider splitting. */
const MAX_GROUP_SIZE = 30;
/** Below this median pairwise cosine, consider splitting (semantic-
 *  coherence floor — adapted from the paper's `g(s_k)` shape). */
const SPLIT_COHESION = 0.45;
/** Two group centroids closer than this in cosine distance get
 *  merged. Tighter than ATTACH_THRESHOLD because merging is a more
 *  consequential operation. */
const MERGE_DISTANCE = 0.85;
/** kNN size for the Stage I navigation links. */
const NEIGHBOR_K = 5;

type ComponentRow = {
  _id: Types.ObjectId;
  text: string;
  type: string;
  subject: 'user' | 'world';
  embedding?: number[] | null;
  groupId?: Types.ObjectId | null;
};

type GroupRow = {
  _id: Types.ObjectId;
  label: string;
  subject: 'user' | 'world';
  centroid: number[];
  componentCount: number;
  neighborGroupIds: Types.ObjectId[];
};

/**
 * Pull components missing embeddings and embed them in one call.
 * Returns the number embedded.
 */
async function embedPendingComponents(userId: Types.ObjectId): Promise<number> {
  const pending = await MemoryComponent.find({
    userId,
    status: 'active',
    embedding: null,
  })
    .select('+embedding text')
    .limit(200)
    .lean();
  if (pending.length === 0) return 0;
  let resolved;
  try {
    resolved = await resolveProviderForUser(userId, 'embedding');
  } catch (err) {
    logger.warn({ err }, 'memory-grouping: embed provider unavailable');
    return 0;
  }
  let embedded = 0;
  for (const c of pending) {
    try {
      const vec = await resolved.provider.embed(resolved.model, c.text);
      await MemoryComponent.updateOne(
        { _id: c._id },
        { $set: { embedding: vec, embeddingModel: resolved.model } },
      );
      embedded += 1;
    } catch (err) {
      logger.debug(
        { err, componentId: String(c._id) },
        'memory-grouping: embed failed (continuing)',
      );
    }
  }
  return embedded;
}

/** Compute the centroid (componentwise mean) of N same-length vectors. */
export function centroidOf(vectors: number[][]): number[] {
  if (vectors.length === 0) return [];
  const dim = vectors[0]!.length;
  const out = new Array(dim).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < dim; i += 1) out[i] += v[i]!;
  }
  for (let i = 0; i < dim; i += 1) out[i] /= vectors.length;
  return out;
}

/** Median pairwise cosine within a vector set. Cheap proxy for
 *  intra-group coherence — when it falls below SPLIT_COHESION the
 *  group is mixed enough to warrant a split. */
export function medianPairwiseCosine(vectors: number[][]): number {
  if (vectors.length < 2) return 1;
  const sims: number[] = [];
  // Cap pairs evaluated at 200 to bound cost on large groups; a
  // group big enough to overflow this cap is already split-bound.
  for (let i = 0; i < vectors.length && sims.length < 200; i += 1) {
    for (let j = i + 1; j < vectors.length && sims.length < 200; j += 1) {
      sims.push(cosine(vectors[i]!, vectors[j]!));
    }
  }
  sims.sort((a, b) => a - b);
  return sims[Math.floor(sims.length / 2)] ?? 1;
}

/** LLM-derived theme label given representative components. */
async function labelGroup(
  userId: Types.ObjectId,
  representatives: { text: string; type: string }[],
): Promise<string | null> {
  if (representatives.length === 0) return null;
  let resolved;
  try {
    resolved = await resolveProviderForUser(userId, 'generation');
  } catch {
    return null;
  }
  const prompt = [
    'These are atomic facts Rose has learned about the user.',
    'Write a 2–5 word THEME label that captures what they share.',
    'Examples: "Travel preferences", "Health constraints", "Family relationships",',
    '"Coffee and tea habits", "Active subscriptions". Plain title case, no punctuation.',
    '',
    'Facts:',
    ...representatives.slice(0, 6).map((r) => `- (${r.type}) ${r.text}`),
    '',
    'Output ONLY the label, nothing else.',
  ].join('\n');
  try {
    const raw = await resolved.provider.generate({
      model: resolved.model,
      prompt,
      system: 'You name themes concisely. No quotes, no punctuation, 2–5 words.',
      temperature: 0.2,
      maxTokens: 32,
    });
    const cleaned = raw.replace(/^["'\s]+|["'\s.]+$/g, '').slice(0, 120);
    return cleaned || null;
  } catch {
    return null;
  }
}

/** Two-means split of an embedding set. Returns the two cluster
 *  assignments by component index. Naive Lloyd's algorithm — for
 *  ≤ MAX_GROUP_SIZE points this converges in a handful of passes
 *  and the cost is negligible compared to the LLM label calls. */
export function twoMeansSplit(vectors: number[][]): [number[], number[]] {
  const n = vectors.length;
  if (n < 2) return [Array.from({ length: n }, (_, i) => i), []];
  // Seed with the two most-distant points (poor-man's k-means++).
  let aSeed = 0;
  let bSeed = 1;
  let worstSim = 1;
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const s = cosine(vectors[i]!, vectors[j]!);
      if (s < worstSim) {
        worstSim = s;
        aSeed = i;
        bSeed = j;
      }
    }
  }
  let centA = vectors[aSeed]!.slice();
  let centB = vectors[bSeed]!.slice();
  let assignA: number[] = [];
  let assignB: number[] = [];
  for (let iter = 0; iter < 20; iter += 1) {
    const nextA: number[] = [];
    const nextB: number[] = [];
    for (let i = 0; i < n; i += 1) {
      if (cosine(vectors[i]!, centA) >= cosine(vectors[i]!, centB)) nextA.push(i);
      else nextB.push(i);
    }
    const stable =
      nextA.length === assignA.length &&
      nextA.every((v, idx) => v === assignA[idx]);
    assignA = nextA;
    assignB = nextB;
    if (stable) break;
    centA = centroidOf(assignA.map((i) => vectors[i]!));
    centB = centroidOf(assignB.map((i) => vectors[i]!));
    if (centA.length === 0 || centB.length === 0) break;
  }
  return [assignA, assignB];
}

async function refreshNeighbors(userId: Types.ObjectId): Promise<void> {
  const groups = (await MemoryGroup.find({ userId })
    .select('+centroid')
    .lean()) as GroupRow[];
  if (groups.length < 2) {
    if (groups[0]) {
      await MemoryGroup.updateOne(
        { _id: groups[0]._id },
        { $set: { neighborGroupIds: [] } },
      );
    }
    return;
  }
  for (const g of groups) {
    const scored = groups
      .filter(
        (other) =>
          !other._id.equals(g._id) &&
          other.subject === g.subject &&
          other.centroid.length === g.centroid.length,
      )
      .map((other) => ({ id: other._id, sim: cosine(g.centroid, other.centroid) }))
      .sort((a, b) => b.sim - a.sim)
      .slice(0, NEIGHBOR_K)
      .map((r) => r.id);
    await MemoryGroup.updateOne(
      { _id: g._id },
      { $set: { neighborGroupIds: scored } },
    );
  }
}

/** Run all four ops for one user. Exposed so an admin endpoint /
 *  test harness can trigger a sweep on demand without waiting for
 *  the timer. Returns a small summary for logs / metrics. */
export async function runMemoryGroupingForUser(
  userId: Types.ObjectId,
): Promise<{
  embedded: number;
  attached: number;
  created: number;
  split: number;
  merged: number;
}> {
  const summary = { embedded: 0, attached: 0, created: 0, split: 0, merged: 0 };
  summary.embedded = await embedPendingComponents(userId);

  // Reload state after embedding so attach has fresh vectors.
  const ungrouped = (await MemoryComponent.find({
    userId,
    status: 'active',
    groupId: null,
    embedding: { $ne: null },
  })
    .select('+embedding text type subject')
    .lean()) as ComponentRow[];

  let groups = (await MemoryGroup.find({ userId })
    .select('+centroid')
    .lean()) as GroupRow[];

  // ── Attach ─────────────────────────────────────────────────
  // Subject constraint: a 'user' component can only join a 'user'
  // group; same for 'world'. This is the homogeneity invariant —
  // downstream consumers filter by subject and trust the group
  // boundary, so a mixed group would leak world-facts into the
  // "what Rose knows about you" surface.
  for (const c of ungrouped) {
    if (!c.embedding) continue;
    let bestId: Types.ObjectId | null = null;
    let bestSim = 0;
    for (const g of groups) {
      if (g.subject !== c.subject) continue;
      if (g.centroid.length !== c.embedding.length) continue;
      const sim = cosine(c.embedding, g.centroid);
      if (sim > bestSim) {
        bestSim = sim;
        bestId = g._id;
      }
    }
    if (bestId && bestSim >= ATTACH_THRESHOLD) {
      await MemoryComponent.updateOne(
        { _id: c._id },
        { $set: { groupId: bestId } },
      );
      summary.attached += 1;
    } else {
      // Create a fresh group seeded by this component. The
      // subject inherits from the seeding component so subsequent
      // attaches respect the homogeneity invariant.
      const label =
        (await labelGroup(userId, [{ text: c.text, type: c.type }])) ?? 'Misc';
      const created = await MemoryGroup.create({
        userId,
        subject: c.subject,
        label,
        centroid: c.embedding,
        componentCount: 1,
        lastAttachAt: new Date(),
      });
      await MemoryComponent.updateOne(
        { _id: c._id },
        { $set: { groupId: created._id } },
      );
      groups = [
        ...groups,
        {
          _id: created._id,
          label: created.label,
          subject: c.subject,
          centroid: c.embedding,
          componentCount: 1,
          neighborGroupIds: [],
        },
      ];
      summary.created += 1;
    }
  }

  // Recompute centroids + counts on touched groups before split/merge.
  await recomputeAllCentroids(userId);
  groups = (await MemoryGroup.find({ userId })
    .select('+centroid')
    .lean()) as GroupRow[];

  // ── Split ──────────────────────────────────────────────────
  for (const g of groups) {
    if (g.componentCount < 6) continue;
    const members = (await MemoryComponent.find({
      userId,
      groupId: g._id,
      status: 'active',
    })
      .select('+embedding text type')
      .lean()) as ComponentRow[];
    const vectors = members
      .filter((m) => m.embedding && m.embedding.length === g.centroid.length)
      .map((m) => m.embedding!);
    if (vectors.length < 6) continue;
    const cohesion = medianPairwiseCosine(vectors);
    if (g.componentCount <= MAX_GROUP_SIZE && cohesion >= SPLIT_COHESION) continue;
    // Split.
    const [idxA, idxB] = twoMeansSplit(vectors);
    if (idxA.length === 0 || idxB.length === 0) continue;
    const labelA =
      (await labelGroup(
        userId,
        idxA.slice(0, 6).map((i) => ({ text: members[i]!.text, type: members[i]!.type })),
      )) ?? g.label;
    const labelB =
      (await labelGroup(
        userId,
        idxB.slice(0, 6).map((i) => ({ text: members[i]!.text, type: members[i]!.type })),
      )) ?? `${g.label} (B)`;
    const centA = centroidOf(idxA.map((i) => vectors[i]!));
    const centB = centroidOf(idxB.map((i) => vectors[i]!));
    // Reuse the existing group as cluster A; create a new one for B.
    await MemoryGroup.updateOne(
      { _id: g._id },
      {
        $set: {
          label: labelA,
          centroid: centA,
          componentCount: idxA.length,
          lastReshapeAt: new Date(),
        },
      },
    );
    const groupB = await MemoryGroup.create({
      userId,
      subject: g.subject,
      label: labelB,
      centroid: centB,
      componentCount: idxB.length,
      lastReshapeAt: new Date(),
    });
    for (const i of idxB) {
      await MemoryComponent.updateOne(
        { _id: members[i]!._id },
        { $set: { groupId: groupB._id } },
      );
    }
    summary.split += 1;
  }

  // ── Merge ──────────────────────────────────────────────────
  groups = (await MemoryGroup.find({ userId })
    .select('+centroid')
    .lean()) as GroupRow[];
  const merged = new Set<string>();
  for (let i = 0; i < groups.length; i += 1) {
    const gi = groups[i]!;
    if (merged.has(String(gi._id))) continue;
    for (let j = i + 1; j < groups.length; j += 1) {
      const gj = groups[j]!;
      if (merged.has(String(gj._id))) continue;
      if (gi.subject !== gj.subject) continue;
      if (gi.centroid.length !== gj.centroid.length) continue;
      const sim = cosine(gi.centroid, gj.centroid);
      if (sim < MERGE_DISTANCE) continue;
      // Merge gj into gi.
      await MemoryComponent.updateMany(
        { userId, groupId: gj._id },
        { $set: { groupId: gi._id } },
      );
      await MemoryGroup.deleteOne({ _id: gj._id });
      merged.add(String(gj._id));
      summary.merged += 1;
    }
  }

  await recomputeAllCentroids(userId);
  await refreshNeighbors(userId);
  return summary;
}

/** Recompute each group's centroid + componentCount from its
 *  current members. Called after any structural change so the
 *  attach/split/merge thresholds always read fresh state. */
async function recomputeAllCentroids(userId: Types.ObjectId): Promise<void> {
  const groups = await MemoryGroup.find({ userId }).select('_id').lean();
  for (const g of groups) {
    const members = (await MemoryComponent.find({
      userId,
      groupId: g._id,
      status: 'active',
    })
      .select('+embedding')
      .lean()) as ComponentRow[];
    const vectors = members
      .filter((m) => m.embedding && m.embedding.length > 0)
      .map((m) => m.embedding!);
    if (vectors.length === 0) {
      // Empty group → delete. Components were moved or marked rejected.
      await MemoryGroup.deleteOne({ _id: g._id });
      continue;
    }
    const centroid = centroidOf(vectors);
    await MemoryGroup.updateOne(
      { _id: g._id },
      { $set: { centroid, componentCount: vectors.length } },
    );
  }
}

const SWEEP_INTERVAL_MS = 5 * 60_000;

/**
 * Periodic sweep — picks every user with at least one ungrouped
 * memory component and runs a maintenance pass. Cheap when there's
 * nothing to do (a single indexed lookup). The setInterval is
 * declared in @rose/shared's SWEEPER_CATALOG so it surfaces on the
 * admin cron-jobs view.
 */
export function startMemoryGroupingSweeper(): { stop: () => void } {
  let busy = false;
  const handle = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const due = await MemoryComponent.aggregate<{ _id: Types.ObjectId }>([
        { $match: { status: 'active', groupId: null } },
        { $group: { _id: '$userId' } },
        { $limit: 50 },
      ]);
      for (const row of due) {
        try {
          // Sanity-check the user still exists — otherwise we'd
          // burn embed calls on rows for a deleted account.
          const user = await User.findById(row._id).select('_id').lean();
          if (!user) continue;
          const summary = await runMemoryGroupingForUser(row._id);
          if (
            summary.attached +
              summary.created +
              summary.split +
              summary.merged >
            0
          ) {
            logger.info(
              { userId: String(row._id), ...summary },
              'memory-grouping: swept',
            );
          }
        } catch (err) {
          logger.warn(
            { err, userId: String(row._id) },
            'memory-grouping: per-user sweep failed (continuing)',
          );
        }
      }
    } catch (err) {
      logger.warn({ err }, 'memory-grouping: sweep tick failed');
    } finally {
      busy = false;
    }
  }, SWEEP_INTERVAL_MS);
  handle.unref?.();
  return {
    stop: () => clearInterval(handle),
  };
}
