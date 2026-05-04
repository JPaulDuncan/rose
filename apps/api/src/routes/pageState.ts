import { Router } from 'express';
import { Types } from 'mongoose';
import { Page, UserPageState, User } from '@rose/db';
import { userIdOf } from '../middleware/auth.js';

export const pageStateRouter: Router = Router();

/** Mark a page read or unread. Silently no-ops when the user hasn't
 *  enabled read tracking, so the UI can call this freely from list
 *  views without churning state for users who don't want it. */
pageStateRouter.post('/:id/read', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  if (!Types.ObjectId.isValid(req.params.id)) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const user = await User.findById(userId).select('settings.trackReads').lean();
  const tracking =
    !!(user?.settings as { trackReads?: boolean } | undefined)?.trackReads;
  if (!tracking) {
    res.json({ ok: true, tracking: false });
    return;
  }
  const read = (req.body?.read as boolean | undefined) ?? true;
  await UserPageState.updateOne(
    { userId, pageId: req.params.id },
    {
      $set: {
        userId,
        pageId: req.params.id,
        read,
        readAt: read ? new Date() : null,
      },
    },
    { upsert: true },
  );
  res.json({ ok: true });
});

pageStateRouter.post('/:id/favorite', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  if (!Types.ObjectId.isValid(req.params.id)) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const fav = (req.body?.favorited as boolean | undefined) ?? true;
  await UserPageState.updateOne(
    { userId, pageId: req.params.id },
    {
      $set: {
        userId,
        pageId: req.params.id,
        favorited: fav,
        favoritedAt: fav ? new Date() : null,
      },
    },
    { upsert: true },
  );
  res.json({ ok: true });
});

/** Resolve which of the supplied page IDs the current user has
 *  marked read or favorited — used by list views to render dots /
 *  stars without N round-trips. Mounted at a non-`/:id/...` path so
 *  the express router doesn't try to interpret "lookup-state" as a
 *  page id. */
export const pageStateLookupRouter: Router = Router();
pageStateLookupRouter.post('/lookup', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const ids = (req.body?.pageIds as string[] | undefined) ?? [];
  const valid = ids
    .filter((id) => Types.ObjectId.isValid(id))
    .map((id) => new Types.ObjectId(id));
  if (valid.length === 0) {
    res.json({ states: {} });
    return;
  }
  const rows = await UserPageState.find({ userId, pageId: { $in: valid } })
    .select('pageId read favorited')
    .lean();
  const out: Record<string, { read: boolean; favorited: boolean }> = {};
  for (const r of rows) {
    out[String(r.pageId)] = {
      read: !!r.read,
      favorited: !!r.favorited,
    };
  }
  res.json({ states: out });
});
