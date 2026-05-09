import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import {
  User,
  Email,
  Page,
  PageRevision,
  DaydreamNote,
  RecipeAudit,
  Conversation,
  Message,
  TagDigest,
  WeatherSnapshot,
  Shipment,
  PromoCode,
  LibraryDocumentRef,
  runRetentionCleanup,
} from '@rose/db';
import { userIdOf } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';

export const retentionRouter: Router = Router();

const RETENTION_FIELDS = [
  'emails',
  'pageRevisions',
  'daydream',
  'recipeAudit',
  'conversations',
  'tagDigests',
  'weatherSnapshots',
  'emailEmbeddings',
  'pages',
  'stripOldEmailBodiesDays',
] as const;

/**
 * GET /api/retention — surface the current per-collection retention
 * settings, last-run summary, and a live row-count breakdown so the
 * settings page can render "you currently have 12k emails / 3.4k
 * pages / 240 daydream notes" without needing aggregate counts on
 * the disk-usage level (Mongo's per-user storageSize isn't exposed).
 */
retentionRouter.get('/', async (req, res, next) => {
  try {
    const userId = new Types.ObjectId(userIdOf(req));
    const user = await User.findById(userId).select('retention').lean();
    const retention = (user?.retention ?? {}) as Record<string, unknown>;

    const [
      emails,
      emailsWithEmbedding,
      emailsWithBody,
      pages,
      pageRevisions,
      daydream,
      recipeAudit,
      conversations,
      messages,
      tagDigests,
      weather,
      shipments,
      promoCodes,
      libraryDocs,
    ] = await Promise.all([
      Email.countDocuments({ userId }),
      Email.countDocuments({ userId, embedding: { $ne: null } }),
      Email.countDocuments({ userId, text: { $ne: '' } }),
      Page.countDocuments({ userId }),
      // PageRevision lives on pageId; bound the count by the user's
      // pages.
      Page.find({ userId })
        .select('_id')
        .lean()
        .then((ps) =>
          PageRevision.countDocuments({ pageId: { $in: ps.map((p) => p._id) } }),
        ),
      DaydreamNote.countDocuments({ userId }),
      RecipeAudit.countDocuments({ userId }),
      Conversation.countDocuments({ userId }),
      Conversation.find({ userId })
        .select('_id')
        .lean()
        .then((cs) =>
          Message.countDocuments({ conversationId: { $in: cs.map((c) => c._id) } }),
        ),
      TagDigest.countDocuments({ userId }),
      WeatherSnapshot.countDocuments({ userId }),
      Shipment.countDocuments({ userId }),
      PromoCode.countDocuments({ userId }),
      // Library is global; per-user count comes from refs.
      LibraryDocumentRef.countDocuments({ userId }).catch(() => 0),
    ]);

    res.json({
      retention,
      counts: {
        emails,
        emailsWithEmbedding,
        emailsWithBody,
        pages,
        pageRevisions,
        daydream,
        recipeAudit,
        conversations,
        messages,
        tagDigests,
        weatherSnapshots: weather,
        shipments,
        promoCodes,
        libraryDocs,
      },
    });
  } catch (err) {
    next(err);
  }
});

const RetentionUpdateRequest = z.object(
  Object.fromEntries(
    RETENTION_FIELDS.map((f) => [
      f,
      z.number().int().min(0).max(3650).optional(),
    ]),
  ),
);

retentionRouter.patch(
  '/',
  validateBody(RetentionUpdateRequest),
  async (req, res, next) => {
    try {
      const userId = new Types.ObjectId(userIdOf(req));
      const body = req.body as Record<string, number>;
      const set: Record<string, number> = {};
      for (const f of RETENTION_FIELDS) {
        if (typeof body[f] === 'number') set[`retention.${f}`] = body[f]!;
      }
      if (Object.keys(set).length === 0) {
        res.json({ ok: true });
        return;
      }
      await User.updateOne({ _id: userId }, { $set: set });
      const user = await User.findById(userId).select('retention').lean();
      res.json({ ok: true, retention: user?.retention ?? {} });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * Trigger an immediate cleanup pass for the calling user. Returns
 * the same summary the nightly sweep records, so the page can
 * refresh "Last cleanup" inline.
 *
 * The actual cleanup function lives in the worker package. This
 * endpoint imports it lazily at request time so the API process
 * can run the sweep without sharing process state with the worker
 * — Mongo writes are visible across both because they're DB-level.
 */
/**
 * Trigger an immediate cleanup pass for the calling user. Returns
 * the same summary the nightly sweep records, so the page can
 * refresh "Last cleanup" inline. The work runs in-process on the
 * API; both api and worker share the @rose/db helper, so writes
 * land in the same Mongo collections regardless of who invokes it.
 */
retentionRouter.post('/run', async (req, res, next) => {
  try {
    const userId = new Types.ObjectId(userIdOf(req));
    const summary = await runRetentionCleanup(userId);
    res.json({ ok: true, summary });
  } catch (err) {
    next(err);
  }
});
