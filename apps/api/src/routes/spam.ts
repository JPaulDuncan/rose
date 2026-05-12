import { Router } from 'express';
import { Types } from 'mongoose';
import {
  SpamSenderRequest,
  SpamTagRequest,
  BlockSenderRequest,
  type SpamPolicy,
} from '@rose/shared';
import { User, Page, Sender, SenderBrand, Email } from '@rose/db';
import { senderDomainTag } from '@rose/email-parser';
import { userIdOf } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import {
  trainBayesForEmails,
  untrainBayesForEmails,
} from '../lib/bayesStore.js';
import { emitRecipeEvent } from '../lib/recipeEmit.js';

export const spamRouter: Router = Router();

/**
 * How many *net* spam-marks (spamMarkedCount − rescuedCount) it takes
 * before a Sender is flagged for auto-quarantine. Low so users get a
 * fast feedback loop, but not 1 — a single mismark shouldn't block a
 * brand they actually want.
 */
const QUARANTINE_THRESHOLD = 3;

function brandKeyFor(addr: string): { brandKey: string; name: string; domain: string | null } | null {
  const at = addr.lastIndexOf('@');
  if (at < 0) {
    // Bare-host whitelist entry (`axios.com`). Synthesise a local
    // part so senderDomainTag has something to chew on, then derive
    // the brand from the host the same way address-shaped entries do.
    const host = addr.toLowerCase();
    const brand = senderDomainTag(`x@${host}`);
    if (brand) return { brandKey: brand.toLowerCase(), name: brand, domain: host };
    return null;
  }
  const local = addr.slice(0, at).toLowerCase();
  const domain = addr.slice(at + 1).toLowerCase();
  const brand = senderDomainTag(addr);
  if (brand) return { brandKey: brand.toLowerCase(), name: brand, domain };
  return { brandKey: `${local}@${domain}`, name: addr, domain };
}

/**
 * Lift the auto-quarantine + user-spam flags off every page that
 * shares a brand with `address`, and reset the corresponding Sender
 * row(s). Used by both the explicit `/sender/:address/trust` action
 * and the whitelist POST so that whitelisting `news@axios.com` also
 * releases the existing `*.axios.com` pages sitting in quarantine.
 *
 * Brand resolution is the same as everywhere else (senderDomainTag /
 * eTLD+1), so `axios.com` covers `api.axios.com` and `help.axios.com`.
 * If the address is a personal-mail provider (no brand), we fall
 * back to an exact-address match so we don't accidentally rescue
 * unrelated mail from gmail.com, outlook.com, etc.
 */
async function liftQuarantineForBrand(
  userId: Types.ObjectId,
  address: string,
): Promise<void> {
  const info = brandKeyFor(address);
  if (info && info.brandKey && !info.brandKey.includes('@')) {
    // Brand match — pull the brand-global address list (every
    // address any user has ever seen for this brand) and use that
    // as the page filter so subdomain siblings (`api.axios.com`,
    // `help.axios.com`) get rescued alongside the address the user
    // actually trusted.
    const brand = await SenderBrand.findOne({ brandKey: info.brandKey })
      .select('addresses')
      .lean();
    const addressSet = new Set<string>([address]);
    for (const a of (brand?.addresses as string[] | undefined) ?? []) {
      addressSet.add(a.toLowerCase());
    }
    await Sender.updateMany(
      { userId, brandKey: info.brandKey },
      { $set: { autoQuarantine: false, spamMarkedCount: 0, rescuedCount: 0 } },
    );
    if (addressSet.size > 0) {
      await Page.updateMany(
        { userId, senderAddresses: { $in: [...addressSet] } },
        { $set: { 'flags.userMarkedSpam': false, 'flags.autoQuarantined': false } },
      );
    }
    return;
  }
  // Personal-mail / unbrandable fallback: exact address only.
  await Page.updateMany(
    { userId, senderAddresses: address },
    { $set: { 'flags.userMarkedSpam': false, 'flags.autoQuarantined': false } },
  );
}


