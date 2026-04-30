import { Router } from 'express';
import { Types } from 'mongoose';
import { userIdOf } from '../middleware/auth.js';
import { User, Page, PageRevision, Email, Category } from '@rose/db';
import { generatePageQueue } from '../lib/queues.js';

export const meRouter: Router = Router();

meRouter.get('/', async (req, res) => {
  const userId = userIdOf(req);
  const user = await User.findById(userId);
  if (!user) {
    res.status(404).json({ error: 'not_found', message: 'User not found' });
    return;
  }
  res.json({
    id: user._id.toString(),
    email: user.email,
    displayName: user.displayName,
    settings: user.settings,
    createdAt: (user as unknown as { createdAt: Date }).createdAt.toISOString(),
  });
});

meRouter.patch('/', async (req, res) => {
  const userId = userIdOf(req);
  const { displayName, settings } = (req.body ?? {}) as {
    displayName?: string;
    settings?: Record<string, unknown>;
  };
  const update: Record<string, unknown> = {};
  if (displayName) update.displayName = displayName;
  if (settings) update.settings = { ...settings };
  const user = await User.findByIdAndUpdate(userId, update, { new: true });
  res.json({ ok: true, user });
});

/**
 * Destructive: wipe every wiki page + revision the user owns, and reset
 * every ingested email back to `parsed` so the next regenerate cycle can
 * rebuild the wiki from scratch under the current grouping rules.
 *
 * Body knobs (all default to false):
 *   - alsoRequeue: enqueue a regenerate job for every parsed email after
 *     reset, kicking off the rebuild immediately.
 *   - alsoEmails:  delete the underlying emails too (full nuke). Use only
 *     if you want to clear the source data, not just the derived wiki.
 *   - alsoCategories: drop categories the LLM auto-created.
 */
meRouter.post('/reset-wiki', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const body = (req.body ?? {}) as {
    alsoRequeue?: boolean;
    alsoEmails?: boolean;
    alsoCategories?: boolean;
  };

  const pages = await Page.find({ userId }).select('_id').lean();
  const pageIds = pages.map((p) => p._id);
  const revisions = await PageRevision.deleteMany({ pageId: { $in: pageIds } });
  const pagesResult = await Page.deleteMany({ userId });

  let emailsResult: { deleted: number; reset: number };
  if (body.alsoEmails) {
    const r = await Email.deleteMany({ userId });
    emailsResult = { deleted: r.deletedCount ?? 0, reset: 0 };
  } else {
    const r = await Email.updateMany(
      { userId },
      { $set: { ingestStatus: 'parsed', pageId: null, error: null } },
    );
    emailsResult = { deleted: 0, reset: r.modifiedCount ?? 0 };
  }

  const categoriesDeleted = body.alsoCategories
    ? (await Category.deleteMany({ userId })).deletedCount ?? 0
    : 0;

  let requeued = 0;
  if (body.alsoRequeue && !body.alsoEmails) {
    const stuck = await Email.find({ userId, ingestStatus: 'parsed' })
      .select('_id')
      .lean();
    for (const e of stuck) {
      await generatePageQueue.add(
        'generate',
        { emailId: String(e._id), userId: userId.toString() },
        { attempts: 3, removeOnComplete: 500, removeOnFail: 500 },
      );
    }
    requeued = stuck.length;
  }

  res.json({
    ok: true,
    pagesDeleted: pagesResult.deletedCount ?? 0,
    revisionsDeleted: revisions.deletedCount ?? 0,
    emails: emailsResult,
    categoriesDeleted,
    requeued,
  });
});
