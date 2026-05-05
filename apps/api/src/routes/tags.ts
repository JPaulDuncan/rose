import { Router } from 'express';
import { Types } from 'mongoose';
import { Page, TagDigest } from '@rose/db';
import { userIdOf } from '../middleware/auth.js';
import { tagDigestQueue } from '../lib/queues.js';

export const tagsRouter: Router = Router();

function utcDayKey(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Pick the most recent non-failed digest for the tag — usually
 * today's, but if today's hasn't been generated yet we fall back to
 * yesterday's so the home edition always has a lede when there's
 * been any prior activity. Failed digests are intentionally
 * skipped so a transient blip doesn't dominate the section header.
 */
async function latestDigest(userId: Types.ObjectId, tag: string) {
  return TagDigest.findOne({ userId, tag, failed: false })
    .sort({ generatedAt: -1 })
    .lean();
}

function shapeDigest(d: NonNullable<Awaited<ReturnType<typeof latestDigest>>> | null) {
  if (!d) return null;
  return {
    headline: d.headline ?? '',
    dek: d.dek ?? '',
    bodyMd: d.bodyMd ?? '',
    topPageIds: (d.topPageIds ?? []).map(String),
    pageCount: d.pageCount ?? 0,
    model: d.model ?? null,
    dayKey: d.dayKey,
    generatedAt: d.generatedAt ? new Date(d.generatedAt).toISOString() : null,
  };
}

/**
 * Lightweight directory of every tag / topic the user has, sorted by usage.
 * Useful for autocomplete and a future "browse all tags" page.
 */
tagsRouter.get('/', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  // Single aggregation across both fields so the directory is unified.
  const rows = await Page.aggregate<{ _id: string; pageCount: number }>([
    { $match: { userId } },
    {
      $project: {
        all: { $setUnion: [{ $ifNull: ['$tags', []] }, { $ifNull: ['$topics', []] }] },
      },
    },
    { $unwind: '$all' },
    { $group: { _id: '$all', pageCount: { $sum: 1 } } },
    { $sort: { pageCount: -1, _id: 1 } },
    { $limit: 500 },
  ]);
  res.json({
    tags: rows.map((r) => ({ tag: r._id, pageCount: r.pageCount })),
  });
});

/**
 * Tag-aggregation page: every wiki page (and the email count behind it)
 * that includes the given tag in either its `tags` or `topics` array,
 * plus stats and the most common co-occurring tags.
 */
tagsRouter.get('/:tag', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const tag = decodeURIComponent(req.params.tag ?? '').trim().toLowerCase();
  if (!tag) {
    res.status(400).json({ error: 'invalid_request', message: 'Empty tag' });
    return;
  }

  const filter = {
    userId,
    $or: [{ tags: tag }, { topics: tag }],
  };

  const pages = await Page.find(filter)
    .sort({ updatedAt: -1 })
    .select('-contentMd -embedding -topicCentroid')
    .lean();

  if (pages.length === 0) {
    res.json({
      tag,
      pageCount: 0,
      totalEmails: 0,
      dateRange: null,
      topSenders: [],
      relatedTags: [],
      pages: [],
    });
    return;
  }

  // Stats
  let totalEmails = 0;
  let earliest: Date | null = null;
  let latest: Date | null = null;
  const senderCounts = new Map<string, number>();
  const tagCounts = new Map<string, number>();
  const topicCounts = new Map<string, number>();
  for (const p of pages) {
    totalEmails += (p.sourceEmailIds ?? []).length;
    const upd = new Date(p.updatedAt as Date);
    if (!earliest || upd < earliest) earliest = upd;
    if (!latest || upd > latest) latest = upd;
    for (const s of (p.senderAddresses ?? []) as string[]) {
      senderCounts.set(s, (senderCounts.get(s) ?? 0) + 1);
    }
    for (const t of (p.tags ?? []) as string[]) {
      if (t !== tag) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
    }
    for (const t of (p.topics ?? []) as string[]) {
      if (t !== tag) topicCounts.set(t, (topicCounts.get(t) ?? 0) + 1);
    }
  }
  const related = new Map<string, number>();
  for (const [t, n] of tagCounts) related.set(t, (related.get(t) ?? 0) + n);
  for (const [t, n] of topicCounts) related.set(t, (related.get(t) ?? 0) + n);

  const digest = shapeDigest(await latestDigest(userId, tag));
  res.json({
    tag,
    pageCount: pages.length,
    totalEmails,
    dateRange:
      earliest && latest ? { from: earliest.toISOString(), to: latest.toISOString() } : null,
    topSenders: [...senderCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([address, pageCount]) => ({ address, pageCount })),
    relatedTags: [...related.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([t, count]) => ({ tag: t, count })),
    digest,
    pages,
  });
});

/**
 * Latest digest for a tag — same shape served alongside /api/tags/:tag,
 * but pre-resolved so a UI that just wants the lede can pull it
 * without the page list.
 */
tagsRouter.get('/:tag/digest', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const tag = decodeURIComponent(req.params.tag ?? '').trim().toLowerCase();
  if (!tag) {
    res.status(400).json({ error: 'invalid_request', message: 'Empty tag' });
    return;
  }
  const digest = shapeDigest(await latestDigest(userId, tag));
  res.json({ digest });
});

/** Force-regenerate today's digest. Capped via job-id collapsing —
 *  same (user, tag, day) triple wins. */
tagsRouter.post('/:tag/digest/regenerate', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const tag = decodeURIComponent(req.params.tag ?? '').trim().toLowerCase();
  if (!tag) {
    res.status(400).json({ error: 'invalid_request', message: 'Empty tag' });
    return;
  }
  const job = await tagDigestQueue.add(
    'digest',
    { userId: String(userId), tag },
    {
      jobId: `digest:${String(userId)}:${tag}:${utcDayKey()}`,
      attempts: 1,
      removeOnComplete: 200,
      removeOnFail: 200,
    },
  );
  res.status(202).json({ jobId: job.id });
});
