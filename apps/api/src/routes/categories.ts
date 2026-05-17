import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { userIdOf } from '../middleware/auth.js';
import { Category, normalizeCategoryName, displayCategoryName } from '@rose/db';
import { validateBody } from '../middleware/validate.js';
import { postWriteHooksQueue } from '../lib/queues.js';
import { logger } from '../lib/logger.js';

export const categoriesRouter: Router = Router();

/**
 * GET /api/categories — list. Filters:
 *   ?kind=desk|ad-hoc   (default: all)
 *   ?status=active|proposed|archived  (default: all)
 *
 * Desk-aware UIs pass `?kind=desk&status=active` to render the
 * curated vocabulary, and `?status=proposed` to surface pending
 * suggestions from the learner.
 */
categoriesRouter.get('/', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const kind = (req.query.kind as string | undefined) ?? null;
  const status = (req.query.status as string | undefined) ?? null;
  const filter: Record<string, unknown> = { userId };
  if (kind && ['desk', 'ad-hoc'].includes(kind)) filter.kind = kind;
  if (status && ['active', 'proposed', 'archived'].includes(status))
    filter.status = status;
  const categories = await Category.find(filter).sort({ name: 1 }).lean();
  res.json({ categories });
});

/** Manual create — user typing a new desk in Settings. Always
 *  inserts as kind='desk', status='active'. */
const CategoryCreateRequest = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(280).optional(),
  parentId: z.string().optional(),
  color: z.string().max(40).optional(),
  icon: z.string().max(60).optional(),
});

categoriesRouter.post(
  '/',
  validateBody(CategoryCreateRequest),
  async (req, res) => {
    const userId = new Types.ObjectId(userIdOf(req));
    const body = req.body as z.infer<typeof CategoryCreateRequest>;
    const name = displayCategoryName(body.name);
    const normalizedName = normalizeCategoryName(name);
    // Idempotent on (userId, normalizedName) so a user clicking
    // "Add desk" with an existing name doesn't conflict.
    const created = await Category.findOneAndUpdate(
      { userId, normalizedName },
      {
        $setOnInsert: {
          userId,
          name,
          normalizedName,
          kind: 'desk',
          status: 'active',
          description: body.description ?? '',
          parentId: body.parentId ? new Types.ObjectId(body.parentId) : null,
          color: body.color ?? null,
          icon: body.icon ?? null,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    res.status(201).json(created);
  },
);

const CategoryPatchRequest = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(280).optional(),
  color: z.string().max(40).nullable().optional(),
  icon: z.string().max(60).nullable().optional(),
  status: z.enum(['active', 'archived']).optional(),
});

/** PATCH — rename, edit description, archive. Reject seed-default
 *  archive (only renames allowed) so the user can't accidentally
 *  remove "Uncategorized" and leave the generator with no
 *  fallback. */
categoriesRouter.patch(
  '/:id',
  validateBody(CategoryPatchRequest),
  async (req, res) => {
    const userId = new Types.ObjectId(userIdOf(req));
    if (!Types.ObjectId.isValid(req.params.id ?? '')) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    const cat = await Category.findOne({ _id: req.params.id, userId });
    if (!cat) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const body = req.body as z.infer<typeof CategoryPatchRequest>;
    if (body.status === 'archived' && cat.seedDefault) {
      res
        .status(400)
        .json({
          error: 'cannot_archive_seed_default',
          message: 'Seeded desks can be renamed but not archived.',
        });
      return;
    }
    if (body.name !== undefined) {
      const name = displayCategoryName(body.name);
      cat.name = name;
      cat.normalizedName = normalizeCategoryName(name);
    }
    if (body.description !== undefined) cat.description = body.description;
    if (body.color !== undefined) cat.color = body.color;
    if (body.icon !== undefined) cat.icon = body.icon;
    if (body.status !== undefined) cat.status = body.status;
    await cat.save();
    res.json({ ok: true, category: cat });
  },
);

/**
 * POST /api/categories/:id/accept — flip a proposed desk to active.
 * The proposal samplePages list stays; the user can clear it from
 * the UI later if they care.
 */
categoriesRouter.post('/:id/accept', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  if (!Types.ObjectId.isValid(req.params.id ?? '')) {
    res.status(400).json({ error: 'invalid_request' });
    return;
  }
  const cat = await Category.findOne({ _id: req.params.id, userId });
  if (!cat || cat.status !== 'proposed') {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  cat.status = 'active';
  await cat.save();
  res.json({ ok: true, category: cat });
});

/**
 * POST /api/categories/:id/reject — soft-delete a proposed desk
 * AND record a rejected-reason so the proposer's dedup pass
 * suppresses the same theme on future runs.
 */
const RejectRequest = z.object({
  reason: z.string().max(280).optional(),
});

categoriesRouter.post(
  '/:id/reject',
  validateBody(RejectRequest),
  async (req, res) => {
    const userId = new Types.ObjectId(userIdOf(req));
    if (!Types.ObjectId.isValid(req.params.id ?? '')) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    const cat = await Category.findOne({ _id: req.params.id, userId });
    if (!cat || cat.status !== 'proposed') {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const body = req.body as z.infer<typeof RejectRequest>;
    cat.status = 'archived';
    cat.rejectedReason = body.reason ?? 'user-rejected';
    await cat.save();
    res.json({ ok: true, category: cat });
  },
);

/**
 * POST /api/categories/suggest-desks — fire-and-forget. Enqueues a
 * job that clusters the user's pages and proposes new desks; the
 * UI polls `/api/categories?status=proposed` to see results as
 * they appear.
 */
categoriesRouter.post('/suggest-desks', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  try {
    await postWriteHooksQueue.add(
      'suggest-desks',
      { kind: 'suggest-desks', userId: String(userId) },
      { attempts: 2, removeOnComplete: 50, removeOnFail: 50 },
    );
  } catch (err) {
    logger.warn({ err }, 'categories: failed to enqueue suggest-desks');
    res.status(503).json({ error: 'enqueue_failed' });
    return;
  }
  res.status(202).json({ ok: true });
});

categoriesRouter.delete('/:id', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  if (!Types.ObjectId.isValid(req.params.id ?? '')) {
    res.status(400).json({ error: 'invalid_request' });
    return;
  }
  // Disallow deletion of seed defaults. Use PATCH status='archived'
  // for non-seed desks; this endpoint stays for legacy ad-hoc rows.
  const cat = await Category.findOne({ _id: req.params.id, userId })
    .select('seedDefault')
    .lean();
  if (cat?.seedDefault) {
    res
      .status(400)
      .json({
        error: 'cannot_delete_seed_default',
        message: 'Seeded desks can be renamed but not deleted.',
      });
    return;
  }
  await Category.deleteOne({ _id: req.params.id, userId });
  res.json({ ok: true });
});
