import { Router } from 'express';
import { Types } from 'mongoose';
import { Page, Email, User, Sender } from '@rose/db';
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
    .select('featuredTags settings')
    .lean()) as
    | {
        featuredTags?: string[];
        settings?: { hidePromotions?: boolean };
      }
    | null;
  const hidePromotions = !includePromotions && userPrefs?.settings?.hidePromotions !== false;

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
  const rawPages = await Page.find(filter)
    .sort({ updatedAt: -1 })
    .select('-embedding -topicCentroid')
    .lean();
  const allPages: DigestPage[] = rawPages.map((p) => {
    const md = (p.contentMd as string | undefined) ?? '';
    const wordCount = md.trim() ? md.trim().split(/\s+/).length : 0;
    const pullQuote = pullQuoteFrom(md);
    const { contentMd: _drop, ...rest } = p as { contentMd?: string } & Record<string, unknown>;
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
    const updated = new Date(p.updatedAt);
    if (updated >= today) buckets[0]!.pages.push(p);
    else if (updated >= yesterday) buckets[1]!.pages.push(p);
    else if (updated >= thisWeek) buckets[2]!.pages.push(p);
    else buckets[3]!.pages.push(p);
  }

  // Lead story selection: prefer a high-priority page from today, then a
  // high-priority page overall, then the most recent page with the most
  // source emails (richest content).
  const inToday = buckets[0]!.pages;
  const lead =
    inToday.find((p) => p.priority === 'high') ??
    allPages.find((p) => p.priority === 'high') ??
    allPages
      .slice(0, 25)
      .sort(
        (a, b) =>
          (b.sourceEmailIds?.length ?? 0) - (a.sourceEmailIds?.length ?? 0) ||
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      )[0] ??
    null;

  // ── Top stories (above-the-fold "Top Stories" hero block) ─────────
  // Lead + 3 ranked secondaries. Ranking favours high priority, then
  // notification streams (which often surface real incidents), then
  // pages with the richest content (most contributing emails / words).
  // We exclude the lead from the secondaries list and pull from the
  // pool of recently-updated pages so the block always feels fresh.
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
    return s;
  }
  const ranked = [...allPages].sort((a, b) => rankScore(b) - rankScore(a));
  const secondaries = ranked
    .filter((p) => p._id !== (lead?._id ?? ''))
    .slice(0, 3);
  const topStories = { lead, secondaries };

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
  // gets a single lookup to the Sender record, so the client can render
  // brand logos + display names alongside attribution without a second
  // round-trip per card. Keyed by lowercased email address.
  const allAddrs = [...senderCounts.keys()];
  const senderRecords = allAddrs.length
    ? await Sender.find({ userId, addresses: { $in: allAddrs } })
        .select('brandKey name domain logoUrl addresses')
        .lean()
    : [];
  const senderBrands: Record<
    string,
    { brandKey: string; name: string; domain: string | null; logoUrl: string | null }
  > = {};
  for (const s of senderRecords) {
    for (const a of s.addresses ?? []) {
      senderBrands[a] = {
        brandKey: s.brandKey,
        name: s.name,
        domain: s.domain ?? null,
        logoUrl: s.logoUrl ?? null,
      };
    }
  }
  const topTopics = [...topicCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([topic, count]) => ({ topic, count }));

  // ── Featured sections ────────────────────────────────────────────────
  // Each featured tag becomes a named section in the newsletter, populated
  // with that tag's most-recently-updated pages (across either `tags` or
  // `topics`, capped at 8 per section). Spam + promotions still excluded.
  const featuredTags = (userPrefs?.featuredTags ?? []).map((t) => t.toLowerCase());
  const featuredSections: { tag: string; pageCount: number; pages: DigestPage[] }[] = [];
  for (const tag of featuredTags) {
    const tagFilter = {
      ...filter,
      $or: [{ tags: tag }, { topics: tag }],
    };
    const matching = (await Page.find(tagFilter)
      .sort({ updatedAt: -1 })
      .limit(8)
      .select('-contentMd -embedding -topicCentroid')
      .lean()) as unknown as DigestPage[];
    const total = await Page.countDocuments(tagFilter);
    if (matching.length > 0) {
      featuredSections.push({ tag, pageCount: total, pages: matching });
    } else {
      featuredSections.push({ tag, pageCount: 0, pages: [] });
    }
  }

  res.json({
    featuredTags,
    featuredSections,
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
    mostRead,
    buckets,
    topSenders,
    topTopics,
    senderBrands,
  });
});
