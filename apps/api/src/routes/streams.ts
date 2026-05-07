import { Router } from 'express';
import { Types } from 'mongoose';
import { Page, Email } from '@rose/db';
import { userIdOf } from '../middleware/auth.js';

export const streamsRouter: Router = Router();

type StreamPage = {
  _id: string;
  slug: string;
  title: string;
  summary: string;
  tags: string[];
  senderAddresses: string[];
  subjectTemplates: string[];
  sourceEmailIds: string[];
  heroImageUrl: string | null;
  updatedAt: string;
  flags?: { isNotificationStream?: boolean };
};

type TimelineEntry = {
  emailId: string;
  pageId: string;
  pageSlug: string;
  pageTitle: string;
  tag: string | null;
  subject: string;
  sender: string | null;
  date: string;
};

/**
 * Cross-stream chronological feed: every notification-stream page plus the
 * most-recent N source emails behind each, merged into one descending list
 * suitable for a vertical timeline UI.
 */
streamsRouter.get('/', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const limit = Math.min(Number(req.query.limit ?? 200), 1000);

  const pages = (await Page.find({
    userId,
    'flags.isNotificationStream': true,
    'flags.userMarkedSpam': { $ne: true },
    'flags.hasLikelySpam': { $ne: true },
  })
    .sort({ articleDate: -1, updatedAt: -1 })
    .select('-contentMd -embedding -topicCentroid')
    .lean()) as unknown as StreamPage[];

  if (pages.length === 0) {
    res.json({ streams: [], timeline: [] });
    return;
  }

  // Pull per-page recent source emails in one batch query, then bucket.
  const allEmailIds = pages.flatMap((p) => p.sourceEmailIds);
  const emails = await Email.find({
    userId,
    _id: { $in: allEmailIds },
  })
    .sort({ date: -1, createdAt: -1 })
    .limit(limit * 4) // generous; gets capped per-page below
    .select('_id subject from date pageId')
    .lean();

  const pageById = new Map(pages.map((p) => [String(p._id), p]));
  const PER_PAGE_CAP = 40;
  const emailCounts = new Map<string, number>();
  const timeline: TimelineEntry[] = [];

  for (const e of emails) {
    const pid = e.pageId ? String(e.pageId) : null;
    if (!pid) continue;
    const page = pageById.get(pid);
    if (!page) continue;
    const used = emailCounts.get(pid) ?? 0;
    if (used >= PER_PAGE_CAP) continue;
    emailCounts.set(pid, used + 1);
    timeline.push({
      emailId: String(e._id),
      pageId: pid,
      pageSlug: page.slug,
      pageTitle: page.title,
      tag: page.tags?.[0] ?? null,
      subject: (e.subject as string | undefined) ?? '(no subject)',
      sender:
        (e.from as { name?: string; address?: string } | null)?.name ??
        (e.from as { address?: string } | null)?.address ??
        null,
      date: (e.date ? new Date(e.date as Date) : new Date()).toISOString(),
    });
  }

  timeline.sort((a, b) => +new Date(b.date) - +new Date(a.date));

  res.json({
    streams: pages.map((p) => ({
      _id: p._id,
      slug: p.slug,
      title: p.title,
      summary: p.summary,
      tags: p.tags,
      senderAddresses: p.senderAddresses,
      heroImageUrl: p.heroImageUrl,
      messageCount: p.sourceEmailIds.length,
      updatedAt: p.updatedAt,
    })),
    timeline: timeline.slice(0, limit),
  });
});
