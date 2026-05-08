import { Router } from 'express';
import { Types } from 'mongoose';
import {
  SpamSenderRequest,
  SpamTagRequest,
  BlockSenderRequest,
  type SpamPolicy,
} from '@rose/shared';
import { User, Page, Sender, Email } from '@rose/db';
import { senderDomainTag } from '@rose/email-parser';
import { userIdOf } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import {
  trainBayesForEmails,
  untrainBayesForEmails,
} from '../lib/bayesStore.js';

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
  if (at < 0) return null;
  const local = addr.slice(0, at).toLowerCase();
  const domain = addr.slice(at + 1).toLowerCase();
  const brand = senderDomainTag(addr);
  if (brand) return { brandKey: brand.toLowerCase(), name: brand, domain };
  return { brandKey: `${local}@${domain}`, name: addr, domain };
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
 * Feedback-loop bookkeeping: every spam-mark increments the matching
 * Sender's spamMarkedCount, every rescue increments rescuedCount.
 * `autoQuarantine` flips on once *decayed* net marks ≥ threshold, so
 * old marks gradually lose weight and a one-off mismark from months
 * ago can't keep blocking a brand.
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
 *  normally again. */
spamRouter.post('/sender/:address/trust', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const address = normSender(decodeURIComponent(req.params.address ?? ''));
  await User.updateOne(
    { _id: userId },
    { $pull: { 'spamPolicy.senders': address } },
  );
  const info = brandKeyFor(address);
  if (info) {
    await Sender.updateOne(
      { userId, brandKey: info.brandKey },
      {
        $set: { autoQuarantine: false, spamMarkedCount: 0, rescuedCount: 0 },
      },
    );
  }
  // Lift the spam flags from this sender's existing pages too.
  await Page.updateMany(
    { userId, senderAddresses: address },
    { $set: { 'flags.userMarkedSpam': false, 'flags.autoQuarantined': false } },
  );
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
    await User.updateOne(
      { _id: userId },
      {
        $addToSet: { 'spamPolicy.whitelistedSenders': address },
        // A whitelisted sender shouldn't simultaneously be on the
        // spam-mark list. Pull it from there if it was added in the
        // past so the two lists don't contradict each other.
        $pull: { 'spamPolicy.senders': address },
      },
    );
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