/**
 * Days a spam-mark "lives" before it stops counting toward the
 * auto-quarantine threshold. After 30 days with no fresh mark, one
 * mark drops off; after 60 days, two; etc. Capped at the existing
 * spamMarkedCount.
 */
const MARK_DECAY_DAYS = 30;

export function decayedSpamMarks(s: {
  spamMarkedCount?: number;
  rescuedCount?: number;
  lastMarkedAt?: Date | null;
}): { effective: number; decayed: number } {
  const raw = (s.spamMarkedCount ?? 0) - (s.rescuedCount ?? 0);
  if (raw <= 0) return { effective: 0, decayed: 0 };
  if (!s.lastMarkedAt) return { effective: raw, decayed: 0 };
  const days = Math.max(
    0,
    Math.floor((Date.now() - new Date(s.lastMarkedAt).getTime()) / (24 * 3600 * 1000)),
  );
  const decayed = Math.floor(days / MARK_DECAY_DAYS);
  return { effective: Math.max(0, raw - decayed), decayed };
}

/**
 * Apply this user's spam / rescue verdict to the GLOBAL SenderBrand
 * row for the given brandKey. Idempotent — re-marking is a no-op
 * (the user is already in the set). Flips `globalSpam` whenever the
 * net set tips: marked > rescued ⇒ flagged for everyone.
 *
 * The directive: "once an item has been marked spam by ANY user,
 * it's marked as spam for ALL users." The threshold is therefore 1
 * net spam-mark, not the higher per-user `QUARANTINE_THRESHOLD`.
 * The opt-in list (`spamPolicy.optInGlobalSpamBrands`) is each
 * user's escape hatch.
 */
async function recordGlobalSpamVerdict(
  brandKey: string,
  userId: Types.ObjectId,
  verdict: 'spam' | 'rescued',
): Promise<void> {
  if (!brandKey) return;
  // First add/remove the user from the appropriate set in one
  // round-trip; then re-fetch to compute `globalSpam` and bump
  // `firstFlaggedAt` if we just crossed the threshold.
  const ops: Record<string, unknown> =
    verdict === 'spam'
      ? {
          $addToSet: { spamMarkedBy: userId },
          $pull: { rescuedBy: userId },
        }
      : {
          $addToSet: { rescuedBy: userId },
          $pull: { spamMarkedBy: userId },
        };
  // Ensure the row exists — some brands first appear via this path
  // (a user marks an address whose Sender row exists but whose
  // SenderBrand row hasn't been created yet because they haven't
  // received mail in this session).
  await SenderBrand.updateOne(
    { brandKey },
    {
      ...ops,
      $setOnInsert: {
        brandKey,
        firstSeenBy: userId,
      },
    },
    { upsert: true },
  );
  const after = await SenderBrand.findOne({ brandKey })
    .select('spamMarkedBy rescuedBy globalSpam firstFlaggedAt')
    .lean();
  if (!after) return;
  const marked = (after.spamMarkedBy as Types.ObjectId[] | undefined)?.length ?? 0;
  const rescued = (after.rescuedBy as Types.ObjectId[] | undefined)?.length ?? 0;
  const shouldFlag = marked > rescued;
  if (shouldFlag !== !!after.globalSpam) {
    await SenderBrand.updateOne(
      { brandKey },
      {
        $set: {
          globalSpam: shouldFlag,
          ...(shouldFlag && !after.firstFlaggedAt
            ? { firstFlaggedAt: new Date() }
            : {}),
        },
      },
    );
  }
}

/**
 * Feedback-loop bookkeeping: every spam-mark increments the matching
 * Sender's spamMarkedCount, every rescue increments rescuedCount.
 * `autoQuarantine` flips on once *decayed* net marks ≥ threshold, so
 * old marks gradually lose weight and a one-off mismark from months
 * ago can't keep blocking a brand.
 *
 * Also dual-writes the verdict to the GLOBAL SenderBrand row so the
 * cross-user blacklist picks it up.
 */
