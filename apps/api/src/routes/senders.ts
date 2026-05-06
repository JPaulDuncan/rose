import { Router } from 'express';
import { Types } from 'mongoose';
import { Sender, SenderBrand, Page, Email } from '@rose/db';
import { userIdOf } from '../middleware/auth.js';
import { summarizeSenderQueue } from '../lib/queues.js';

export const sendersRouter: Router = Router();

/**
 * Plan 14 — fold the global `SenderBrand` row into a per-user
 * `Sender` shape so the existing UI continues to receive the
 * familiar payload while reading the brand-global brief / logo /
 * addresses from the shared collection.
 *
 * Strategy: brand-global fields prefer SenderBrand when populated,
 * fall back to Sender. Per-user fields (counts, toggles, locks)
 * stay sourced from Sender. The merged object is what `listShape`
 * consumes downstream.
 */
type AnyDoc = Record<string, unknown>;
async function brandOverlay(brandKey: string): Promise<AnyDoc | null> {
  const brand = await SenderBrand.findOne({ brandKey })
    .select(
      'name domain addresses websites logoUrl logoConfidence summary summaryGeneratedAt unsubscribeUrls postalAddresses forgottenBriefBy',
    )
    .lean();
  return (brand as AnyDoc | null) ?? null;
}

/**
 * Merge a global brand row onto a per-user sender doc, preferring
 * the global value for brand-global fields. The user's locks
 * (`logoLocked`, `summaryLocked`) keep the per-user value when the
 * user has explicitly pinned it.
 */
function mergeBrandIntoSender(
  perUser: AnyDoc,
  brand: AnyDoc | null,
  userId: Types.ObjectId,
): AnyDoc {
  if (!brand) return perUser;
  const merged: AnyDoc = { ...perUser };
  // Brand-global preferred unless the user has locked their copy.
  if (!perUser.logoLocked) {
    merged.logoUrl = brand.logoUrl ?? perUser.logoUrl ?? null;
    merged.logoConfidence = (brand.logoConfidence as number) ?? perUser.logoConfidence ?? 0;
  }
  if (!perUser.summaryLocked) {
    const forgotten = (brand.forgottenBriefBy as Types.ObjectId[] | undefined) ?? [];
    const isForgotten = forgotten.some((id) => String(id) === String(userId));
    if (!isForgotten) {
      merged.summary = brand.summary || perUser.summary || '';
      merged.summaryGeneratedAt =
        brand.summaryGeneratedAt ?? perUser.summaryGeneratedAt ?? null;
    }
  }
  // Union addresses + websites + unsubscribeUrls + postalAddresses
  // so the user's view sees everything any other user has surfaced.
  const unionStr = (a: string[] | undefined, b: string[] | undefined) => [
    ...new Set([...(a ?? []), ...(b ?? [])]),
  ];
  merged.addresses = unionStr(
    perUser.addresses as string[] | undefined,
    brand.addresses as string[] | undefined,
  );
  merged.websites = unionStr(
    perUser.websites as string[] | undefined,
    brand.websites as string[] | undefined,
  );
  merged.unsubscribeUrls = unionStr(
    perUser.unsubscribeUrls as string[] | undefined,
    brand.unsubscribeUrls as string[] | undefined,
  ).slice(0, 4);
  merged.postalAddresses = unionStr(
    perUser.postalAddresses as string[] | undefined,
    brand.postalAddresses as string[] | undefined,
  );
  // Brand-cased name only wins if the user hasn't customised it
  // (current heuristic: user's name === brandKey means default).
  if (!perUser.name || perUser.name === perUser.brandKey) {
    merged.name = brand.name || perUser.name || perUser.brandKey;
  }
  return merged;
}

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
    stripAds: !!s.stripAds,
    spamMarkedCount: (s.spamMarkedCount as number | undefined) ?? 0,
    rescuedCount: (s.rescuedCount as number | undefined) ?? 0,
    autoQuarantine: !!s.autoQuarantine,
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
  // Plan 14 — overlay the global SenderBrand for each. One bulk
  // fetch keyed on the brandKeys we know, then merge.
  const brandKeys = senders.map((s) => s.brandKey);
  const brands = brandKeys.length
    ? await SenderBrand.find({ brandKey: { $in: brandKeys } })
        .select(
          'brandKey name domain addresses websites logoUrl logoConfidence summary summaryGeneratedAt unsubscribeUrls postalAddresses forgottenBriefBy',
        )
        .lean()
    : [];
  const brandByKey = new Map(brands.map((b) => [b.brandKey, b as AnyDoc]));
  const merged = senders.map((s) =>
    mergeBrandIntoSender(s as AnyDoc, brandByKey.get(s.brandKey) ?? null, userId),
  );
  res.json({ senders: merged.map(listShape) });
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
  // Plan 14 — try per-user first (user has personal counters and
  // toggles for this sender), then fall back to global SenderBrand
  // so the brand chip on a wiki page links to /s/:brandKey even
  // when the current user has never personally interacted with the
  // sender.
  const sender = await Sender.findOne({ userId, addresses: addr })
    .select('brandKey name')
    .lean();
  if (sender) {
    res.json({ brandKey: sender.brandKey, name: sender.name });
    return;
  }
  const brand = await SenderBrand.findOne({ addresses: addr })
    .select('brandKey name')
    .lean();
  if (!brand) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json({ brandKey: brand.brandKey, name: brand.name });
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
  // Plan 14 — overlay the global brand row.
  const brand = await brandOverlay(sender.brandKey);
  const composed = mergeBrandIntoSender(sender.toObject() as AnyDoc, brand, userId);
  const composedAddresses = (composed.addresses as string[] | undefined) ?? sender.addresses ?? [];
  const pages = await Page.find({
    userId,
    senderAddresses: { $in: composedAddresses },
  })
    .sort({ updatedAt: -1 })
    .limit(8)
    .select('slug title summary heroImageUrl tags topics updatedAt sourceEmailIds')
    .lean();
  const recentEmails = await Email.find({
    userId,
    'from.address': { $in: composedAddresses },
  })
    .sort({ date: -1 })
    .limit(10)
    .select('subject date from')
    .lean();
  res.json({
    sender: { ...listShape(composed), unsubscribeUrls: (composed.unsubscribeUrls as string[] | undefined) ?? [] },
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
    stripAds?: boolean;
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
  if (typeof body.stripAds === 'boolean') {
    sender.stripAds = body.stripAds;
  }
  await sender.save();
  res.json({ sender: listShape(sender.toObject()) });
});

