import { z } from 'zod';
import type { Types } from 'mongoose';
import { LibrarySource, MemoryGroup, MemoryComponent } from '@rose/db';
import { extractJson } from '@rose/llm';
import { resolveProviderForUser } from '../lib/providers.js';
import { logger } from '../lib/logger.js';

/**
 * Library-source proposer — the "research only things the user cares
 * about" piece of the user-centric overhaul. Walks the user's
 * confident xMemory user-fact groups, asks the LLM to propose
 * concrete RSS / sitemap / URL sources for each theme, then
 * persists each suggestion as a LibrarySource with status='proposed'
 * for the user to accept/reject in Settings → Library.
 *
 * Discipline mirrored from the desk proposer:
 *   - One LLM call per group cluster (NOT one per component); cost
 *     is bounded by the user's group count.
 *   - Cap of MAX_PROPOSALS_PER_RUN sources per invocation so a
 *     button click doesn't dump a wall of pending suggestions.
 *   - Dedup against existing LibrarySource rows (active OR
 *     rejected) so we don't re-suggest URLs the user has already
 *     seen.
 *   - Cold-start safe: zero groups OR low-confidence groups →
 *     returns 0 proposals, no LLM calls fired.
 */

const MIN_GROUP_CONFIDENCE = 0.6;
const MIN_COMPONENTS_PER_GROUP = 3;
const MAX_PROPOSALS_PER_RUN = 8;
/** How many sources per group the LLM is allowed to propose. */
const MAX_SUGGESTIONS_PER_GROUP = 2;

const SystemPrompt = `You suggest concrete RSS feed URLs, sitemap URLs, or web pages a user
should subscribe to in their personal research library, based on
themes they've expressed interest in.

You will be given a THEME label and a few example user-facts that
fall under it. Your job is to propose ${MAX_SUGGESTIONS_PER_GROUP} reputable, specific sources
matching the theme.

OUTPUT JSON ONLY:
  {"suggestions": [
    {"kind": "rss" | "url" | "sitemap", "url": "...", "name": "...",
     "reason": "..."},
    ...
  ]}

STRICT RULES:
  - URLs MUST be plausibly real domains the model has seen before.
    Prefer well-known sources (major publishers, official feeds,
    canonical project sites). Do NOT invent obscure-looking domains.
  - 'kind' should match the URL: an /feed or .rss path → 'rss';
    a /sitemap.xml → 'sitemap'; anything else → 'url'.
  - 'name' is a short title-case label for the source (≤ 80 chars).
  - 'reason' is one sentence connecting the source to the theme +
    the example user-facts. ≤ 160 chars.
  - If you can't confidently suggest sources for the theme, return
    {"suggestions": []}. Empty is better than wrong.
  - Output ONLY the JSON. No prose, no fences.`;

const SuggestionsOutput = z.object({
  suggestions: z
    .array(
      z.object({
        kind: z.enum(['rss', 'url', 'sitemap']),
        url: z.string().url().max(500),
        name: z.string().min(1).max(120),
        reason: z.string().max(280),
      }),
    )
    .max(4),
});

export type LibrarySuggestionSummary = {
  groupsConsidered: number;
  suggestionsCreated: number;
  proposals: { name: string; url: string; reason: string }[];
};

