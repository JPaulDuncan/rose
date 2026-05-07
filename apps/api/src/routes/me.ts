import { Router } from 'express';
import { Types } from 'mongoose';
import { userIdOf } from '../middleware/auth.js';
import {
  User,
  Page,
  PageRevision,
  Email,
  Category,
  CalendarEvent,
  UserPageState,
} from '@rose/db';
import { generatePageQueue, digestEmailQueue, briefingQueue } from '../lib/queues.js';

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
  // Build a $set update keyed by `settings.<field>` so the patch merges
  // into the existing settings doc instead of replacing the whole subtree.
  // The previous version (`update.settings = { ...settings }`) wiped any
  // sibling keys (e.g. saving `vision` cleared `digestEmail`/`briefing`).
  const update: Record<string, unknown> = {};
  if (displayName) update.displayName = displayName;
  if (settings && typeof settings === 'object') {
    for (const [key, value] of Object.entries(settings)) {
      update[`settings.${key}`] = value;
    }
  }
  const user = await User.findByIdAndUpdate(
    userId,
    { $set: update },
    { new: true },
  );
  res.json({ ok: true, user });
});

/**
 * Atomic mute/unmute for the home page's "Trending topics" widget.
 * The user surface is one click per pill, so we expose both
 * operations as single-topic POSTs against settings.trendingBlocklist
 * rather than asking the client to send the whole array. Topics are
 * lowercased before storage so case differences in `Page.topics`
 * don't sneak the same boilerplate past the filter twice.
 */
meRouter.post('/trending/mute', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const raw = ((req.body as { topic?: string })?.topic ?? '').trim().toLowerCase();
  if (!raw) {
    res.status(400).json({ error: 'invalid_request', message: 'topic required' });
    return;
  }
  await User.updateOne(
    { _id: userId },
    { $addToSet: { 'settings.trendingBlocklist': raw } },
  );
  res.json({ ok: true, topic: raw });
});

meRouter.post('/trending/unmute', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const raw = ((req.body as { topic?: string })?.topic ?? '').trim().toLowerCase();
  if (!raw) {
    res.status(400).json({ error: 'invalid_request', message: 'topic required' });
    return;
  }
  await User.updateOne(
    { _id: userId },
    { $pull: { 'settings.trendingBlocklist': raw } },
  );
  res.json({ ok: true, topic: raw });
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

  // Calendar events are derived from email content. They get re-extracted
  // on the next generation pass, so clear them here and reset the
  // per-email `eventsExtractedAt` cache so the worker doesn't skip them.
  const eventsResult = await CalendarEvent.deleteMany({ userId });

  let emailsResult: { deleted: number; reset: number };
  if (body.alsoEmails) {
    const r = await Email.deleteMany({ userId });
    emailsResult = { deleted: r.deletedCount ?? 0, reset: 0 };
  } else {
    const r = await Email.updateMany(
      { userId },
      {
        $set: { ingestStatus: 'parsed', pageId: null, error: null },
        $unset: { eventsExtractedAt: '' },
      },
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
    eventsDeleted: eventsResult.deletedCount ?? 0,
    emails: emailsResult,
    categoriesDeleted,
    requeued,
  });
});

/** Manually trigger a digest send for this user, ignoring the
 *  configured cadence. Used by the "Send now" button in Settings. */
meRouter.post('/digest-email/send-now', async (req, res) => {
  const userId = userIdOf(req);
  const job = await digestEmailQueue.add(
    'send-now',
    { userId, force: true },
    { attempts: 1, removeOnComplete: 50, removeOnFail: 50 },
  );
  res.status(202).json({ jobId: job.id });
});

/** Force a briefing generation, ignoring cadence. */
meRouter.post('/briefing/generate-now', async (req, res) => {
  const userId = userIdOf(req);
  const job = await briefingQueue.add(
    'generate-now',
    { userId, force: true },
    { attempts: 1, removeOnComplete: 50, removeOnFail: 50 },
  );
  res.status(202).json({ jobId: job.id });
});

/** Pages the user has favorited, newest-favorite first. Returns the
 *  same lightweight shape the digest uses so list components can
 *  render without further calls. */
meRouter.get('/favorites', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const rows = await UserPageState.find({ userId, favorited: true })
    .sort({ favoritedAt: -1 })
    .limit(200)
    .select('pageId favoritedAt')
    .lean();
  if (rows.length === 0) {
    res.json({ pages: [] });
    return;
  }
  const ids = rows.map((r) => r.pageId);
  const pages = await Page.find({ userId, _id: { $in: ids } })
    .select(
      'slug title summary heroImageUrl tags topics priority sourceEmailIds senderAddresses updatedAt',
    )
    .lean();
  // Preserve favorite order.
  const byId = new Map(pages.map((p) => [String(p._id), p]));
  const ordered = rows
    .map((r) => byId.get(String(r.pageId)))
    .filter((p): p is (typeof pages)[number] => !!p)
    .map((p) => ({
      _id: String(p._id),
      slug: p.slug,
      title: p.title,
      summary: p.summary,
      heroImageUrl: p.heroImageUrl ?? null,
      tags: p.tags ?? [],
      topics: p.topics ?? [],
      priority: p.priority,
      senderAddresses: p.senderAddresses ?? [],
      sourceEmailIds: (p.sourceEmailIds ?? []).map(String),
      updatedAt: p.updatedAt,
    }));
  res.json({ pages: ordered });
});

// ── Saved searches CRUD ────────────────────────────────────────────────

meRouter.get('/saved-searches', async (req, res) => {
  const userId = userIdOf(req);
  const u = await User.findById(userId).select('savedSearches').lean();
  res.json({ savedSearches: u?.savedSearches ?? [] });
});

meRouter.post('/saved-searches', async (req, res) => {
  const userId = userIdOf(req);
  const body = (req.body ?? {}) as {
    name?: string;
    query?: string;
    filters?: Record<string, unknown>;
    pinned?: boolean;
    notify?: 'never' | 'on-new-match';
  };
  if (!body.name?.trim()) {
    res.status(400).json({ error: 'invalid_request', message: 'name required' });
    return;
  }
  const id = `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const entry = {
    id,
    name: body.name.trim().slice(0, 80),
    query: (body.query ?? '').slice(0, 200),
    filters: body.filters ?? {},
    pinned: !!body.pinned,
    notify: body.notify ?? 'never',
  };
  await User.updateOne({ _id: userId }, { $push: { savedSearches: entry } });
  res.status(201).json(entry);
});

meRouter.patch('/saved-searches/:id', async (req, res) => {
  const userId = userIdOf(req);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const fields: Record<string, unknown> = {};
  for (const key of ['name', 'query', 'filters', 'pinned', 'notify']) {
    if (key in body) fields[`savedSearches.$.${key}`] = body[key];
  }
  if (Object.keys(fields).length === 0) {
    res.json({ ok: true });
    return;
  }
  await User.updateOne(
    { _id: userId, 'savedSearches.id': req.params.id },
    { $set: fields },
  );
  res.json({ ok: true });
});

meRouter.delete('/saved-searches/:id', async (req, res) => {
  const userId = userIdOf(req);
  await User.updateOne(
    { _id: userId },
    { $pull: { savedSearches: { id: req.params.id } } },
  );
  res.json({ ok: true });
});
