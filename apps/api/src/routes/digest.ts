import { Router } from 'express';
import { Types } from 'mongoose';
import {
  Page,
  Email,
  User,
  SenderBrand,
  TagDigest,
  Category,
  MemoryGroup,
  MemoryComponent,
} from '@rose/db';
import { userIdOf } from '../middleware/auth.js';

export const digestRouter: Router = Router();

type DigestPage = {
  _id: string;
  slug: string;
  title: string;
  summary: string;
  tags: string[];
  priority: 'high' | 'normal' | 'low';
  spamScore: number;
  flags: {
    hasLikelySpam?: boolean;
    hasMassMailing?: boolean;
    isSparse?: boolean;
    isNotificationStream?: boolean;
  };
  sourceEmailIds: string[];
  senderAddresses: string[];
  topics: string[];
  heroImageUrl?: string | null;
  groupingMode?: string;
  primaryTopic?: string | null;
  updatedAt: string;
  createdAt: string;
  version: number;
  /** Word count for read-time computation, derived from contentMd. */
  wordCount: number;
  /** Optional pull-quote candidate extracted from the page body. */
  pullQuote: string | null;
};

type Bucket = { label: string; pages: DigestPage[] };

/**
 * Pull a single sentence from the page body that's quotable enough to
 * sit as a typographic break. Cheap heuristic: pick the first sentence
 * outside any markdown header/list/code block that's between 60 and 220
 * characters and contains no markdown citation tokens like `[e1]`.
 */