/**
 * Enqueue an LLM summary refresh. Clears the user-side lock and —
 * Plan 14 — also clears `SenderBrand.forgottenBriefBy` so other
 * users who'd previously hidden the brief see the refreshed
 * version. The summarize worker writes the new brief to BOTH the
 * per-user Sender row (legacy compat) and the global SenderBrand
 * (the source of truth).
 */
sendersRouter.post('/:brandKey/refresh', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const sender = await Sender.findOne({ userId, brandKey: req.params.brandKey });
  if (!sender) {
    res.status(404).json({ error: 'not_found', message: 'Sender not found' });
    return;
  }
  sender.summaryLocked = false;
  await sender.save();
  // Best-effort — the worker re-resets forgottenBriefBy on
  // successful write, but doing it now means existing renders
  // pick up the un-forget without waiting for the LLM round-trip.
  try {
    await SenderBrand.updateOne(
      { brandKey: sender.brandKey },
      { $set: { forgottenBriefBy: [] } },
    );
  } catch {
    /* non-fatal */
  }
  const job = await summarizeSenderQueue.add(
    'summarize',
    { senderId: String(sender._id), userId: String(userId) },
    { attempts: 2, removeOnComplete: 100, removeOnFail: 100 },
  );
  res.status(202).json({ jobId: job.id });
});

/**
 * "Forget" the brand brief for THIS user — Plan 14 makes briefs
 * global, so the per-user delete becomes a per-user mute on
 * SenderBrand (mirrors DaydreamNote forget). The per-user `Sender`
 * row stays in place because it carries personal counters /
 * toggles; only the brand-global brief gets hidden from this user's
 * views. Pass `?purgePerUser=true` to also drop the per-user row
 * (useful for clearing the codex of a sender you no longer want
 * tracked at all).
 */
sendersRouter.delete('/:brandKey/brief', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  await SenderBrand.updateOne(
    { brandKey: req.params.brandKey },
    { $addToSet: { forgottenBriefBy: userId } },
  );
  res.json({ ok: true });
});

sendersRouter.delete('/:brandKey', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  await Sender.deleteOne({ userId, brandKey: req.params.brandKey });
  res.json({ ok: true });
});
