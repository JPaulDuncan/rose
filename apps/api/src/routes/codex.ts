import { Router } from 'express';
import { Types } from 'mongoose';
import { Page, Category, Sender, SenderBrand, normalizeCategoryName } from '@rose/db';
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
        'slug title summary heroImageUrl tags topics categoryId updatedAt articleDate sourceEmailIds senderAddresses groupingMode primaryTopic',
      )
      .sort({ articleDate: -1, updatedAt: -1 })
      .lean(),
    Category.find({ userId }).sort({ name: 1 }).lean(),
    // Plan 15 — per-user counters live on Sender; brand-global
    // metadata (name, domain, logoUrl, summary) lives on
    // SenderBrand. We merge below.
    Sender.find({ userId })
      .sort({ pageCount: -1, lastSeenAt: -1 })
      .limit(40)
      .select('brandKey pageCount emailCount nameOverride logoUrlOverride')
      .lean(),
  ]);

  // Pull the corresponding brand rows in one query and key them.
  const brandKeys = senders.map((s) => s.brandKey);
  const brandRows = brandKeys.length
    ? await SenderBrand.find({ brandKey: { $in: brandKeys } })
        .select('brandKey name domain logoUrl summary')
        .lean()
    : [];
  const brandByKey = new Map(brandRows.map((b) => [b.brandKey, b]));

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

  // Build a map from each Category._id → its normalized chapter key.
  // Legacy rows may not have populated `normalizedName`; fall back to
  // computing it on the fly so existing duplicates collapse here even
  // before the worker re-saves them.
  const catKey = new Map<string, string>();
  for (const c of categories) {
    const key = c.normalizedName?.trim() || normalizeCategoryName(c.name ?? '');
    catKey.set(String(c._id), key);
  }

  // Bucket pages by their category's *normalized* key. Pages with no
  // categoryId fall through to the "orphans" bucket and surface under
  // "Uncatalogued".
  type Entry = ReturnType<typeof entryShape>;
  const byKey = new Map<string, Entry[]>();
  const orphans: Entry[] = [];
  for (const p of pages) {
    const shape = entryShape(p);
    const cid = p.categoryId ? String(p.categoryId) : null;
    const key = cid ? catKey.get(cid) : null;
    if (!key) {
      orphans.push(shape);
      continue;
    }
    const arr = byKey.get(key) ?? [];
    arr.push(shape);
    byKey.set(key, arr);
  }

  // For each normalized key, pick the canonical Category as the one
  // with the most contributing pages, breaking ties on most recent
  // updatedAt. The display name is whatever that Category row holds.
  const canonical = new Map<string, (typeof categories)[number]>();
  for (const c of categories) {
    const key = c.normalizedName?.trim() || normalizeCategoryName(c.name ?? '');
    const cur = canonical.get(key);
    if (!cur) {
      canonical.set(key, c);
      continue;
    }
    const count = (id: Types.ObjectId) =>
      pages.filter((p) => String(p.categoryId) === String(id)).length;
    const cAt = (c.updatedAt ?? c.createdAt) as Date | undefined;
    const curAt = (cur.updatedAt ?? cur.createdAt) as Date | undefined;
    if (
      count(c._id) > count(cur._id) ||
      (count(c._id) === count(cur._id) && (cAt?.getTime() ?? 0) > (curAt?.getTime() ?? 0))
    ) {
      canonical.set(key, c);
    }
  }

  const chapters = [...canonical.values()]
    .map((c) => {
      const key = c.normalizedName?.trim() || normalizeCategoryName(c.name ?? '');
      return {
        _id: String(c._id),
        name: c.name,
        parentId: c.parentId ? String(c.parentId) : null,
        icon: c.icon ?? null,
        color: c.color ?? null,
        entries: byKey.get(key) ?? [],
      };
    })
    .filter((c) => c.entries.length > 0)
    .sort((a, b) => b.entries.length - a.entries.length);

  const index = pages
    .map((p) => ({ slug: p.slug, title: p.title }))
    .sort((a, b) => a.title.localeCompare(b.title));

  res.json({
    chapters,
    orphans,
    dramatisPersonae: senders.map((s) => {
      const brand = brandByKey.get(s.brandKey);
      return {
        brandKey: s.brandKey,
        name: s.nameOverride || brand?.name || s.brandKey,
        domain: brand?.domain ?? null,
        logoUrl: s.logoUrlOverride ?? brand?.logoUrl ?? null,
        pageCount: s.pageCount ?? 0,
        emailCount: s.emailCount ?? 0,
        summary: brand?.summary ?? '',
      };
    }),
    index,
    counts: {
      chapters: chapters.length,
      entries: pages.length,
      orphans: orphans.length,
      personae: senders.length,
    },
  });
});
