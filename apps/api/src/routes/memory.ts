import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import {
  MemoryComponent,
  MemoryGroup,
  MEMORY_COMPONENT_TYPES,
  Page,
} from '@rose/db';
import { userIdOf } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { postWriteHooksQueue } from '../lib/queues.js';
import { logger } from '../lib/logger.js';

export const memoryRouter: Router = Router();

/**
 * GET /api/memory/stats — counts driving the maintenance UI on
 * Settings → Memory. Returns total components, total groups, AND
 * the number of pages that have not yet been through the xMemory
 * component extractor. The "pages awaiting extraction" number
 * disables the backfill button when it's 0 + tells the user how
 * many runs they'll need (each `/extract` job processes up to
 * 200 pages).
 */
memoryRouter.get('/stats', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const [components, groups, pagesAwaiting] = await Promise.all([
    MemoryComponent.countDocuments({ userId, status: 'active' }),
    MemoryGroup.countDocuments({ userId }),
    Page.countDocuments({
      userId,
      $or: [
        { memoryComponentsExtractedFromHash: null },
        { memoryComponentsExtractedFromHash: { $exists: false } },
      ],
    }),
  ]);
  res.json({
    components,
    groups,
    pagesAwaiting,
    backfillBatchSize: 200,
  });
});

/**
 * POST /api/memory/extract — kick a backfill job that walks the
 * user's pages without an extraction hash and runs the components
 * extractor on each. Capped at 200 pages per invocation so a
 * 5000-page archive doesn't burn the LLM cap in one click; the
 * user is expected to re-click as the `pagesAwaiting` count
 * drains.
 */
memoryRouter.post('/extract', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  try {
    await postWriteHooksQueue.add(
      'memory-backfill',
      { kind: 'memory-backfill', userId: String(userId), limit: 200 },
      { attempts: 1, removeOnComplete: 20, removeOnFail: 20 },
    );
  } catch (err) {
    logger.warn({ err }, 'memory: failed to enqueue backfill');
    res.status(503).json({ error: 'enqueue_failed' });
    return;
  }
  res.status(202).json({ ok: true });
});

/**
 * POST /api/memory/regroup — kick the grouping sweeper for this
 * user immediately, without waiting for the 5-minute background
 * tick. Useful after a bulk extraction or when the user has
 * archived/rejected components and wants to see the groups
 * recompute right away.
 */
memoryRouter.post('/regroup', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  try {
    await postWriteHooksQueue.add(
      'memory-regroup',
      { kind: 'memory-regroup', userId: String(userId) },
      { attempts: 1, removeOnComplete: 20, removeOnFail: 20 },
    );
  } catch (err) {
    logger.warn({ err }, 'memory: failed to enqueue regroup');
    res.status(503).json({ error: 'enqueue_failed' });
    return;
  }
  res.status(202).json({ ok: true });
});

/**
 * "What Rose knows about you" surface. Lists the user's
 * MemoryComponent rows grouped by MemoryGroup theme, with the
 * source-page citations Rose mined each fact from. Users can
 * delete, reject, archive, or edit any component — rejecting tells
 * the extractor not to re-emit the same claim on the next page
 * pass.
 */

/**
 * GET /api/memory — list the user's components grouped by theme.
 * Filterable by status and type. Embedding payloads are stripped
 * to keep responses small.
 */
