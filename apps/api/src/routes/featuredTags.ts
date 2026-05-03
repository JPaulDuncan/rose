import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { User } from '@rose/db';
import { userIdOf } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';

export const featuredTagsRouter: Router = Router();

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
