import { Router } from 'express';
import { Types } from 'mongoose';
import { PageUpdateRequest } from '@rose/shared';
import { userIdOf } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { Page, Sender } from '@rose/db';
import { PageRevision } from '@rose/db';

/**
 * Resolve every senderAddress on a page to its (brandKey, name, logoUrl).
 * The Page route includes this map so the wiki view can render brand
 * chips and link each sender to its address-book page (`/s/:brandKey`)
 * without per-address requests.
 */
async function senderBrandsForPage(
  userId: Types.ObjectId,
  addresses: string[],
): Promise<Record<string, { brandKey: string; name: string; logoUrl: string | null }>> {
  if (!addresses?.length) return {};
  const senders = await Sender.find({ userId, addresses: { $in: addresses } })
    .select('brandKey name logoUrl addresses')
    .lean();
  const out: Record<string, { brandKey: string; name: string; logoUrl: string | null }> =
    {};
  for (const s of senders) {
    for (const a of s.addresses ?? []) {
      out[a] = { brandKey: s.brandKey, name: s.name, logoUrl: s.logoUrl ?? null };
    }
  }
  return out;
}
import { embedPageQueue } from '../lib/queues.js';
import { recordRevision, uniqueSlug } from '../services/wiki.js';

export const pagesRouter: Router = Router();

pagesRouter.get('/', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const limit = Math.min(Number(req.query.limit ?? 50), 200);
  const tag = req.query.tag as string | undefined;
  const filter: Record<string, unknown> = { userId };
  if (tag) filter.tags = tag;
  const pages = await Page.find(filter)
    .sort({ updatedAt: -1 })
    .limit(limit)
    .select('-contentMd')
    .lean();
  res.json({ pages });
});

pagesRouter.get('/by-slug/:slug', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const page = await Page.findOne({ userId, slug: req.params.slug }).lean();
  if (!page) {
    res.status(404).json({ error: 'not_found', message: 'Page not found' });
    return;
  }
  const senderBrands = await senderBrandsForPage(userId, page.senderAddresses ?? []);
  res.json({ ...page, senderBrands });
});

pagesRouter.get('/:id', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  if (!Types.ObjectId.isValid(req.params.id)) {
    res.status(400).json({ error: 'invalid_request', message: 'Invalid id' });
    return;
  }
  const page = await Page.findOne({ _id: req.params.id, userId }).lean();
  if (!page) {
    res.status(404).json({ error: 'not_found', message: 'Page not found' });
    return;
  }
  const senderBrands = await senderBrandsForPage(userId, page.senderAddresses ?? []);
  res.json({ ...page, senderBrands });
});

pagesRouter.patch('/:id', validateBody(PageUpdateRequest), async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const page = await Page.findOne({ _id: req.params.id, userId });
  if (!page) {
    res.status(404).json({ error: 'not_found', message: 'Page not found' });
    return;
  }
  const update = req.body as typeof PageUpdateRequest._type;
  const titleChanged = update.title && update.title !== page.title;
  if (titleChanged) page.slug = await uniqueSlug(userId, update.title!, page._id);
  if (update.title) page.title = update.title;
  if (update.summary !== undefined) page.summary = update.summary;
  if (update.contentMd !== undefined) page.contentMd = update.contentMd;
  if (update.tags) page.tags = update.tags;
  if (update.categoryId !== undefined)
    page.categoryId = update.categoryId ? new Types.ObjectId(update.categoryId) : null;
  page.version += 1;
  await page.save();
  await recordRevision(
    {
      _id: page._id,
      version: page.version,
      title: page.title,
      summary: page.summary,
      contentMd: page.contentMd,
    },
    'user',
  );
  await embedPageQueue.add(
    'embed',
    { pageId: page._id.toString(), userId: userId.toString() },
    { removeOnComplete: 200, removeOnFail: 200, attempts: 3 },
  );
  res.json(page);
});

pagesRouter.delete('/:id', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  await Page.deleteOne({ _id: req.params.id, userId });
  await PageRevision.deleteMany({ pageId: req.params.id });
  res.json({ ok: true });
});

pagesRouter.get('/:id/revisions', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const page = await Page.findOne({ _id: req.params.id, userId }).select('_id').lean();
  if (!page) {
    res.status(404).json({ error: 'not_found', message: 'Page not found' });
    return;
  }
  const revisions = await PageRevision.find({ pageId: page._id }).sort({ version: -1 }).lean();
  res.json({ revisions });
});

pagesRouter.post('/:id/revisions/:version/restore', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const page = await Page.findOne({ _id: req.params.id, userId });
  if (!page) {
    res.status(404).json({ error: 'not_found', message: 'Page not found' });
    return;
  }
  const rev = await PageRevision.findOne({
    pageId: page._id,
    version: Number(req.params.version),
  });
  if (!rev) {
    res.status(404).json({ error: 'not_found', message: 'Revision not found' });
    return;
  }
  page.title = rev.title ?? page.title;
  page.summary = rev.summary ?? page.summary;
  page.contentMd = rev.contentMd ?? page.contentMd;
  page.version += 1;
  await page.save();
  await recordRevision(
    {
      _id: page._id,
      version: page.version,
      title: page.title,
      summary: page.summary,
      contentMd: page.contentMd,
    },
    'user',
  );
  await embedPageQueue.add(
    'embed',
    { pageId: page._id.toString() },
    { removeOnComplete: 200, removeOnFail: 200, attempts: 3 },
  );
  res.json(page);
});
