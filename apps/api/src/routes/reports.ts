import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { BugReport } from '@rose/db';
import { userIdOf } from '../middleware/auth.js';
import { isAdminRequest } from '../middleware/admin.js';
import { validateBody } from '../middleware/validate.js';

export const reportsRouter: Router = Router();

const ReportCreate = z.object({
  kind: z.enum(['bug', 'feature']),
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(10_000),
  /** Optional metadata. The client collects route / userAgent /
   *  screen / locale / timezone client-side and can suppress any
   *  field via the modal's "include details" toggle. */
  route: z.string().max(500).nullable().optional(),
  userAgent: z.string().max(500).nullable().optional(),
  screen: z
    .object({
      width: z.number().int().nullable().optional(),
      height: z.number().int().nullable().optional(),
      devicePixelRatio: z.number().nullable().optional(),
    })
    .optional(),
  locale: z.string().max(32).nullable().optional(),
  timezone: z.string().max(64).nullable().optional(),
  appVersion: z.string().max(80).nullable().optional(),
});

const ReportPatch = z.object({
  status: z.enum(['open', 'in-progress', 'closed']).optional(),
  adminNote: z.string().max(2000).optional(),
});

/** File a bug or feature request. Available to every user. */
reportsRouter.post('/', validateBody(ReportCreate), async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const body = req.body as typeof ReportCreate._type;
  const created = await BugReport.create({
    userId,
    kind: body.kind,
    title: body.title.trim(),
    body: body.body.trim(),
    route: body.route ?? null,
    userAgent: body.userAgent ?? null,
    screen: body.screen ?? {},
    locale: body.locale ?? null,
    timezone: body.timezone ?? null,
    appVersion: body.appVersion ?? null,
  });
  res.status(201).json({
    _id: String(created._id),
    kind: created.kind,
    title: created.title,
    body: created.body,
    status: created.status,
    createdAt: created.createdAt
      ? new Date(created.createdAt as Date).toISOString()
      : null,
  });
});

/**
 * List reports. By default returns the caller's own reports.
 * `?scope=all` is admin-only and returns every user's reports —
 * mirrors the recipes / rules global tab pattern so the same
 * mental model applies to bug triage.
 */
reportsRouter.get('/', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const wantAll = (req.query.scope as string | undefined) === 'all';
  if (wantAll) {
    const admin = await isAdminRequest(req);
    if (!admin) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const rows = await BugReport.find({})
      .sort({ status: 1, createdAt: -1 })
      .limit(500)
      .lean();
    res.json({
      reports: rows.map(shapeReport),
    });
    return;
  }
  const rows = await BugReport.find({ userId })
    .sort({ createdAt: -1 })
    .limit(200)
    .lean();
  res.json({ reports: rows.map(shapeReport) });
});

/**
 * Patch a report. Only the admin can change status or write a
 * follow-up note; everyone else is locked out (they should refile
 * a new report rather than edit an existing one — preserves the
 * audit trail).
 */
reportsRouter.patch('/:id', validateBody(ReportPatch), async (req, res) => {
  const id = req.params.id ?? '';
  if (!Types.ObjectId.isValid(id)) {
    res.status(400).json({ error: 'invalid_request' });
    return;
  }
  const admin = await isAdminRequest(req);
  if (!admin) {
    res.status(403).json({ error: 'forbidden', message: 'Admin only.' });
    return;
  }
  const body = req.body as typeof ReportPatch._type;
  const updated = await BugReport.findByIdAndUpdate(
    id,
    { $set: body },
    { new: true },
  ).lean();
  if (!updated) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json(shapeReport(updated));
});

/**
 * Delete a report. The owner can cancel their own report; admins
 * can clear any. Hard delete — bug-tracking history isn't worth
 * keeping graveyard rows around.
 */
reportsRouter.delete('/:id', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const id = req.params.id ?? '';
  if (!Types.ObjectId.isValid(id)) {
    res.status(400).json({ error: 'invalid_request' });
    return;
  }
  const admin = await isAdminRequest(req);
  const filter = admin ? { _id: id } : { _id: id, userId };
  await BugReport.deleteOne(filter);
  res.json({ ok: true });
});

function shapeReport(r: Record<string, unknown>): Record<string, unknown> {
  return {
    _id: String(r._id),
    userId: String(r.userId),
    kind: r.kind,
    title: r.title,
    body: r.body,
    route: r.route ?? null,
    userAgent: r.userAgent ?? null,
    screen: r.screen ?? null,
    locale: r.locale ?? null,
    timezone: r.timezone ?? null,
    appVersion: r.appVersion ?? null,
    status: r.status,
    adminNote: r.adminNote ?? '',
    createdAt: r.createdAt
      ? new Date(r.createdAt as Date).toISOString()
      : null,
    updatedAt: r.updatedAt
      ? new Date(r.updatedAt as Date).toISOString()
      : null,
  };
}