function pullQuoteFrom(contentMd: string | null | undefined): string | null {
  if (!contentMd) return null;
  // Strip code fences, lists, and headings before splitting.
  const stripped = contentMd
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]+`/g, ' ')
    .replace(/^#{1,6}.*$/gm, ' ')
    .replace(/^[\s]*[-*+]\s+/gm, ' ')
    .replace(/\[e\d+(?:\s*,\s*e\d+)*\]/g, '');
  const sentences = stripped.match(/[^.!?\n]+[.!?]/g) ?? [];
  for (const raw of sentences) {
    const s = raw.trim().replace(/\s+/g, ' ');
    if (s.length < 60 || s.length > 220) continue;
    if (/^[\W_]+$/.test(s)) continue;
    return s;
  }
  return null;
}

/** Inline cosine for the affinity scoring loop. Mirrors the
 *  worker-side implementation in apps/worker/src/lib/vec.ts. */
function cosineLocal(a: readonly number[], b: readonly number[]): number {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const ai = a[i]!;
    const bi = b[i]!;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

type AffinityProfile = {
  groups: { centroid: number[]; weight: number }[];
  empty: boolean;
};

/**
 * Build the user's affinity profile: MemoryGroup centroids
 * (subject='user' only) above the confidence floor, weighted by
 * sqrt of size. See apps/worker/src/lib/userAffinity.ts for the
 * full design notes — this implementation is the API-side mirror.
 */
async function loadAffinityProfile(
  userId: Types.ObjectId,
): Promise<AffinityProfile> {
  const groups = (await MemoryGroup.find({ userId, subject: 'user' })
    .select('+centroid label componentCount')
    .lean()) as Array<{
    _id: Types.ObjectId;
    centroid: number[];
    componentCount: number;
  }>;
  if (groups.length === 0) return { groups: [], empty: true };

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
    (g) => (avgById.get(String(g._id)) ?? 0) >= 0.5,
  );
  if (eligible.length === 0) return { groups: [], empty: true };
  const total = eligible.reduce(
    (n, g) => n + Math.max(1, g.componentCount),
    0,
  );
  return {
    empty: false,
    groups: eligible.map((g) => ({
      centroid: g.centroid,
      weight: Math.sqrt(Math.max(1, g.componentCount) / total),
    })),
  };
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/**
 * Newsletter-style digest of recent wiki pages, plus stats and grouping
 * suitable for the home page. Likely-spam pages are excluded from the
 * primary feed but counted in `stats.spam` so they don't disappear silently.
 */
digestRouter.get('/', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const includeSpam = req.query.includeSpam === '1';
  const includePromotions = req.query.includePromotions === '1';
  const userPrefs = (await User.findById(userId)
    .select('featuredTags featuredCategoryIds settings')
    .lean()) as
    | {
        featuredTags?: string[];
        featuredCategoryIds?: string[];
        settings?: {
          hidePromotions?: boolean;
          showMoonPhases?: boolean;
          trendingBlocklist?: string[];
        };
      }
    | null;
  const hidePromotions = !includePromotions && userPrefs?.settings?.hidePromotions !== false;
  // Lowercased lookup so case differences in `Page.topics` don't
  // sneak boilerplate like "Unsubscribe" past the filter.
  const trendingBlocklist = new Set(
    (userPrefs?.settings?.trendingBlocklist ?? []).map((t) => t.toLowerCase()),
  );

  const filter: Record<string, unknown> = { userId };
  if (!includeSpam) {
    filter['flags.hasLikelySpam'] = { $ne: true };
    filter['flags.userMarkedSpam'] = { $ne: true };
    filter['flags.autoQuarantined'] = { $ne: true };
  }
  if (hidePromotions) {
    filter['flags.isPromotional'] = { $ne: true };
  }

  // Pull contentMd just long enough to compute word count + pull quote,
  // then drop it before responding so the wire payload stays small.
  // Keep topicCentroid in the in-memory rows so we can score pages
  // by user-affinity (xMemory personalization), but strip it from
  // the response shape — the client doesn't need the vector itself.
  const rawPages = await Page.find(filter)
    .sort({ articleDate: -1, updatedAt: -1 })
    .select('-embedding')
    .lean();
  const centroidById = new Map<string, number[]>();
  const allPages: DigestPage[] = rawPages.map((p) => {
    const md = (p.contentMd as string | undefined) ?? '';
    const wordCount = md.trim() ? md.trim().split(/\s+/).length : 0;
    const pullQuote = pullQuoteFrom(md);
    const centroid = (p.topicCentroid as number[] | null | undefined) ?? null;
    if (centroid && centroid.length > 0) {
      centroidById.set(String(p._id), centroid);
    }
    const { contentMd: _drop, topicCentroid: _drop2, ...rest } = p as {
      contentMd?: string;
      topicCentroid?: number[];
    } & Record<string, unknown>;
    return { ...(rest as unknown as DigestPage), wordCount, pullQuote };
  });

  const [totalPages, totalEmails, spamPages, highPriPages] = await Promise.all([
    Page.countDocuments({ userId }),
    Email.countDocuments({ userId }),
    Page.countDocuments({
      userId,
      $or: [{ 'flags.hasLikelySpam': true }, { 'flags.userMarkedSpam': true }],
    }),
    Page.countDocuments({ userId, priority: 'high' }),
  ]);

  const now = new Date();
  const today = startOfDay(now);
  const yesterday = startOfDay(new Date(now.getTime() - 24 * 3600 * 1000));
  const thisWeek = startOfDay(new Date(now.getTime() - 7 * 24 * 3600 * 1000));

  const buckets: Bucket[] = [
    { label: 'Today', pages: [] },
    { label: 'Yesterday', pages: [] },
    { label: 'Earlier this week', pages: [] },
    { label: 'Older', pages: [] },
  ];
  for (const p of allPages) {
    // Bucket on the article's "as-of" date (the latest contributing
    // email's received date), falling back to updatedAt only when the
    // page is a legacy row from before articleDate was populated.
    // Using updatedAt directly puts month-old articles into "Today"
    // every time the worker touches them — entity extraction, merge,
    // recategorise, daydream, etc. all bump updatedAt without changing
    // the underlying story date.
    const ref = new Date(
      (p as { articleDate?: Date | null }).articleDate ?? p.updatedAt,
    );
    if (ref >= today) buckets[0]!.pages.push(p);
    else if (ref >= yesterday) buckets[1]!.pages.push(p);
    else if (ref >= thisWeek) buckets[2]!.pages.push(p);
    else buckets[3]!.pages.push(p);
  }

  // Lead story selection. The chain prefers TODAY's content over
  // stale high-priority — without this, a high-priority story from
  // a week ago would dominate the masthead indefinitely, defeating
  // the "refresh at least daily" expectation. Order:
  //
  //   1. Today + high-priority (the ideal)
  //   2. Today + any priority (latest of today — "refresh daily"
  //      guarantee: if today has ANY story, today gets the masthead)
  //   3. Recent + high-priority (only when today is empty; better
  //      to show a fresh-ish important thing than the richest stale)
  //   4. Richest-recent terminal fallback
  const inToday = buckets[0]!.pages;
  const lead =
    inToday.find((p) => p.priority === 'high') ??
    // Latest of today: buckets[0].pages is the today bucket;
    // `allPages` sort order is articleDate-desc → first is freshest
    // among today's set.
    inToday[0] ??
    allPages.find((p) => p.priority === 'high') ??
    allPages
      .slice(0, 25)
      .sort(
        (a, b) =>
          (b.sourceEmailIds?.length ?? 0) - (a.sourceEmailIds?.length ?? 0) ||
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      )[0] ??
    null;

  // ── User-affinity profile (xMemory personalization) ──────────────
  // Centroids of the user's confident user-fact MemoryGroups, used
  // to score pages by "how aligned with what the user actually cares
  // about." The inline implementation mirrors
  // apps/worker/src/lib/userAffinity.ts — must stay in lockstep with
  // it. Two ~30-line copies is the right tradeoff vs creating a
  // shared package, since the API and worker have different call
  // patterns (per-request batch here, per-sweep there).
  //
  // Echo-chamber mitigations baked in:
  //   - Only contributes to the score; never gates ("AFFINITY IS A
  //     WEIGHT, NOT A FILTER" in the worker copy's docstring).
  //   - Confidence floor: groups whose components average < 0.5
  //     confidence are dropped.
  //   - Size weighting: sqrt of (group_count / total) so a 12-
  //     component group dominates a 3-component one but a 50-
  //     component group doesn't swallow everything.
  //   - Cold-start safe: zero groups → returns 0 for every page,
  //     no behavioural change.
  const affinityProfile = await loadAffinityProfile(userId);

  function affinityFor(pageId: string): number {
    if (affinityProfile.empty) return 0;
    const c = centroidById.get(pageId);
    if (!c || c.length === 0) return 0;
    let best = 0;
    for (const g of affinityProfile.groups) {
      if (g.centroid.length !== c.length) continue;
      const sim = Math.max(0, cosineLocal(c, g.centroid));
      const score = sim * g.weight;
      if (score > best) best = score;
    }
    return Math.min(1, best);
  }

  // ── Top stories (above-the-fold "Top Stories" hero block) ─────────
  // Lead + 3 ranked secondaries. Ranking favors high priority, then
  // notification streams (which often surface real incidents), then
  // pages with the richest content (most contributing emails / words),
  // PLUS a user-affinity bump (xMemory) so pages aligned with the
  // user's expressed interests rank higher than equally-shaped
  // generic ones. The affinity term caps at +60 — close to priority's
  // +100 weight so a "high-priority but irrelevant" page can still
  // outrank "no-priority but on-theme", but not by a wide margin.
  function rankScore(p: DigestPage): number {
    let s = 0;
    if (p.priority === 'high') s += 100;
    if (p.flags?.isNotificationStream) s += 30;
    s += Math.min((p.sourceEmailIds?.length ?? 0) * 4, 60);
    s += Math.min(Math.floor((p.wordCount ?? 0) / 100) * 2, 30);
    if (p.heroImageUrl) s += 20;
    // Recency tail — newest gets +20, fades over 7 days.
    const age = Math.max(
      0,
      Math.min(7, (Date.now() - new Date(p.updatedAt).getTime()) / (24 * 3600 * 1000)),
    );
    s += Math.round(20 * (1 - age / 7));
    // User-affinity. 0..1 score → 0..60 contribution. Pages off-
    // theme aren't penalised; they just don't get the boost.
    s += Math.round(affinityFor(p._id) * 60);
    return s;
  }
  const ranked = [...allPages].sort((a, b) => rankScore(b) - rankScore(a));
  const secondaries = ranked
    .filter((p) => p._id !== (lead?._id ?? ''))
    .slice(0, 3);
  const topStories = { lead, secondaries };

  // ── "For you" lede (xMemory) ───────────────────────────────────────
  // Highest-affinity recent page that ISN'T already the lead or a
  // top-stories secondary. Threshold of 0.25 keeps a tepid match
  // from displacing nothing — only render the section when the user
  // has a clearly-on-theme page available. Falls through to null
  // when the user has no affinity profile (cold start) or no page
  // crosses the threshold.
  const FOR_YOU_THRESHOLD = 0.25;
  const dedupSet = new Set(
    [lead?._id, ...secondaries.map((s) => s._id)].filter(Boolean) as string[],
  );
  const forYouCandidates = affinityProfile.empty
    ? []
    : allPages
        .filter((p) => !dedupSet.has(p._id))
        .filter((p) => {
          // Only "recent" — fades affinity boost on a stale archive.
          const age = (Date.now() - new Date(p.updatedAt).getTime()) / (24 * 3600 * 1000);
          return age <= 7;
        })
        .map((p) => ({ p, score: affinityFor(p._id) }))
        .filter((r) => r.score >= FOR_YOU_THRESHOLD)
        .sort((a, b) => b.score - a.score);
  const forYou =
    forYouCandidates.length > 0
      ? {
          page: forYouCandidates[0]!.p,
          affinity: forYouCandidates[0]!.score,
          // Top-3 same-theme companions for the section's secondary
          // list — gives the user "one focus piece + 3 more on this
          // theme" without forcing them to scroll.
          companions: forYouCandidates.slice(1, 4).map((r) => r.p),
        }
      : null;

  // ── Most Read rail (right rail) ───────────────────────────────────
  // Distinct from "topStories": this is a numbered list of the pages a
  // newspaper would call its high-traffic stories. We don't have real
  // engagement data, so we approximate with rank score, excluding the
  // top-stories block to avoid duplication.
  const topStoryIds = new Set(
    [topStories.lead?._id, ...secondaries.map((s) => s._id)].filter(Boolean) as string[],
  );
  const mostRead = ranked
    .filter((p) => !topStoryIds.has(p._id))
    .slice(0, 6);

  // Aggregate sender counts and topic frequencies across all pages.
  const senderCounts = new Map<string, number>();
  const topicCounts = new Map<string, number>();
  for (const p of allPages) {
    for (const s of p.senderAddresses ?? []) {
      senderCounts.set(s, (senderCounts.get(s) ?? 0) + 1);
    }
    for (const t of p.topics ?? []) {
      topicCounts.set(t, (topicCounts.get(t) ?? 0) + 1);
    }
  }
  const topSenders = [...senderCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([address, pageCount]) => ({ address, pageCount }));

  // Sender brand index — every address that appears on any page above
  // gets a single lookup to the SenderBrand record (Plan 15: brand-
  // global), so the client can render brand logos + display names
  // alongside attribution without a second round-trip per card.
  // Keyed by lowercased email address.
  const allAddrs = [...senderCounts.keys()];
  const senderRecords = allAddrs.length
    ? await SenderBrand.find({ addresses: { $in: allAddrs } })
        .select('brandKey name domain logoUrl addresses')
        .lean()
    : [];
  const senderBrands: Record<
    string,
    { brandKey: string; name: string; domain: string | null; logoUrl: string | null }
  > = {};
  for (const s of senderRecords) {
    for (const a of (s.addresses as string[] | undefined) ?? []) {
      senderBrands[a] = {
        brandKey: s.brandKey,
        name: s.name ?? s.brandKey,
        domain: s.domain ?? null,
        logoUrl: s.logoUrl ?? null,
      };
    }
  }
  // Drop user-muted topics before slicing so the trending card
  // always shows 12 *signal* entries — muting `unsubscribe` shouldn't
  // leave a hole, it should let the next-most-popular topic surface.
  const topTopics = [...topicCounts.entries()]
    .filter(([topic]) => !trendingBlocklist.has(topic.toLowerCase()))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([topic, count]) => ({ topic, count }));

  // ── Featured sections ────────────────────────────────────────────────
  // Each featured tag becomes a named section in the newsletter, populated
  // with that tag's most-recently-updated pages (across either `tags` or
  // `topics`, capped at 8 per section). Spam + promotions still excluded.
  const featuredTags = (userPrefs?.featuredTags ?? []).map((t) => t.toLowerCase());
  const featuredSections: {
    tag: string;
    pageCount: number;
    pages: DigestPage[];
    digest: {
      headline: string;
      dek: string;
      bodyMd: string;
      generatedAt: string | null;
      dayKey: string;
    } | null;
  }[] = [];
  // Bulk-fetch the latest non-failed digests so this stays one
  // round-trip regardless of how many tags the user has featured.
  const digests = featuredTags.length
    ? await TagDigest.find({ userId, tag: { $in: featuredTags }, failed: false })
        .sort({ generatedAt: -1 })
        .lean()
    : [];
  const latestByTag = new Map<string, (typeof digests)[number]>();
  for (const d of digests) {
    if (!latestByTag.has(d.tag)) latestByTag.set(d.tag, d);
  }
  for (const tag of featuredTags) {
    const tagFilter = {
      ...filter,
      $or: [{ tags: tag }, { topics: tag }],
    };
    const matching = (await Page.find(tagFilter)
      .sort({ articleDate: -1, updatedAt: -1 })
      .limit(8)
      .select('-contentMd -embedding -topicCentroid')
      .lean()) as unknown as DigestPage[];
    const total = await Page.countDocuments(tagFilter);
    const d = latestByTag.get(tag) ?? null;
    const digest = d
      ? {
          headline: d.headline ?? '',
          dek: d.dek ?? '',
          bodyMd: d.bodyMd ?? '',
          generatedAt: d.generatedAt ? new Date(d.generatedAt).toISOString() : null,
          dayKey: d.dayKey,
        }
      : null;
    featuredSections.push({
      tag,
      pageCount: matching.length > 0 ? total : 0,
      pages: matching,
      digest,
    });
  }

  // ── Featured desks / categories ──────────────────────────────────────
  // Same shape as featuredSections but pins by categoryId. The user
  // toggles a category as "featured" in Settings → Desks (the star),
  // and the home page renders the category's most-recent pages as
  // its own section with the desk's display name + description.
  // Stale ids (the user archived the desk after pinning it) get
  // filtered here rather than the client having to know — keeps the
  // home payload self-consistent even when settings drift.
  const featuredCategoryIds = (userPrefs?.featuredCategoryIds ?? [])
    .filter((id) => Types.ObjectId.isValid(id))
    .map((id) => new Types.ObjectId(id));
  const featuredDesks = featuredCategoryIds.length
    ? await Category.find({
        userId,
        _id: { $in: featuredCategoryIds },
        status: { $ne: 'archived' },
      })
        .select('name description kind icon color')
        .lean()
    : [];
  // Preserve user-set order: walk featuredCategoryIds and pluck the
  // matching Category row in order, dropping anything that didn't
  // resolve (archived/deleted).
  const deskById = new Map(featuredDesks.map((d) => [String(d._id), d]));
  const orderedDesks = featuredCategoryIds
    .map((id) => deskById.get(String(id)))
    .filter((d): d is (typeof featuredDesks)[number] => !!d);
  const featuredDeskSections: {
    categoryId: string;
    name: string;
    description: string;
    kind: 'desk' | 'ad-hoc';
    icon: string | null;
    pageCount: number;
    pages: DigestPage[];
  }[] = [];
  for (const desk of orderedDesks) {
    const deskFilter = { ...filter, categoryId: desk._id };
    const matching = (await Page.find(deskFilter)
      .sort({ articleDate: -1, updatedAt: -1 })
      .limit(8)
      .select('-contentMd -embedding -topicCentroid')
      .lean()) as unknown as DigestPage[];
    const total = await Page.countDocuments(deskFilter);
    featuredDeskSections.push({
      categoryId: String(desk._id),
      name: desk.name,
      description: desk.description ?? '',
      kind: (desk.kind as 'desk' | 'ad-hoc' | undefined) ?? 'ad-hoc',
      icon: desk.icon ?? null,
      pageCount: total,
      pages: matching,
    });
  }

  res.json({
    featuredTags,
    featuredSections,
    featuredCategoryIds: featuredCategoryIds.map((id) => String(id)),
    featuredDeskSections,
    showMoonPhases: !!userPrefs?.settings?.showMoonPhases,
    edition: {
      date: now.toISOString(),
      label: now.toLocaleDateString(undefined, {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      }),
    },
    stats: {
      totalPages,
      totalEmails,
      newToday: inToday.length,
      spam: spamPages,
      highPriority: highPriPages,
    },
    lead,
    topStories,
    forYou,
    mostRead,
    buckets,
    topSenders,
    topTopics,
    senderBrands,
  });
});
