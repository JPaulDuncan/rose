import { Router } from 'express';
import { Types } from 'mongoose';
import {
  SpamSenderRequest,
  SpamTagRequest,
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
