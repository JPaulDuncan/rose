import { Router } from 'express';
import { Types } from 'mongoose';
import { Page, Email } from '@rose/db';
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
  flags: { hasLikelySpam?: boolean; hasMassMailing?: boolean; isSparse?: boolean };
  sourceEmailIds: string[];
  senderAddresses: string[];
  topics: string[];
  updatedAt: string;
  createdAt: string;
  version: number;
};

type Bucket = { label: string; pages: DigestPage[] };

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

  const filter: Record<string, unknown> = { userId };
  if (!includeSpam) {
    filter['flags.hasLikelySpam'] = { $ne: true };
    filter['flags.userMarkedSpam'] = { $ne: true };
  }

  const allPages = (await Page.find(filter)
    .sort({ updatedAt: -1 })
    .select('-contentMd -embedding -topicCentroid')
    .lean()) as unknown as DigestPage[];

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
  const topTopics = [...topicCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([topic, count]) => ({ topic, count }));

  res.json({
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
    buckets,
    topSenders,
    topTopics,
  });
});