async function bumpSenderReputation(
  userId: Types.ObjectId,
  addresses: string[],
  delta: { spam?: number; rescued?: number },
): Promise<void> {
  const seenBrands = new Set<string>();
  for (const addr of addresses) {
    const info = brandKeyFor(addr.toLowerCase());
    if (!info || seenBrands.has(info.brandKey)) continue;
    seenBrands.add(info.brandKey);
    const sender =
      (await Sender.findOne({ userId, brandKey: info.brandKey })) ??
      (await Sender.create({
        userId,
        brandKey: info.brandKey,
        name: info.name,
        domain: info.domain,
        addresses: [addr.toLowerCase()],
      }));
    sender.spamMarkedCount = Math.max(0, (sender.spamMarkedCount ?? 0) + (delta.spam ?? 0));
    sender.rescuedCount = Math.max(0, (sender.rescuedCount ?? 0) + (delta.rescued ?? 0));
    if ((delta.spam ?? 0) > 0) sender.lastMarkedAt = new Date();
    const { effective } = decayedSpamMarks(sender);
    sender.autoQuarantine = effective >= QUARANTINE_THRESHOLD;
    await sender.save();
    // Cross-user blacklist. ANY user's mark flips the global flag;
    // any user's rescue can pull them off it. Per-brand, idempotent.
    if ((delta.spam ?? 0) > 0) {
      await recordGlobalSpamVerdict(info.brandKey, userId, 'spam');
    } else if ((delta.rescued ?? 0) > 0) {
      await recordGlobalSpamVerdict(info.brandKey, userId, 'rescued');
    }
  }
}

function normSender(addr: string): string {
  return addr.trim().toLowerCase();
}
function normTag(tag: string): string {
  return tag.trim().toLowerCase();
}

async function getPolicy(userId: Types.ObjectId): Promise<SpamPolicy> {
  const user = await User.findById(userId).select('spamPolicy').lean();
  return {
    senders: (user?.spamPolicy?.senders as string[] | undefined) ?? [],
    tags: (user?.spamPolicy?.tags as string[] | undefined) ?? [],
    blockedSenders:
      (user?.spamPolicy?.blockedSenders as string[] | undefined) ?? [],
    whitelistedSenders:
      (user?.spamPolicy?.whitelistedSenders as string[] | undefined) ?? [],
  };
}

spamRouter.get('/', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  res.json(await getPolicy(userId));
});

/**
 * Cascade a sender flag onto every page that lists this sender.
 * `flags.userMarkedSpam` is OR'd in — never cleared by this op alone.
 */
spamRouter.post('/sender', validateBody(SpamSenderRequest), async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const address = normSender((req.body as { address: string }).address);
  await User.updateOne(
    { _id: userId },
    { $addToSet: { 'spamPolicy.senders': address } },
  );
  const r = await Page.updateMany(
    { userId, senderAddresses: address },
    { $set: { 'flags.userMarkedSpam': true } },
  );
  // Hard reputation hit — blocking a sender from the address book is
  // the strongest possible signal, so push net marks well past the
  // auto-quarantine threshold immediately.
  await bumpSenderReputation(userId, [address], { spam: QUARANTINE_THRESHOLD });
  // Train the per-user Bayes classifier on every email from this
  // sender — capped to keep blocking cheap.
  const emails = await Email.find({ userId, 'from.address': address })
    .sort({ date: -1 })
    .limit(200)
    .select('subject text')
    .lean();
  await trainBayesForEmails(userId, emails, true);
  res.json({
    ok: true,
    address,
    pagesAffected: r.modifiedCount ?? 0,
    bayesTrained: emails.length,
  });
});

spamRouter.delete('/sender/:address', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const address = normSender(decodeURIComponent(req.params.address ?? ''));
  await User.updateOne(
    { _id: userId },
    { $pull: { 'spamPolicy.senders': address } },
  );
  // Recompute userMarkedSpam for previously-affected pages: clear the flag
  // unless another policy rule still applies.
  const policy = await getPolicy(userId);
  await Page.updateMany(
    {
      userId,
      senderAddresses: address,
      $nor: [
        { senderAddresses: { $in: policy.senders } },
        { tags: { $in: policy.tags } },
        { topics: { $in: policy.tags } },
      ],
    },
    { $set: { 'flags.userMarkedSpam': false } },
  );
  // Walk back the Bayes training we did when blocking this sender.
  const emails = await Email.find({ userId, 'from.address': address })
    .sort({ date: -1 })
    .limit(200)
    .select('subject text')
    .lean();
  await untrainBayesForEmails(userId, emails, true);
  res.json({ ok: true });
});

