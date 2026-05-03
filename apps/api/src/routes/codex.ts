import { Router } from 'express';
import { Types } from 'mongoose';
import { Page, Category, Sender } from '@rose/db';
import { userIdOf } from '../middleware/auth.js';

export const codexRouter: Router = Router();

/**
 * Returns the user's wiki structured as a book:
 *   - chapters: every Category, populated with its entries (Pages)
 *   - orphans: pages without a categoryId, grouped under "Uncatalogued"
 *   - dramatisPersonae: top senders by lifetime pageCount, with logos
 *   - index: alphabetical listing of every entry (slug + title) for the
 *     left-rail index. Returned alongside chapters so the SPA can render
 *     either view without a follow-up call.
 *
 * All fields needed for the Codex render are returned in one trip; the
 * page surface uses the same lightweight shape as the digest.
 */
codexRouter.get('/', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));

  const [pages, categories, senders] = await Promise.all([
    Page.find({
      userId,
      $and: [
        { $or: [{ 'flags.userMarkedSpam': { $ne: true } }, { 'flags.userMarkedSpam': null }] },
        { $or: [{ 'flags.hasLikelySpam': { $ne: true } }, { 'flags.hasLikelySpam': null }] },
      ],
    })
      .select(
        'slug title summary heroImageUrl tags topics categoryId updatedAt sourceEmailIds senderAddresses groupingMode primaryTopic',
      )
      .sort({ updatedAt: -1 })
      .lean(),
    Category.find({ userId }).sort({ name: 1 }).lean(),
    Sender.find({ userId })
      .sort({ pageCount: -1, lastSeenAt: -1 })
      .limit(40)
      .select('brandKey name domain logoUrl pageCount emailCount summary')
      .lean(),
  ]);

  const entryShape = (p: typeof pages[number]) => ({
    _id: String(p._id),
    slug: p.slug,
    title: p.title,
    summary: p.summary,
    heroImageUrl: p.heroImageUrl ?? null,
    tags: p.tags ?? [],
    topics: p.topics ?? [],
    senderAddresses: p.senderAddresses ?? [],
    groupingMode: p.groupingMode,
    primaryTopic: p.primaryTopic ?? null,
    messageCount: (p.sourceEmailIds ?? []).length,
    updatedAt: p.updatedAt,
  });

  // Bucket pages by category id. Pages with no categoryId fall through
  // to the "orphans" bucket and surface under "Uncatalogued".
  const byCat = new Map<string, ReturnType<typeof entryShape>[]>();
  const orphans: ReturnType<typeof entryShape>[] = [];
  for (const p of pages) {
    const shape = entryShape(p);
    const cid = p.categoryId ? String(p.categoryId) : null;
    if (!cid) {
      orphans.push(shape);
    } else {
      const arr = byCat.get(cid) ?? [];
      arr.push(shape);
      byCat.set(cid, arr);
    }
  }

  const chapters = categories
    .map((c) => ({
      _id: String(c._id),
      name: c.name,
      parentId: c.parentId ? String(c.parentId) : null,
      icon: c.icon ?? null,
      color: c.color ?? null,
      entries: byCat.get(String(c._id)) ?? [],
    }))
    .filter((c) => c.entries.length > 0)
    .sort((a, b) => b.entries.length - a.entries.length);

  const index = pages
    .map((p) => ({ slug: p.slug, title: p.title }))
    .sort((a, b) => a.title.localeCompare(b.title));

  res.json({
    chapters,
    orphans,
    dramatisPersonae: senders.map((s) => ({
      brandKey: s.brandKey,
      name: s.name,
      domain: s.domain ?? null,
      logoUrl: s.logoUrl ?? null,
      pageCount: s.pageCount ?? 0,
      emailCount: s.emailCount ?? 0,
      summary: s.summary ?? '',
    })),
    index,
    counts: {
      chapters: chapters.length,
      entries: pages.length,
      orphans: orphans.length,
      personae: senders.length,
    },
  });
});
