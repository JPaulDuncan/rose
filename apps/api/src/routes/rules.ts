import { Router } from 'express';
import { Types } from 'mongoose';
import {
  Rule,
  RuleAuditLog,
  Email,
} from '@rose/db';
import { RuleUpsert } from '@rose/shared';
import { userIdOf } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { matchesRule } from '../lib/ruleEval.js';
import { generatePageQueue } from '../lib/queues.js';

export const rulesRouter: Router = Router();

rulesRouter.get('/', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const rules = await Rule.find({ userId })
    .sort({ priority: 1, createdAt: 1 })
    .lean();
  res.json({ rules });
});

rulesRouter.get('/:id', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  if (!Types.ObjectId.isValid(req.params.id)) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const rule = await Rule.findOne({ _id: req.params.id, userId }).lean();
  if (!rule) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json(rule);
});

rulesRouter.post('/', validateBody(RuleUpsert), async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const body = req.body as typeof RuleUpsert._type;
  const created = await Rule.create({ userId, ...body });
  res.status(201).json(created);
});

rulesRouter.patch('/:id', validateBody(RuleUpsert.partial()), async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const id = req.params.id ?? '';
  if (!Types.ObjectId.isValid(id)) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const body = req.body as Partial<typeof RuleUpsert._type>;
  const rule = await Rule.findOneAndUpdate(
    { _id: id, userId },
    body,
    { new: true },
  );
  if (!rule) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json(rule);
});

rulesRouter.delete('/:id', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  await Rule.deleteOne({ _id: req.params.id, userId });
  res.json({ ok: true });
});

/**
 * Bulk-reorder priorities. Body: `{ order: [ruleId1, ruleId2, …] }`.
 * Each id gets priority equal to its index × 10 so future inserts can
 * slot between without renumbering everything.
 */
rulesRouter.post('/reorder', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const order = (req.body?.order as string[] | undefined) ?? [];
  await Promise.all(
    order.map((id, i) =>
      Types.ObjectId.isValid(id)
        ? Rule.updateOne({ _id: id, userId }, { priority: (i + 1) * 10 })
        : Promise.resolve(),
    ),
  );
  res.json({ ok: true });
});

/**
 * Test a (possibly-unsaved) rule against the user's recent mail. Pure
 * read; never mutates state. Returns matching email IDs + a small
 * sample so the UI can preview which messages would be touched.
 */
rulesRouter.post('/:id/test', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  // Allow either an existing rule id or an inline rule passed in body.
  let conditions: { field: string; op: string; value: unknown }[] = [];
  if (req.body?.conditions) {
    conditions = req.body.conditions;
  } else if (Types.ObjectId.isValid(req.params.id)) {
    const rule = await Rule.findOne({ _id: req.params.id, userId })
      .select('conditions')
      .lean();
    conditions = (rule?.conditions as typeof conditions) ?? [];
  }
  const sinceDays = Math.min(Number(req.body?.sinceDays ?? 30), 365);
  const limit = Math.min(Number(req.body?.limit ?? 100), 500);
  const since = new Date(Date.now() - sinceDays * 24 * 3600 * 1000);
  const pool = await Email.find({ userId, createdAt: { $gte: since } })
    .sort({ createdAt: -1 })
    .limit(2000)
    .select('subject from text html topics attachments spamScore isPromotional authResults createdAt')
    .lean();
  const matches = pool.filter((e) => matchesRule(conditions, e as never));
  res.json({
    total: matches.length,
    sample: matches.slice(0, limit).map((e) => ({
      _id: String(e._id),
      subject: e.subject ?? '',
      from: e.from?.address ?? null,
      createdAt: e.createdAt,
    })),
  });
});

/**
 * Replay an existing rule against existing emails — useful when the
 * user creates a new rule and wants it applied to historical mail.
 * For each match we re-enqueue generate-page so the verdict folds in
 * during regeneration.
 */
rulesRouter.post('/:id/replay', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  if (!Types.ObjectId.isValid(req.params.id)) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const rule = await Rule.findOne({ _id: req.params.id, userId }).lean();
  if (!rule) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const sinceDays = Math.min(Number(req.body?.sinceDays ?? 30), 365);
  const since = new Date(Date.now() - sinceDays * 24 * 3600 * 1000);
  const pool = await Email.find({ userId, createdAt: { $gte: since } })
    .sort({ createdAt: -1 })
    .limit(2000)
    .select('subject from text html topics attachments spamScore isPromotional authResults')
    .lean();
  const matches = pool.filter((e) =>
    matchesRule((rule.conditions as { field: string; op: string; value: unknown }[]) ?? [], e as never),
  );
  for (const m of matches) {
    await generatePageQueue.add(
      'generate',
      { emailId: String(m._id), userId: String(userId) },
      { attempts: 3, removeOnComplete: 500, removeOnFail: 500 },
    );
  }
  res.status(202).json({ matched: matches.length, requeued: matches.length });
});

/**
 * Recent audit log entries. Filterable by ruleId.
 */
rulesRouter.get('/audit/list', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const filter: Record<string, unknown> = { userId };
  const ruleId = req.query.ruleId as string | undefined;
  if (ruleId && Types.ObjectId.isValid(ruleId)) filter.ruleId = new Types.ObjectId(ruleId);
  const limit = Math.min(Number(req.query.limit ?? 100), 500);
  const audit = await RuleAuditLog.find(filter).sort({ at: -1 }).limit(limit).lean();
  res.json({ audit });
});