spamRouter.post('/tag', validateBody(SpamTagRequest), async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const tag = normTag((req.body as { tag: string }).tag);
  await User.updateOne(
    { _id: userId },
    { $addToSet: { 'spamPolicy.tags': tag } },
  );
  const r = await Page.updateMany(
    { userId, $or: [{ tags: tag }, { topics: tag }] },
    { $set: { 'flags.userMarkedSpam': true } },
  );
  res.json({ ok: true, tag, pagesAffected: r.modifiedCount ?? 0 });
});

spamRouter.delete('/tag/:tag', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const tag = normTag(decodeURIComponent(req.params.tag ?? ''));
  await User.updateOne({ _id: userId }, { $pull: { 'spamPolicy.tags': tag } });
  const policy = await getPolicy(userId);
  await Page.updateMany(
    {
      userId,
      $or: [{ tags: tag }, { topics: tag }],
      $nor: [
        { senderAddresses: { $in: policy.senders } },
        { tags: { $in: policy.tags } },
        { topics: { $in: policy.tags } },
      ],
    },
    { $set: { 'flags.userMarkedSpam': false } },
  );
  res.json({ ok: true });
});

/** Per-page mark/unmark — does not change the global policy.
 *  Marking bumps each contributing sender's reputation; if the net
 *  marks cross the threshold, the Sender is auto-quarantined and
 *  future pages from them will be hidden by default. */
spamRouter.post('/page/:id', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const page = await Page.findOne({ _id: req.params.id, userId }).select(
    'senderAddresses flags',
  );
  if (!page) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const wasSpam = !!page.flags?.userMarkedSpam;
  page.set('flags.userMarkedSpam', true);
  await page.save();
  if (!wasSpam) {
    await bumpSenderReputation(userId, page.senderAddresses ?? [], { spam: 1 });
    const emails = await Email.find({ userId, pageId: page._id })
      .select('subject text')
      .lean();
    await trainBayesForEmails(userId, emails, true);
  }
  res.json({ ok: true });
});

/** Rescue a quarantined or user-marked-spam page. Clears both flags
 *  and credits the contributing senders, walking back the
 *  auto-quarantine if their net marks fall below the threshold. */
spamRouter.delete('/page/:id', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const page = await Page.findOne({ _id: req.params.id, userId }).select(
    'senderAddresses flags',
  );
  if (!page) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const wasUserMarked = !!page.flags?.userMarkedSpam;
  const wasFlagged =
    !!page.flags?.userMarkedSpam || !!page.flags?.autoQuarantined;
  page.set('flags.userMarkedSpam', false);
  page.set('flags.autoQuarantined', false);
  await page.save();
  if (wasFlagged) {
    await bumpSenderReputation(userId, page.senderAddresses ?? [], { rescued: 1 });
    const emails = await Email.find({ userId, pageId: page._id })
      .select('subject text')
      .lean();
    // If the page was previously a *user-marked* spam, walk back the
    // Bayes spam training. Either way, retrain as ham so the model
    // learns "this kind of mail is OK".
    if (wasUserMarked) {
      await untrainBayesForEmails(userId, emails, true);
    }
    await trainBayesForEmails(userId, emails, false);
  }
  res.json({ ok: true });
});

/** Trust a sender outright — clears the auto-quarantine flag and
 *  resets their reputation counters so future pages from them surface
 *  normally again. Also records a global rescue and adds the brand
 *  to this user's opt-in list so a cross-user spam flag won't
 *  re-quarantine them. */
