import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { User, Category } from '@rose/db';
import { userIdOf } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';

export const featuredCategoriesRouter: Router = Router();

/**
 * Mirrors `/api/featured-tags` but pins Category rows (desks +
 * ad-hoc) instead of tag strings. Same UX, same persistence
 * shape — User.featuredCategoryIds[] is an ordered array of
 * category ObjectId strings. The home page + briefing both
 * render each pinned category as its own section, populated with
 * the category's most-recently-updated pages.
 *
 * Stored as string IDs (matching the featuredTags convention) so
 * the array shape stays flat + easy to manipulate via $addToSet /
 * $pull. Validation against the user's actual Category rows
 * happens at POST time — we refuse to pin an id that doesn't
 * resolve, preventing dead entries from ever entering the array.
 */

const FeatureRequest = z.object({
  categoryId: z.string().min(1).max(40),
});

featuredCategoriesRouter.get('/', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const user = await User.findById(userId).select('featuredCategoryIds').lean();
  res.json({
    categoryIds: (user?.featuredCategoryIds as string[] | undefined) ?? [],
  });
});

featuredCategoriesRouter.post(
  '/',
  validateBody(FeatureRequest),
  async (req, res) => {
    const userId = new Types.ObjectId(userIdOf(req));
    const { categoryId } = req.body as { categoryId: string };
    if (!Types.ObjectId.isValid(categoryId)) {
      res.status(400).json({ error: 'invalid_category_id' });
      return;
    }
    // Validate the row exists + is owned by this user + is active.
    // Without this, a malformed client could pin a stale / cross-user
    // id and the digest route would have to filter dead entries
    // forever after.
    const cat = await Category.findOne({
      _id: categoryId,
      userId,
      status: { $ne: 'archived' },
    })
      .select('_id')
      .lean();
    if (!cat) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    await User.updateOne(
      { _id: userId },
      { $addToSet: { featuredCategoryIds: categoryId } },
    );
    const user = await User.findById(userId).select('featuredCategoryIds').lean();
    res.json({
      categoryIds: (user?.featuredCategoryIds as string[] | undefined) ?? [],
    });
  },
);

featuredCategoriesRouter.delete('/:categoryId', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const categoryId = decodeURIComponent(req.params.categoryId ?? '').trim();
  await User.updateOne(
    { _id: userId },
    { $pull: { featuredCategoryIds: categoryId } },
  );
  const user = await User.findById(userId).select('featuredCategoryIds').lean();
  res.json({
    categoryIds: (user?.featuredCategoryIds as string[] | undefined) ?? [],
  });
});