memoryRouter.get('/', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const status = (req.query.status as string | undefined) ?? 'active';
  const subjectParam = (req.query.subject as string | undefined) ?? 'user';
  const allowedStatus = new Set(['active', 'archived', 'rejected', 'all']);
  const allowedSubject = new Set(['user', 'world', 'all']);
  if (!allowedStatus.has(status)) {
    res.status(400).json({ error: 'invalid_status' });
    return;
  }
  if (!allowedSubject.has(subjectParam)) {
    res.status(400).json({ error: 'invalid_subject' });
    return;
  }
  const filter: Record<string, unknown> = { userId };
  if (status !== 'all') filter.status = status;
  if (subjectParam !== 'all') filter.subject = subjectParam;

  const [components, groups] = await Promise.all([
    MemoryComponent.find(filter)
      .sort({ lastSeenAt: -1 })
      .limit(1000)
      .select('-embedding')
      .lean(),
    MemoryGroup.find(
      subjectParam === 'all' ? { userId } : { userId, subject: subjectParam },
    )
      .sort({ componentCount: -1 })
      .select('-centroid')
      .lean(),
  ]);

  // Resolve a per-component "evidence preview" by pulling at most
  // three source-page titles. One Page.find for the whole batch.
  const allPageIds = new Set<string>();
  for (const c of components) {
    for (const pid of (c.sourcePageIds as Types.ObjectId[] | undefined) ?? []) {
      allPageIds.add(String(pid));
    }
  }
  const pages = allPageIds.size
    ? await Page.find({
        userId,
        _id: { $in: [...allPageIds].map((id) => new Types.ObjectId(id)) },
      })
        .select('title slug')
        .lean()
    : [];
  const pageById = new Map(pages.map((p) => [String(p._id), p]));

  const decorated = components.map((c) => ({
    ...c,
    sources: ((c.sourcePageIds as Types.ObjectId[] | undefined) ?? [])
      .slice(0, 3)
      .map((pid) => {
        const p = pageById.get(String(pid));
        return p ? { id: String(p._id), title: p.title, slug: p.slug } : null;
      })
      .filter(Boolean),
  }));

  res.json({
    components: decorated,
    groups,
    totals: {
      components: components.length,
      groups: groups.length,
      byType: Object.fromEntries(
        MEMORY_COMPONENT_TYPES.map((t) => [
          t,
          components.filter((c) => c.type === t).length,
        ]),
      ),
    },
  });
});

const ComponentPatchRequest = z.object({
  text: z.string().min(3).max(400).optional(),
  status: z.enum(['active', 'archived', 'rejected']).optional(),
});

/**
 * PATCH /api/memory/components/:id — edit or transition status.
 * Setting status='rejected' prevents the same fact from being
 * re-emitted on the next extraction pass (the extractor checks
 * for a matching rejected row before upserting).
 */
memoryRouter.patch(
  '/components/:id',
  validateBody(ComponentPatchRequest),
  async (req, res) => {
    const userId = new Types.ObjectId(userIdOf(req));
    if (!Types.ObjectId.isValid(req.params.id ?? '')) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    const c = await MemoryComponent.findOne({ _id: req.params.id, userId });
    if (!c) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const body = req.body as z.infer<typeof ComponentPatchRequest>;
    if (body.text !== undefined) c.text = body.text;
    if (body.status !== undefined) c.status = body.status;
    await c.save();
    res.json({ ok: true, component: c });
  },
);

/**
 * DELETE /api/memory/components/:id — hard delete. The component's
 * source pages stay put; only the extracted claim is removed.
 * Re-extraction on the same page will re-emit unless the user
 * uses PATCH ... status='rejected' instead.
 */
memoryRouter.delete('/components/:id', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  if (!Types.ObjectId.isValid(req.params.id ?? '')) {
    res.status(400).json({ error: 'invalid_request' });
    return;
  }
  await MemoryComponent.deleteOne({ _id: req.params.id, userId });
  res.json({ ok: true });
});

const GroupPatchRequest = z.object({
  label: z.string().min(1).max(120),
});

/**
 * PATCH /api/memory/groups/:id — user-rename a theme. Sets
 * labelLockedByUser so the auto-relabeler doesn't overwrite.
 */
memoryRouter.patch(
  '/groups/:id',
  validateBody(GroupPatchRequest),
  async (req, res) => {
    const userId = new Types.ObjectId(userIdOf(req));
    if (!Types.ObjectId.isValid(req.params.id ?? '')) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    const g = await MemoryGroup.findOne({ _id: req.params.id, userId });
    if (!g) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const body = req.body as z.infer<typeof GroupPatchRequest>;
    g.label = body.label;
    g.labelLockedByUser = true;
    await g.save();
    res.json({ ok: true, group: g });
  },
);