spamRouter.post('/sender/:address/trust', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const address = normSender(decodeURIComponent(req.params.address ?? ''));
  const info = brandKeyFor(address);
  const updates: Record<string, unknown> = {
    $pull: { 'spamPolicy.senders': address },
  };
  if (info?.brandKey) {
    updates.$addToSet = {
      'spamPolicy.optInGlobalSpamBrands': info.brandKey,
    };
  }
  await User.updateOne({ _id: userId }, updates);
  // Brand-wide cleanup: clears Sender.autoQuarantine and lifts the
  // userMarkedSpam / autoQuarantined flags off every page in the
  // same registrable-domain family.
  await liftQuarantineForBrand(userId, address);
  if (info?.brandKey) {
    await recordGlobalSpamVerdict(info.brandKey, userId, 'rescued');
  }
  // Train the Bayes classifier on this brand's recent mail as ham —
  // explicit trust is just as strong a signal as a rescue.
  const emails = await Email.find({ userId, 'from.address': address })
    .sort({ date: -1 })
    .limit(200)
    .select('subject text')
    .lean();
  await trainBayesForEmails(userId, emails, false);
  res.json({ ok: true, address, bayesTrained: emails.length });
});

/**
 * Block a sender at the ingestion layer. Anything from this address
 * (or that arrived from it before the block) gets dropped:
 *  - The address is added to spamPolicy.blockedSenders, which the
 *    IMAP/Gmail workers consult before persisting any new message.
 *  - Existing emails from this sender are deleted; pages where this
 *    sender was the *only* contributor are deleted too (pages with
 *    other contributors stay but lose the blocked sender's emails).
 *  - The Bayes classifier is trained on the sender's recent mail as
 *    spam, same as a hard block.
 *
 * Stronger than `mark sender as spam` (which keeps the data and just
 * hides the page). Reversible via DELETE /api/spam/block/:address.
 */
spamRouter.post('/block', validateBody(BlockSenderRequest), async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const body = req.body as { address: string; removeExisting?: boolean };
  const address = normSender(body.address);
  const removeExisting = body.removeExisting !== false;

  await User.updateOne(
    { _id: userId },
    {
      // Atomic add to blocklist; pull from spam-marked list so the
      // two policies don't double-count this sender.
      $addToSet: { 'spamPolicy.blockedSenders': address },
      $pull: { 'spamPolicy.senders': address },
    },
  );

  let emailsDeleted = 0;
  let pagesDeleted = 0;
  let pagesPruned = 0;
  if (removeExisting) {
    // Brand-aware match: blocking `notices.medium.com` should
    // delete every other `*.medium.com` row too. We compute the
    // candidate brand for the blocked address; if it's a real
    // brand, every email whose from-address resolves to the same
    // brand gets purged. Personal-mail providers (gmail.com, …)
    // return null from senderDomainTag and fall through to the
    // exact-address path, preserving "block boss@example.com
    // doesn't kill cousin@example.com" semantics.
    const brand = senderDomainTag(address)?.toLowerCase() ?? null;
    const matchedEmails = await Email.find({ userId })
      .select('from')
      .lean();
    const matchedAddresses = new Set<string>();
    matchedAddresses.add(address);
    if (brand) {
      for (const e of matchedEmails) {
        const from = (e.from as { address?: string } | null)?.address?.toLowerCase();
        if (!from) continue;
        if (senderDomainTag(from)?.toLowerCase() === brand) {
          matchedAddresses.add(from);
        }
      }
    }
    const addrFilter =
      matchedAddresses.size === 1
        ? { 'from.address': address }
        : { 'from.address': { $in: [...matchedAddresses] } };
    // Train the Bayes classifier first while the spam emails still
    // exist — once we delete them we lose the training corpus.
    const emails = await Email.find({ userId, ...addrFilter })
      .sort({ date: -1 })
      .limit(200)
      .select('subject text')
      .lean();
    await trainBayesForEmails(userId, emails, true);

    // Identify pages any matching address contributed to. Pages
    // where the matched set is the SOLE contributor get deleted;
    // pages with other contributors just lose the blocked addresses.
    const senderAddrFilter =
      matchedAddresses.size === 1
        ? { senderAddresses: address }
        : { senderAddresses: { $in: [...matchedAddresses] } };
    const affectedPages = await Page.find({ userId, ...senderAddrFilter })
      .select('_id senderAddresses sourceEmailIds')
      .lean();
    for (const page of affectedPages) {
      const others = (page.senderAddresses ?? []).filter(
        (a: string) => !matchedAddresses.has(a),
      );
      if (others.length === 0) {
        await Page.deleteOne({ _id: page._id, userId });
        pagesDeleted += 1;
      } else {
        await Page.updateOne(
          { _id: page._id, userId },
          { $pull: { senderAddresses: { $in: [...matchedAddresses] } } },
        );
        pagesPruned += 1;
      }
    }

    const r = await Email.deleteMany({ userId, ...addrFilter });
    emailsDeleted = r.deletedCount ?? 0;
  }

  // Pipeline event — fire-and-forget. Lets users hook a webhook /
  // notification on every block ("just blocked notices@x; 47 emails
  // purged"). The brandKey carries through so recipes can filter on
  // "only fire for marketing brands, ignore personal addresses."
  const eventBrand = senderDomainTag(address)?.toLowerCase() ?? null;
  await emitRecipeEvent({
    kind: 'sender.blocked',
    userId: String(userId),
    address,
    brandKey: eventBrand,
    emailsDeleted,
    pagesDeleted,
  });

  res.json({
    ok: true,
    address,
    emailsDeleted,
    pagesDeleted,
    pagesPruned,
  });
});

