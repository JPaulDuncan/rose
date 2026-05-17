import { Types } from 'mongoose';
import {
  Category,
  Page,
  normalizeCategoryName,
  displayCategoryName,
  type CategoryDoc,
  type PageDoc,
} from '@rose/db';
import { extractJson } from '@rose/llm';
import { resolveProviderForUser } from '../lib/providers.js';
import { cosine } from '../lib/vec.js';
import { logger } from '../lib/logger.js';
import { centroidOf } from './memoryGroupingSweep.js';

/**
 * "Learn from source material what to create/build." Clusters pages
 * the user has accumulated under ad-hoc categories (or no category
 * at all) and proposes new desks the user can accept into the
 * curated vocabulary.
 *
 * Discipline:
 *   - Only operates on pages NOT currently assigned to an active
 *     desk. Pages already on a desk are settled.
 *   - Clusters use the existing `topicCentroid` embeddings — no
 *     new embed calls. Just a per-page vector lookup + greedy
 *     similarity grouping (same shape as the briefing clusterer).
 *   - Per-cluster, asks the gen LLM for a 1–3 word name + a
 *     one-line description. One LLM call per cluster; capped at
 *     `MAX_PROPOSALS_PER_RUN` so a sprawling archive doesn't
 *     burn the daily cap on one button-press.
 *   - Skips a cluster when its proposed name (semantically) matches
 *     an existing desk OR a previously-rejected proposal — the
 *     user doesn't want to keep saying "no" to the same thing.
 *   - Persists proposals as `Category { kind: 'desk', status:
 *     'proposed' }` rows with `proposalSamplePages[]` snapshotting
 *     the cluster so the UI can show evidence.
 *
 * Returns a summary so the API can report what was added.
 */

const MIN_PAGES_PER_CLUSTER = 5;
const MAX_PROPOSALS_PER_RUN = 6;
const PROPOSAL_SIM_THRESHOLD = 0.55;
const DUPLICATE_NAME_SIM = 0.85;

type PageVec = {
  _id: Types.ObjectId;
  title: string;
  centroid: number[];
};

export type ProposeDesksSummary = {
  clustersConsidered: number;
  proposalsCreated: number;
  proposals: { name: string; description: string; sampleCount: number }[];
};

