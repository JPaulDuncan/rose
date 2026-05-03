import { Router } from 'express';
import { Types } from 'mongoose';
import {
  SpamSenderRequest,
  SpamTagRequest,
  type SpamPolicy,
} from '@rose/shared';
import { User, Page } from '@rose/db';
import { userIdOf } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';

export const spamRouter: Router = Router();

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
  res.json({ ok: true, address, pagesAffected: r.modifiedCount ?? 0 });
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

/** Per-page mark/unmark — does not change the global policy. */
spamRouter.post('/page/:id', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const r = await Page.updateOne(
    { _id: req.params.id, userId },
    { $set: { 'flags.userMarkedSpam': true } },
  );
  res.json({ ok: true, modified: r.modifiedCount ?? 0 });
});

spamRouter.delete('/page/:id', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const r = await Page.updateOne(
    { _id: req.params.id, userId },
    { $set: { 'flags.userMarkedSpam': false } },
  );
  res.json({ ok: true, modified: r.modifiedCount ?? 0 });
});
