import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { User } from '@rose/db';
import { userIdOf } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { tagDigestQueue } from '../lib/queues.js';

export const featuredTagsRouter: Router = Router();

function utcDayKey(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

const FeatureRequest = z.object({
  tag: z.string().min(1).max(80),
});

featuredTagsRouter.get('/', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const user = await User.findById(userId).select('featuredTags').lean();
  res.json({ tags: (user?.featuredTags as string[] | undefined) ?? [] });
});

featuredTagsRouter.post('/', validateBody(FeatureRequest), async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const tag = (req.body as { tag: string }).tag.trim().toLowerCase();
  // $addToSet keeps insertion order on first add; on existing tags it's a no-op.
  await User.updateOne(
    { _id: userId },
    { $addToSet: { featuredTags: tag } },
  );
  // Eagerly enqueue today's digest for this tag so the home edition's
  // section gets a real lede on the next reload instead of waiting up
  // to an hour for the sweeper. JobId is collapsed by (user, tag, day).
  try {
    await tagDigestQueue.add(
      'digest',
      { userId: String(userId), tag },
      {
        jobId: `digest__${String(userId)}__${tag}__${utcDayKey()}`,
        attempts: 1,
        removeOnComplete: 200,
        removeOnFail: 200,
      },
    );
  } catch {
    // Don't fail the pin on a queue hiccup — sweeper covers it.
  }
  const user = await User.findById(userId).select('featuredTags').lean();
  res.json({ tags: (user?.featuredTags as string[] | undefined) ?? [] });
});

featuredTagsRouter.delete('/:tag', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const tag = decodeURIComponent(req.params.tag ?? '').trim().toLowerCase();
  await User.updateOne({ _id: userId }, { $pull: { featuredTags: tag } });
  const user = await User.findById(userId).select('featuredTags').lean();
  res.json({ tags: (user?.featuredTags as string[] | undefined) ?? [] });
});