spamRouter.delete('/block/:address', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const address = normSender(decodeURIComponent(req.params.address ?? ''));
  await User.updateOne(
    { _id: userId },
    { $pull: { 'spamPolicy.blockedSenders': address } },
  );
  res.json({ ok: true, address });
});

/**
 * Trusted-sender whitelist. Mirrors the blocklist routes — POST
 * adds, DELETE removes — but the effect is the inverse: the entry
 * bypasses the blocklist, the spam classifier, and the
 * auto-quarantine sweep. Useful for newsletters or transactional
 * senders the user explicitly trusts despite spam-y signals.
 *
 * The .gov / .edu TLDs are implicitly whitelisted regardless of
 * the contents of this list (see `isSenderWhitelisted` in
 * @rose/email-parser); the list is for everything else.
 */
spamRouter.post(
  '/whitelist',
  validateBody(SpamSenderRequest),
  async (req, res) => {
    const userId = new Types.ObjectId(userIdOf(req));
    const address = normSender((req.body as { address: string }).address);
    if (!address) {
      res.status(400).json({ error: 'invalid_request', message: 'address required' });
      return;
    }
    const info = brandKeyFor(address);
    await User.updateOne(
      { _id: userId },
      {
        $addToSet: {
          'spamPolicy.whitelistedSenders': address,
          // Whitelist is also a global-blacklist opt-in: the user
          // has explicitly said "I want this brand's mail" — honor
          // that even if other users have flagged the brand.
          ...(info?.brandKey
            ? { 'spamPolicy.optInGlobalSpamBrands': info.brandKey }
            : {}),
        },
        // A whitelisted sender shouldn't simultaneously be on the
        // spam-mark list. Pull it from there if it was added in the
        // past so the two lists don't contradict each other.
        $pull: { 'spamPolicy.senders': address },
      },
    );
    if (info?.brandKey) {
      await recordGlobalSpamVerdict(info.brandKey, userId, 'rescued');
    }
    // Without this, whitelisting only affects future ingest — pages
    // already sitting in Quarantine for this brand stay there until
    // a new email regenerates them. Treat the whitelist add as an
    // explicit trust signal and release the brand's existing pages
    // immediately, including subdomain siblings (`api.axios.com`,
    // `help.axios.com` when the user trusts `news@axios.com`).
    await liftQuarantineForBrand(userId, address);
    res.json({ ok: true, address });
  },
);

spamRouter.delete('/whitelist/:address', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const address = normSender(decodeURIComponent(req.params.address ?? ''));
  await User.updateOne(
    { _id: userId },
    { $pull: { 'spamPolicy.whitelistedSenders': address } },
  );
  res.json({ ok: true, address });
});

// ── Global blacklist (cross-user spam) ─────────────────────────
//
// One mark from any user flips a brand to globally-flagged. Other
// users can opt-in to receive its mail anyway — the opt-in list is
// per-user, the blacklist itself is shared. Reputational rankings
// surface "flagged by N users" as a sort key + a decision aid.

