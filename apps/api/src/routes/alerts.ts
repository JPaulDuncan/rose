import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { AlertRule } from '@rose/db';
import { userIdOf } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';

/**
 * Operator-facing alert rules. Mounted under /api/alerts.
 * Layered on top of the worker's alertSweeper service which polls
 * + fires; this surface is just CRUD + state so the user can edit
 * thresholds without redeploying.
 *
 * Auth: standard requireAuth (per-user data scoping). No admin gate
 * — every user can manage their own rules.
 */

export const alertsRouter: Router = Router();

const RULE_KINDS = ['queue-failed', 'queue-backlog', 'collscan'] as const;

const AlertRuleUpsert = z.object({
  kind: z.enum(RULE_KINDS),
  name: z.string().max(120).optional(),
  enabled: z.boolean().optional(),
  threshold: z.number().int().min(1).max(100_000).optional(),
  cooldownMin: z.number().int().min(1).max(7 * 24 * 60).optional(),
  /** Empty string or omitted = match every queue. */
  queueName: z.string().max(80).optional(),
});

alertsRouter.get('/', async (req, res, next) => {
  try {
    const userId = new Types.ObjectId(userIdOf(req));
    const rules = await AlertRule.find({ userId })
      .sort({ createdAt: -1 })
      .lean();
    res.json({
      rules: rules.map((r) => ({
        _id: String(r._id),
        kind: r.kind,
        name: r.name ?? '',
        enabled: r.enabled,
        threshold: r.threshold ?? 1,
        cooldownMin: r.cooldownMin ?? 60,
        queueName: r.queueName ?? '',
        lastFiredAt: r.lastFiredAt ?? null,
        lastEvaluatedAt: r.lastEvaluatedAt ?? null,
        lastValue: r.lastValue ?? 0,
        createdAt: r.createdAt,
      })),
    });
  } catch (err) {
    next(err);
  }
});

alertsRouter.post('/', validateBody(AlertRuleUpsert), async (req, res, next) => {
  try {
    const userId = new Types.ObjectId(userIdOf(req));
    const body = req.body as z.infer<typeof AlertRuleUpsert>;
    const created = await AlertRule.create({
      userId,
      kind: body.kind,
      name: body.name?.trim() ?? '',
      enabled: body.enabled ?? true,
      threshold: body.threshold ?? defaultThreshold(body.kind),
      cooldownMin: body.cooldownMin ?? 60,
      queueName: (body.queueName ?? '').trim(),
    });
    res.status(201).json({ ok: true, _id: String(created._id) });
  } catch (err) {
    next(err);
  }
});

alertsRouter.patch(
  '/:id',
  validateBody(AlertRuleUpsert.partial()),
  async (req, res, next) => {
    try {
      const userId = new Types.ObjectId(userIdOf(req));
      const idParam = String(req.params.id ?? '');
      if (!Types.ObjectId.isValid(idParam)) {
        res.status(400).json({ error: 'invalid_id' });
        return;
      }
      const body = req.body as Partial<z.infer<typeof AlertRuleUpsert>>;
      const $set: Record<string, unknown> = {};
      for (const k of ['kind', 'name', 'enabled', 'threshold', 'cooldownMin', 'queueName'] as const) {
        if (body[k] !== undefined) $set[k] = body[k];
      }
      // Allow the operator to "reset" a rule's cooldown by editing
      // it — clearing lastFiredAt makes the rule eligible to fire
      // again on the next sweep. Convenient for testing thresholds.
      if (body.threshold !== undefined || body.enabled === true) {
        $set.lastFiredAt = null;
      }
      const r = await AlertRule.updateOne(
        { _id: new Types.ObjectId(idParam), userId },
        { $set },
      );
      res.json({ ok: true, modified: (r.modifiedCount ?? 0) > 0 });
    } catch (err) {
      next(err);
    }
  },
);

alertsRouter.delete('/:id', async (req, res, next) => {
  try {
    const userId = new Types.ObjectId(userIdOf(req));
    const idParam = String(req.params.id ?? '');
    if (!Types.ObjectId.isValid(idParam)) {
      res.status(400).json({ error: 'invalid_id' });
      return;
    }
    const r = await AlertRule.deleteOne({
      _id: new Types.ObjectId(idParam),
      userId,
    });
    res.json({ ok: true, deleted: (r.deletedCount ?? 0) > 0 });
  } catch (err) {
    next(err);
  }
});

function defaultThreshold(kind: (typeof RULE_KINDS)[number]): number {
  switch (kind) {
    case 'queue-failed':
      return 1;
    case 'queue-backlog':
      return 100;
    case 'collscan':
      return 1;
  }
}
