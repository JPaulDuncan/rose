import { Router } from 'express';
import { Types } from 'mongoose';
import { Page } from '@rose/db';
import { userIdOf } from '../middleware/auth.js';

export const hiddenRouter: Router = Router();

/**
 * Plan 12 (R6) — single endpoint backing the unified "Hidden" landing
 * page. Surfaces counts across the three "stuff I don't want to read
 * by default" buckets so the SPA can render a single overview card
 * with quick-jumps to each, instead of forcing the user to learn
 * three separate sidebar destinations.
 *
 * Returns aggregated counts only — the buckets keep their own routes
 * for the actual list views, where bulk actions stay scoped.
 */
hiddenRouter.get('/summary', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const [autoQuarantined, userMarkedSpam, promotional, anyHidden] =
    await Promise.all([
      Page.countDocuments({ userId, 'flags.autoQuarantined': true }),
      Page.countDocuments({ userId, 'flags.userMarkedSpam': true }),
      Page.countDocuments({ userId, 'flags.isPromotional': true }),
      // Total distinct count across the three flags. Mongo counts
      // each row once whichever flag matches, so this is the union.
      Page.countDocuments({
        userId,
        $or: [
          { 'flags.autoQuarantined': true },
          { 'flags.userMarkedSpam': true },
          { 'flags.isPromotional': true },
        ],
      }),
    ]);
  res.json({
    quarantine: autoQuarantined,
    spam: userMarkedSpam,
    promotions: promotional,
    total: anyHidden,
  });
});