/**
 * List every brand currently on the global blacklist alongside the
 * current user's opt-in state. Sorted by net spam marks descending
 * so the most-reported brands surface first.
 */
spamRouter.get('/global', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const user = await User.findById(userId)
    .select('spamPolicy.optInGlobalSpamBrands')
    .lean();
  const optIns = new Set<string>(
    ((user?.spamPolicy as { optInGlobalSpamBrands?: string[] } | undefined)
      ?.optInGlobalSpamBrands ?? []) as string[],
  );
  // Pull only flagged rows; the index on `globalSpam` keeps this
  // cheap as the blacklist grows.
  const rows = await SenderBrand.find({ globalSpam: true })
    .select(
      'brandKey domain name spamMarkedBy rescuedBy firstFlaggedAt logoUrl',
    )
    .lean();
  const blacklist = rows
    .map((r) => {
      const marked = ((r.spamMarkedBy as Types.ObjectId[] | undefined) ?? []).length;
      const rescued = ((r.rescuedBy as Types.ObjectId[] | undefined) ?? []).length;
      const net = marked - rescued;
      // Coarse rank label so the UI can colour the chip without
      // re-deriving thresholds. Tweakable; the worker only cares
      // about the boolean `globalSpam` flag.
      const rank: 'high' | 'medium' | 'low' =
        net >= 5 ? 'high' : net >= 2 ? 'medium' : 'low';
      return {
        brandKey: r.brandKey as string,
        domain: (r.domain as string | null) ?? null,
        name: (r.name as string | undefined) ?? r.brandKey,
        logoUrl: (r.logoUrl as string | null) ?? null,
        markedCount: marked,
        rescuedCount: rescued,
        netReports: net,
        rank,
        firstFlaggedAt: r.firstFlaggedAt
          ? new Date(r.firstFlaggedAt as Date).toISOString()
          : null,
        optedIn: optIns.has(r.brandKey as string),
      };
    })
    .sort((a, b) => b.netReports - a.netReports || a.brandKey.localeCompare(b.brandKey));
  res.json({ blacklist });
});

/** Opt this user IN to receive a globally-blacklisted brand. */
spamRouter.post('/optin/:brandKey', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const brandKey = (req.params.brandKey ?? '').toLowerCase().trim();
  if (!brandKey) {
    res.status(400).json({ error: 'invalid_request', message: 'brandKey required' });
    return;
  }
  await User.updateOne(
    { _id: userId },
    { $addToSet: { 'spamPolicy.optInGlobalSpamBrands': brandKey } },
  );
  // Lift the user's locally-recorded auto-quarantine for this brand
  // so previously-quarantined pages reappear right away. We don't
  // touch the global flag — other users may still want it filtered.
  // Pull addresses off the brand row so we can rescue pages whose
  // contributing-sender list overlaps with the brand's address set
  // (`api.axios.com`, `news@axios.com`, etc.).
  await Sender.updateMany(
    { userId, brandKey },
    { $set: { autoQuarantine: false, spamMarkedCount: 0, rescuedCount: 0 } },
  );
  const brand = await SenderBrand.findOne({ brandKey })
    .select('addresses')
    .lean();
  const addresses = ((brand?.addresses as string[] | undefined) ?? []).map((a) =>
    a.toLowerCase(),
  );
  if (addresses.length > 0) {
    await Page.updateMany(
      { userId, senderAddresses: { $in: addresses } },
      { $set: { 'flags.userMarkedSpam': false, 'flags.autoQuarantined': false } },
    );
  }
  res.json({ ok: true, brandKey });
});

/** Re-honor the global blacklist for this brand. */
spamRouter.delete('/optin/:brandKey', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const brandKey = (req.params.brandKey ?? '').toLowerCase().trim();
  if (!brandKey) {
    res.status(400).json({ error: 'invalid_request', message: 'brandKey required' });
    return;
  }
  await User.updateOne(
    { _id: userId },
    { $pull: { 'spamPolicy.optInGlobalSpamBrands': brandKey } },
  );
  res.json({ ok: true, brandKey });
});