export async function proposeLibrarySourcesForUser(
  userId: Types.ObjectId,
): Promise<LibrarySuggestionSummary> {
  const summary: LibrarySuggestionSummary = {
    groupsConsidered: 0,
    suggestionsCreated: 0,
    proposals: [],
  };

  // Pull the user's confident user-fact groups. Same shape as the
  // affinity-profile loader; this proposer's signal needs CONFIDENT
  // groups, not just any. We re-query rather than reusing the
  // affinity loader because we want the GROUP TEXT (label) +
  // example components, not just centroids.
  const groups = (await MemoryGroup.find({ userId, subject: 'user' })
    .sort({ componentCount: -1 })
    .select('_id label componentCount')
    .limit(12)
    .lean()) as Array<{
    _id: Types.ObjectId;
    label: string;
    componentCount: number;
  }>;
  if (groups.length === 0) return summary;

  // Per-group confidence + samples. One aggregate gets us the
  // confidence average; a separate query pulls representative
  // component texts to seed the prompt.
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

  const eligibleGroups = groups
    .filter((g) => g.componentCount >= MIN_COMPONENTS_PER_GROUP)
    .filter((g) => (avgById.get(String(g._id)) ?? 0) >= MIN_GROUP_CONFIDENCE);
  summary.groupsConsidered = eligibleGroups.length;
  if (eligibleGroups.length === 0) return summary;

  // Dedup pool: every existing LibrarySource URL the user has seen
  // (active, paused, errored, rejected, proposed). The user
  // shouldn't see a URL twice — they already made a decision OR
  // it's already in their library.
  const existingUrls = new Set(
    (
      await LibrarySource.find({ userId })
        .select('url urls')
        .lean()
    )
      .flatMap((s) => [
        s.url as string | null,
        ...((s.urls as string[] | undefined) ?? []),
      ])
      .filter((u): u is string => !!u)
      .map((u) => u.toLowerCase()),
  );

  let resolved;
  try {
    resolved = await resolveProviderForUser(userId, 'generation');
  } catch (err) {
    logger.warn({ err }, 'library-suggest: provider unavailable');
    return summary;
  }

  // Walk groups in size-desc order (we sorted above). Stop once we
  // hit MAX_PROPOSALS_PER_RUN regardless of how many groups remain
  // — the user can re-trigger the proposer if they want more.
  for (const g of eligibleGroups) {
    if (summary.suggestionsCreated >= MAX_PROPOSALS_PER_RUN) break;
    const samples = await MemoryComponent.find({
      userId,
      groupId: g._id,
      subject: 'user',
      status: 'active',
    })
      .select('text')
      .sort({ confidence: -1, lastSeenAt: -1 })
      .limit(5)
      .lean();
    if (samples.length === 0) continue;

    const prompt = [
      `THEME: ${g.label}`,
      'EXAMPLE USER-FACTS:',
      ...samples.map((s) => `- ${s.text}`),
    ].join('\n');

    let raw: string;
    try {
      raw = await resolved.provider.generate({
        model: resolved.model,
        prompt,
        system: SystemPrompt,
        format: 'json',
        temperature: 0.3,
        maxTokens: 600,
      });
    } catch (err) {
      logger.warn({ err, group: g.label }, 'library-suggest: generate failed');
      continue;
    }
    let parsed: z.infer<typeof SuggestionsOutput>;
    try {
      parsed = SuggestionsOutput.parse(extractJson(raw));
    } catch (err) {
      logger.warn(
        { err, raw: raw.slice(0, 200) },
        'library-suggest: invalid JSON',
      );
      continue;
    }

    for (const s of parsed.suggestions.slice(0, MAX_SUGGESTIONS_PER_GROUP)) {
      if (summary.suggestionsCreated >= MAX_PROPOSALS_PER_RUN) break;
      const urlLower = s.url.toLowerCase();
      if (existingUrls.has(urlLower)) continue;
      try {
        await LibrarySource.create({
          userId,
          kind: s.kind,
          name: s.name,
          url: s.url,
          status: 'proposed',
          proposalReason: `Matches your interest in “${g.label}”: ${s.reason}`,
          proposalEvidence: samples.slice(0, 4).map((c) => c.text),
        });
        existingUrls.add(urlLower);
        summary.suggestionsCreated += 1;
        summary.proposals.push({
          name: s.name,
          url: s.url,
          reason: s.reason,
        });
      } catch (err) {
        logger.warn(
          { err, url: s.url },
          'library-suggest: persist failed (continuing)',
        );
      }
    }
  }

  logger.info(
    {
      userId: String(userId),
      groups: summary.groupsConsidered,
      created: summary.suggestionsCreated,
    },
    'library-suggest: done',
  );
  return summary;
}
