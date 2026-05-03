import { Router } from 'express';
import { Types } from 'mongoose';
import { Sender, Page, Email } from '@rose/db';
import { userIdOf } from '../middleware/auth.js';
import { summarizeSenderQueue } from '../lib/queues.js';

export const sendersRouter: Router = Router();

/**
 * Strip large/derived fields the client doesn't need on list views.
 * Lean docs come back with arrays of strings, so we just trim the
 * websites + addresses we actually want to show.
 */
function listShape(s: Record<string, unknown>) {
  return {
    _id: String(s._id),
    brandKey: s.brandKey,
    name: s.name,
    domain: s.domain ?? null,
    addresses: (s.addresses as string[] | undefined)?.slice(0, 4) ?? [],
    logoUrl: s.logoUrl ?? null,
    logoConfidence: s.logoConfidence ?? 0,
    summary: s.summary ?? '',
    summaryGeneratedAt: s.summaryGeneratedAt ?? null,
    pageCount: s.pageCount ?? 0,
    emailCount: s.emailCount ?? 0,
    lastSeenAt: s.lastSeenAt ?? null,
    firstSeenAt: s.firstSeenAt ?? null,
    websites: (s.websites as string[] | undefined)?.slice(0, 6) ?? [],
  };
}

sendersRouter.get('/', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const sort = (req.query.sort as string | undefined) ?? 'recent';
  const limit = Math.min(Number(req.query.limit ?? 100), 500);
  const sortSpec: Record<string, 1 | -1> =
    sort === 'pages'
      ? { pageCount: -1, lastSeenAt: -1 }
      : sort === 'emails'
        ? { emailCount: -1, lastSeenAt: -1 }
        : sort === 'name'
          ? { name: 1 }
          : { lastSeenAt: -1 };
  const senders = await Sender.find({ userId }).sort(sortSpec).limit(limit).lean();
  res.json({ senders: senders.map(listShape) });
});

/**
 * Resolve any email address to its Sender record's brandKey. The web
 * client uses this to make every sender chip / attribution link
 * deep-linkable to /s/:brandKey without needing to know the brand
 * convention. Returns 404 when we don't have an entry yet.
 */
sendersRouter.get('/by-address/:address', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const addr = req.params.address.toLowerCase();
  const sender = await Sender.findOne({ userId, addresses: addr })
    .select('brandKey name')
    .lean();
  if (!sender) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json({ brandKey: sender.brandKey, name: sender.name });
});

/**
 * Look up by `brandKey` instead of ObjectId — the URL stays stable when
 * the same Sender doc gets recreated by reset-wiki. Returns the sender
 * plus its 8 most recent contributing pages (slug/title) so the detail
 * UI can show "where you've seen them" without a follow-up call.
 */
sendersRouter.get('/:brandKey', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const sender = await Sender.findOne({ userId, brandKey: req.params.brandKey });
  if (!sender) {
    res.status(404).json({ error: 'not_found', message: 'Sender not found' });
    return;
  }
  const pages = await Page.find({
    userId,
    senderAddresses: { $in: sender.addresses ?? [] },
  })
    .sort({ updatedAt: -1 })
    .limit(8)
    .select('slug title summary heroImageUrl tags topics updatedAt sourceEmailIds')
    .lean();
  const recentEmails = await Email.find({
    userId,
    'from.address': { $in: sender.addresses ?? [] },
  })
    .sort({ date: -1 })
    .limit(10)
    .select('subject date from')
    .lean();
  res.json({
    sender: { ...listShape(sender.toObject()), unsubscribeUrls: sender.unsubscribeUrls ?? [] },
    pages: pages.map((p) => ({
      _id: String(p._id),
      slug: p.slug,
      title: p.title,
      summary: p.summary,
      heroImageUrl: p.heroImageUrl ?? null,
      tags: p.tags ?? [],
      topics: p.topics ?? [],
      updatedAt: p.updatedAt,
      messageCount: (p.sourceEmailIds ?? []).length,
    })),
    recentEmails: recentEmails.map((e) => ({
      _id: String(e._id),
      subject: e.subject,
      date: e.date,
      fromName: e.from?.name ?? null,
      fromAddress: e.from?.address ?? null,
    })),
  });
});

/** User overrides (logo / name / summary). Sets the *Locked flag so the
 *  worker stops auto-overwriting that field. */
sendersRouter.patch('/:brandKey', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const sender = await Sender.findOne({ userId, brandKey: req.params.brandKey });
  if (!sender) {
    res.status(404).json({ error: 'not_found', message: 'Sender not found' });
    return;
  }
  const body = (req.body ?? {}) as {
    name?: string;
    logoUrl?: string | null;
    summary?: string;
  };
  if (typeof body.name === 'string' && body.name.trim()) {
    sender.name = body.name.trim().slice(0, 80);
  }
  if (body.logoUrl === null) {
    sender.logoUrl = null;
    sender.logoConfidence = 0;
    sender.logoLocked = true;
  } else if (typeof body.logoUrl === 'string') {
    sender.logoUrl = body.logoUrl.trim() || null;
    sender.logoConfidence = sender.logoUrl ? 1 : 0;
    sender.logoLocked = true;
  }
  if (typeof body.summary === 'string') {
    sender.summary = body.summary.trim().slice(0, 600);
    sender.summaryLocked = true;
    sender.summaryGeneratedAt = new Date();
  }
  await sender.save();
  res.json({ sender: listShape(sender.toObject()) });
});

/** Enqueue an LLM summary refresh. Clears the lock so the next worker
 *  pass can rewrite the paragraph. */
sendersRouter.post('/:brandKey/refresh', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const sender = await Sender.findOne({ userId, brandKey: req.params.brandKey });
  if (!sender) {
    res.status(404).json({ error: 'not_found', message: 'Sender not found' });
    return;
  }
  sender.summaryLocked = false;
  await sender.save();
  const job = await summarizeSenderQueue.add(
    'summarize',
    { senderId: String(sender._id), userId: String(userId) },
    { attempts: 2, removeOnComplete: 100, removeOnFail: 100 },
  );
  res.status(202).json({ jobId: job.id });
});

sendersRouter.delete('/:brandKey', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  await Sender.deleteOne({ userId, brandKey: req.params.brandKey });
  res.json({ ok: true });
});
