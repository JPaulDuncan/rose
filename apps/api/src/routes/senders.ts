import { Router } from 'express';
import { Types } from 'mongoose';
import { Sender, SenderBrand, User, Page, Email } from '@rose/db';
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
      'name domain addresses websites logoUrl logoConfidence summary summaryGeneratedAt unsubscribeUrls postalAddresses forgottenBriefBy firstSeenBy',
    )
    .lean();
  return (brand as AnyDoc | null) ?? null;
}

/**
 * Resolve a userId → displayName for the "contributed by" chip.
 * Returns empty string when the id is null or the user is gone.
 */
async function resolveContributorName(
  userId: Types.ObjectId | null | undefined,
): Promise<string> {
  if (!userId) return '';
  const u = await User.findById(userId).select('displayName').lean();
  return u?.displayName ?? '';
}

/**
 * Compose a per-user sender row + the global brand row into the
 * shape the UI expects. Plan 15 — the per-user side carries only
 * counters / toggles / explicit overrides
 * (`nameOverride`, `logoUrlOverride`); brand-global fields all
 * come from `SenderBrand`.
 *
 * Output keys mirror the pre-plan-15 Sender shape so existing UI
 * keeps working: `name`, `logoUrl`, `summary`, `addresses[]`,
 * `websites[]`, etc.
 */
function mergeBrandIntoSender(
  perUser: AnyDoc,
  brand: AnyDoc | null,
  userId: Types.ObjectId,
): AnyDoc {
  const out: AnyDoc = { ...perUser };
  // Display name: explicit user override > brand-global > brandKey.
  out.name =
    (perUser.nameOverride as string | null) ||
    (brand?.name as string | undefined) ||
    (perUser.brandKey as string);
  // Logo: explicit user override > brand-global > null.
  out.logoUrl =
    (perUser.logoUrlOverride as string | null) ??
    (brand?.logoUrl as string | null | undefined) ??
    null;
  out.logoConfidence = (brand?.logoConfidence as number | undefined) ?? 0;
  // Brief: brand-global, hidden when the user is in forgottenBriefBy.
  if (brand) {
    const forgotten = (brand.forgottenBriefBy as Types.ObjectId[] | undefined) ?? [];
    const isForgotten = forgotten.some((id) => String(id) === String(userId));
    out.summary = isForgotten ? '' : (brand.summary as string | undefined) ?? '';
    out.summaryGeneratedAt = isForgotten
      ? null
      : (brand.summaryGeneratedAt as Date | null | undefined) ?? null;
  } else {
    out.summary = '';
    out.summaryGeneratedAt = null;
  }
  // Brand-global arrays come straight from the brand row.
  out.domain = (brand?.domain as string | null | undefined) ?? null;
  out.addresses = (brand?.addresses as string[] | undefined) ?? [];
  out.websites = (brand?.websites as string[] | undefined) ?? [];
  out.unsubscribeUrls = ((brand?.unsubscribeUrls as string[] | undefined) ?? []).slice(0, 4);
  out.postalAddresses = (brand?.postalAddresses as string[] | undefined) ?? [];
  return out;
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
    /** Plan 15 — has the user explicitly overridden the brand-
     *  global display name / logo? UI uses this to render the
     *  "Promote to brand" button next to the override input. */
    nameOverride: (s.nameOverride as string | null) ?? null,
    logoUrlOverride: (s.logoUrlOverride as string | null) ?? null,
    /** Plan 15 — display name of the user whose mail first
     *  surfaced this brand. Empty string when missing. */
    contributedBy: (s.contributedBy as string | undefined) ?? '',
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
  const addr = req.params.address.toLowerCase();
  // Plan 15 — addresses live exclusively on SenderBrand (brand-
  // global). One lookup; no per-user fallback needed.
  const brand = await SenderBrand.findOne({ addresses: addr })
    .select('brandKey name')
    .lean();
  if (!brand) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json({ brandKey: brand.brandKey, name: brand.name ?? brand.brandKey });
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
  // Plans 14–15 — overlay the global brand row + resolve the
  // first-contributor display name for the attribution chip.
  const brand = await brandOverlay(sender.brandKey);
  const composed = mergeBrandIntoSender(sender.toObject() as AnyDoc, brand, userId);
  composed.contributedBy = await resolveContributorName(
    brand?.firstSeenBy as Types.ObjectId | null | undefined,
  );
  const composedAddresses = (composed.addresses as string[] | undefined) ?? [];
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

/**
 * Plan 15 — User PATCH writes:
 *   • `name` / `logoUrl` → per-user `nameOverride` / `logoUrlOverride`
 *     (only this user's view changes).
 *   • `stripAds` → per-user toggle.
 *   • `summary` → no longer accepted; the brief is brand-global.
 *     Use POST /:brandKey/refresh to regenerate (affects everyone)
 *     or DELETE /:brandKey/brief to mute for yourself.
 *
 * The "promote to brand" endpoints
 * (POST /:brandKey/promote-logo, /promote-name) flip an override
 * onto the global SenderBrand so it becomes everyone's default.
 */
sendersRouter.patch('/:brandKey', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const sender = await Sender.findOne({ userId, brandKey: req.params.brandKey });
  if (!sender) {
    res.status(404).json({ error: 'not_found', message: 'Sender not found' });
    return;
  }
  const body = (req.body ?? {}) as {
    name?: string | null;
    logoUrl?: string | null;
    stripAds?: boolean;
  };
  if (body.name === null) {
    sender.nameOverride = null;
  } else if (typeof body.name === 'string') {
    const trimmed = body.name.trim().slice(0, 80);
    sender.nameOverride = trimmed || null;
  }
  if (body.logoUrl === null) {
    sender.logoUrlOverride = null;
  } else if (typeof body.logoUrl === 'string') {
    const trimmed = body.logoUrl.trim();
    sender.logoUrlOverride = trimmed || null;
  }
  if (typeof body.stripAds === 'boolean') {
    sender.stripAds = body.stripAds;
  }
  await sender.save();
  // Compose the response with the brand overlay so the UI sees its
  // freshly-saved override merged against the brand row.
  const brand = await brandOverlay(sender.brandKey);
  const composed = mergeBrandIntoSender(sender.toObject() as AnyDoc, brand, userId);
  res.json({ sender: listShape(composed) });
});