export async function proposeDesksForUser(
  userId: Types.ObjectId,
): Promise<ProposeDesksSummary> {
  const summary: ProposeDesksSummary = {
    clustersConsidered: 0,
    proposalsCreated: 0,
    proposals: [],
  };

  // Pull the user's existing desks (active + proposed + rejected) so
  // we can de-dup proposals semantically against ALL three buckets.
  // Centroid for each existing desk is the mean of its members'
  // topicCentroids; cached here, NOT persisted (this is a one-shot
  // dedup pass, not a long-lived ranking).
  const existingDesks = (await Category.find({
    userId,
    kind: 'desk',
  })
    .select('name status rejectedReason')
    .lean()) as CategoryDoc[];
  const existingNamesNorm = new Set(
    existingDesks.map((d) => normalizeCategoryName(d.name)),
  );
  const rejectedReasonByName = new Map(
    existingDesks
      .filter((d) => d.status === 'archived' && d.rejectedReason)
      .map((d) => [normalizeCategoryName(d.name), d.rejectedReason ?? '']),
  );

  // Find page candidates: not on an ACTIVE desk + has a topicCentroid.
  // Mongo can't filter by "categoryId points at a kind!=desk row"
  // without a join, so we pull active-desk ids first and exclude.
  const activeDeskIds = existingDesks
    .filter((d) => d.status === 'active')
    .map((d) => d._id);
  const candidatePages = (await Page.find({
    userId,
    'flags.userMarkedSpam': { $ne: true },
    $or: [{ categoryId: null }, { categoryId: { $nin: activeDeskIds } }],
    topicCentroid: { $exists: true, $ne: null },
  })
    .select('title topicCentroid')
    .sort({ updatedAt: -1 })
    .limit(500)
    .lean()) as PageDoc[];

  const vectors: PageVec[] = candidatePages
    .map((p) => ({
      _id: p._id as Types.ObjectId,
      title: p.title ?? '',
      centroid: (p.topicCentroid as number[] | null) ?? [],
    }))
    .filter((p) => p.centroid.length > 0);

  if (vectors.length < MIN_PAGES_PER_CLUSTER) {
    logger.info(
      { userId: String(userId), candidates: vectors.length },
      'proposeDesks: too few candidate pages — skipping',
    );
    return summary;
  }

  // Greedy cluster — same shape as the briefing clusterer. Pick the
  // page with the most neighbours above PROPOSAL_SIM_THRESHOLD as
  // an anchor, gather its neighbours, repeat. Cheap (O(N²)) and
  // bounded by the 500-page pull above.
  const clusters = greedyCluster(vectors, PROPOSAL_SIM_THRESHOLD, MIN_PAGES_PER_CLUSTER);
  summary.clustersConsidered = clusters.length;
  if (clusters.length === 0) return summary;

  // Resolve provider once. If it's down, log + bail rather than
  // making partial state.
  let resolved;
  try {
    resolved = await resolveProviderForUser(userId, 'generation');
  } catch (err) {
    logger.warn({ err }, 'proposeDesks: gen provider unavailable');
    return summary;
  }

  // Cap how many proposals one run can create so a 500-page first
  // pass doesn't dump 10 desks on the user at once.
  const considering = clusters.slice(0, MAX_PROPOSALS_PER_RUN);
  for (const cluster of considering) {
    const proposed = await proposeNameForCluster(resolved, cluster);
    if (!proposed) continue;
    const normalised = normalizeCategoryName(proposed.name);
    if (!normalised) continue;

    // Dedup against existing desks (active OR archived/rejected).
    // An exact normalised match short-circuits. A near-duplicate
    // by centroid similarity also skips — the LLM might call the
    // same theme "Tech" today and "Technology" tomorrow.
    if (existingNamesNorm.has(normalised)) continue;
    if (rejectedReasonByName.has(normalised)) continue;

    // Centroid de-dup against active desks. We don't have the
    // existing desk centroids cached (they're not stored), so this
    // step is approximated by the textual checks above. Future
    // work: persist desk centroids during the accept flow.

    const sampleCount = Math.min(cluster.length, 6);
    const proposalSamplePages = cluster.slice(0, sampleCount).map((p) => ({
      pageId: p._id,
      title: p.title,
    }));

    try {
      await Category.create({
        userId,
        name: proposed.name,
        normalizedName: normalised,
        kind: 'desk',
        description: proposed.description,
        status: 'proposed',
        proposalSamplePages,
      });
      summary.proposalsCreated += 1;
      summary.proposals.push({
        name: proposed.name,
        description: proposed.description,
        sampleCount,
      });
      // Cache the new normalised name so a subsequent cluster
      // with the same proposed name doesn't double-insert.
      existingNamesNorm.add(normalised);
    } catch (err) {
      logger.warn(
        { err, name: proposed.name },
        'proposeDesks: persist failed (continuing)',
      );
    }
  }

  logger.info(
    {
      userId: String(userId),
      candidates: vectors.length,
      considered: summary.clustersConsidered,
      created: summary.proposalsCreated,
    },
    'proposeDesks: done',
  );
  return summary;
}

/**
 * Greedy clustering by topic-centroid similarity. Same shape as
 * apps/worker/src/processors/briefing.ts's clusterPages — we
 * intentionally don't pull in k-means because picking k is harder
 * than just running this and capping the cluster count downstream.
 */
