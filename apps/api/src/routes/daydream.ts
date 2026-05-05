import { Router } from 'express';
import { Types } from 'mongoose';
import { User, DaydreamNote } from '@rose/db';
import { DaydreamSettings, DaydreamSettingsUpdate } from '@rose/shared';
import { userIdOf } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';

export const daydreamRouter: Router = Router();

/**
 * Read the user's daydream settings. Defaults the response through
 * the Zod parse so a user that's never opened the page sees the
 * documented defaults instead of `undefined` everywhere.
 */
daydreamRouter.get('/', async (req, res) => {
  const userId = userIdOf(req);
  const user = await User.findById(userId).select('settings.daydream').lean();
  const cfg = (user?.settings as { daydream?: unknown } | undefined)?.daydream ?? {};
  const safe = DaydreamSettings.parse(cfg);
  res.json(safe);
});

/**
 * Patch — deep-merges `sources.*` and `skip.*` so a partial save
 * (e.g. just toggling Wikipedia.enabled) doesn't blow away the rest
 * of the config.
 */
daydreamRouter.patch('/', validateBody(DaydreamSettingsUpdate), async (req, res) => {
  const userId = userIdOf(req);
  const body = req.body as typeof DaydreamSettingsUpdate._type;
  const update: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (k === 'sources' || k === 'skip') continue; // merged below
    update[`settings.daydream.${k}`] = v;
  }
  if (body.sources) {
    for (const [k, v] of Object.entries(body.sources)) {
      update[`settings.daydream.sources.${k}`] = v;
    }
  }
  if (body.skip) {
    for (const [k, v] of Object.entries(body.skip)) {
      update[`settings.daydream.skip.${k}`] = v;
    }
  }
  await User.findByIdAndUpdate(userId, { $set: update });
  res.json({ ok: true });
});

/**
 * Recent daydream activity for the Settings page — a chronological
 * log so the user can see what daydream is doing without reading
 * worker logs. Includes failures with their reason.
 */
daydreamRouter.get('/recent', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const limit = Math.min(Number(req.query.limit ?? 50), 200);
  const notes = await DaydreamNote.find({ userId })
    .sort({ generatedAt: -1 })
    .limit(limit)
    .lean();
  res.json({
    notes: notes.map((n) => ({
      _id: String(n._id),
      kind: n.kind,
      subjectKey: n.subjectKey,
      displayName: n.displayName,
      summary: n.summary,
      sources: (n.sources ?? []).map((s) => ({
        adapter: s.adapter,
        url: s.url,
        title: s.title ?? '',
      })),
      confidence: n.confidence,
      model: n.model ?? null,
      generatedAt: n.generatedAt ? n.generatedAt.toISOString() : null,
      failed: !!n.failed,
      failureReason: n.failureReason ?? null,
    })),
  });
});

/** Forget one note. Next sweep can re-research it from scratch. */
daydreamRouter.delete('/notes/:id', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const id = req.params.id;
  if (!id || !Types.ObjectId.isValid(id)) {
    res.status(400).json({ error: 'invalid_request', message: 'invalid id' });
    return;
  }
  const r = await DaydreamNote.deleteOne({ _id: new Types.ObjectId(id), userId });
  res.json({ ok: true, deleted: r.deletedCount ?? 0 });
});