/**
 * Promote the user's `logoUrlOverride` (or, when no override is set,
 * the brand's current logo at high confidence) onto SenderBrand
 * globally. After this fires the user's override clears — the
 * promoted value IS the brand default now, so it'd render the same
 * either way.
 *
 * Plan 15. Pairs with the global "forget" model — anyone can refresh
 * what's shared, anyone can mute it from their own view. Promoting
 * a logo is the additive flip side: the user contributes their
 * better data back to the shared row.
 */
sendersRouter.post('/:brandKey/promote-logo', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const sender = await Sender.findOne({ userId, brandKey: req.params.brandKey });
  if (!sender) {
    res.status(404).json({ error: 'not_found', message: 'Sender not found' });
    return;
  }
  const target = sender.logoUrlOverride;
  if (!target) {
    res.status(400).json({
      error: 'invalid_request',
      message: 'No logo override on this sender to promote.',
    });
    return;
  }
  await SenderBrand.updateOne(
    { brandKey: sender.brandKey },
    {
      $setOnInsert: {
        brandKey: sender.brandKey,
        firstSeenBy: userId,
      },
      $set: {
        logoUrl: target,
        logoConfidence: 1,
      },
    },
    { upsert: true },
  );
  // Clear the per-user override now that it's the global default.
  sender.logoUrlOverride = null;
  await sender.save();
  res.json({ ok: true });
});

/**
 * Same shape as promote-logo but for the display name. Promotes
 * `nameOverride` onto `SenderBrand.name` and clears the per-user
 * override.
 */
sendersRouter.post('/:brandKey/promote-name', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const sender = await Sender.findOne({ userId, brandKey: req.params.brandKey });
  if (!sender) {
    res.status(404).json({ error: 'not_found', message: 'Sender not found' });
    return;
  }
  const target = sender.nameOverride;
  if (!target) {
    res.status(400).json({
      error: 'invalid_request',
      message: 'No name override on this sender to promote.',
    });
    return;
  }
  await SenderBrand.updateOne(
    { brandKey: sender.brandKey },
    {
      $setOnInsert: {
        brandKey: sender.brandKey,
        firstSeenBy: userId,
      },
      $set: { name: target.slice(0, 80) },
    },
    { upsert: true },
  );
  sender.nameOverride = null;
  await sender.save();
  res.json({ ok: true });
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
  // Plan 15 — `summaryLocked` is gone; the brief is brand-global,
  // so nothing to "unlock" before regenerating. Clear
  // `forgottenBriefBy` immediately so existing renders pick up the
  // un-forget without waiting for the LLM round-trip; the worker
  // re-clears it on successful write.
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