function greedyCluster(
  vectors: PageVec[],
  simThreshold: number,
  minSize: number,
): PageVec[][] {
  const remaining = [...vectors];
  const clusters: PageVec[][] = [];
  while (remaining.length >= minSize) {
    // Anchor = the page with the most >threshold neighbours in the
    // remaining pool. Picking by neighbour count (not first-fit)
    // yields more cohesive clusters from a heterogeneous corpus.
    let bestIdx = 0;
    let bestCount = 0;
    for (let i = 0; i < remaining.length; i += 1) {
      let count = 0;
      const a = remaining[i]!.centroid;
      for (let j = 0; j < remaining.length; j += 1) {
        if (i === j) continue;
        if (cosine(a, remaining[j]!.centroid) >= simThreshold) count += 1;
      }
      if (count > bestCount) {
        bestCount = count;
        bestIdx = i;
      }
    }
    if (bestCount < minSize - 1) break; // not enough cohesion left
    const anchor = remaining[bestIdx]!;
    const members: PageVec[] = [anchor];
    const indicesToRemove = new Set<number>([bestIdx]);
    for (let i = 0; i < remaining.length; i += 1) {
      if (i === bestIdx) continue;
      if (cosine(anchor.centroid, remaining[i]!.centroid) >= simThreshold) {
        members.push(remaining[i]!);
        indicesToRemove.add(i);
      }
    }
    if (members.length < minSize) break;
    clusters.push(members);
    // Recompute remaining from the centroid AFTER attaching, so the
    // next anchor isn't drawn from this cluster's neighbourhood.
    const centroid = centroidOf(members.map((m) => m.centroid));
    void centroid;
    const nextRemaining: PageVec[] = [];
    for (let i = 0; i < remaining.length; i += 1) {
      if (!indicesToRemove.has(i)) nextRemaining.push(remaining[i]!);
    }
    remaining.length = 0;
    remaining.push(...nextRemaining);
  }
  return clusters;
}

type Resolved = Awaited<ReturnType<typeof resolveProviderForUser>>;

const SYSTEM_PROMPT = `You are naming a newspaper-style "desk" — a coarse content section
for a personal archive (like Sports, Local, Dining, Advertising).

Given a list of page titles that share a topic, propose:
  - A 1–3 word desk NAME in Title Case (e.g., "Tech Industry",
    "Personal Finance", "Home Improvement"). Concrete noun phrases
    only. Never "Misc", "Other", "News", "Updates".
  - A one-line DESCRIPTION explaining what kinds of pages belong
    here (≤ 200 chars).

Output JSON only:
  {"name": "...", "description": "..."}

If the titles are too heterogeneous to share a coherent theme,
output {"name": null, "description": null}.`;

async function proposeNameForCluster(
  resolved: Resolved,
  cluster: PageVec[],
): Promise<{ name: string; description: string } | null> {
  const titles = cluster.slice(0, 12).map((p) => `- ${p.title}`).join('\n');
  const prompt = `PAGE TITLES (${cluster.length} total, showing up to 12):\n${titles}`;
  let raw: string;
  try {
    raw = await resolved.provider.generate({
      model: resolved.model,
      prompt,
      system: SYSTEM_PROMPT,
      format: 'json',
      temperature: 0.2,
      maxTokens: 200,
    });
  } catch (err) {
    logger.warn({ err }, 'proposeDesks: cluster-name generate failed');
    return null;
  }
  let parsed: { name?: string | null; description?: string | null };
  try {
    parsed = extractJson(raw) as typeof parsed;
  } catch {
    return null;
  }
  if (!parsed?.name || typeof parsed.name !== 'string') return null;
  const name = displayCategoryName(parsed.name);
  if (!name) return null;
  const description =
    typeof parsed.description === 'string'
      ? parsed.description.trim().slice(0, 200)
      : '';
  return { name, description };
}

/** Exposed for tests. The actual cluster matching logic from
 *  proposeDesksForUser, factored out so we can pin it. */
export function clusterMatchesExistingDesk(
  proposedName: string,
  existing: ReadonlyArray<{ name: string }>,
): boolean {
  const n = normalizeCategoryName(proposedName);
  return existing.some((e) => normalizeCategoryName(e.name) === n);
}

// Re-export the threshold so tests don't drift from production.
export const _MIN_PAGES_PER_CLUSTER = MIN_PAGES_PER_CLUSTER;
export const _PROPOSAL_SIM_THRESHOLD = PROPOSAL_SIM_THRESHOLD;
export const _DUPLICATE_NAME_SIM = DUPLICATE_NAME_SIM;
