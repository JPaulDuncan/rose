import { Router } from 'express';
import { Types } from 'mongoose';
import { userIdOf } from '../middleware/auth.js';
import { Email, Page } from '@rose/db';
import { generatePageQueue } from '../lib/queues.js';

export const emailsRouter: Router = Router();

emailsRouter.get('/', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const status = (req.query.status as string | undefined) ?? undefined;
  const limit = Math.min(Number(req.query.limit ?? 50), 200);
  const filter: Record<string, unknown> = { userId };
  if (status) filter.ingestStatus = status;
  const emails = await Email.find(filter)
    .sort({ createdAt: -1 })
    .limit(limit)
    .select('-rawText -html -attachments')
    .lean();

  const pageIds = emails
    .map((e) => e.pageId)
    .filter((id): id is Types.ObjectId => !!id);
  const slugMap = new Map<string, string>();
  if (pageIds.length) {
    const pages = await Page.find({ _id: { $in: pageIds }, userId })
      .select('_id slug')
      .lean();
    for (const p of pages) slugMap.set(String(p._id), p.slug);
  }
  const enriched = emails.map((e) => ({
    ...e,
    pageSlug: e.pageId ? slugMap.get(String(e.pageId)) ?? null : null,
  }));
  res.json({ emails: enriched });
});

/**
 * Batch lookup so the page view can resolve sourceEmailIds → metadata in
 * one round trip. Returns at most 200 rows; ids that don't belong to the
 * caller or don't exist are silently dropped.
 */
emailsRouter.post('/by-ids', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const ids = ((req.body as { ids?: unknown })?.ids ?? []) as unknown[];
  const valid = ids
    .filter((x): x is string => typeof x === 'string' && Types.ObjectId.isValid(x))
    .slice(0, 200);
  if (!valid.length) {
    res.json({ emails: [] });
    return;
  }
  const emails = await Email.find({ userId, _id: { $in: valid } })
    .select('_id subject from date pageId ingestStatus')
    .lean();
  res.json({ emails });
});

emailsRouter.get('/:id', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  if (!Types.ObjectId.isValid(req.params.id)) {
    res.status(400).json({ error: 'invalid_request', message: 'Invalid id' });
    return;
  }
  const email = await Email.findOne({ _id: req.params.id, userId }).lean();
  if (!email) {
    res.status(404).json({ error: 'not_found', message: 'Email not found' });
    return;
  }
  res.json(email);
});

emailsRouter.delete('/:id', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  await Email.deleteOne({ _id: req.params.id, userId });
  res.json({ ok: true });
});

/**
 * Re-enqueue page generation for an email. Useful when the original job
 * failed (Ollama not running, model not pulled, etc.) and the email is
 * stuck in `parsed`.
 */
emailsRouter.post('/:id/regenerate', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const email = await Email.findOne({ _id: req.params.id, userId });
  if (!email) {
    res.status(404).json({ error: 'not_found', message: 'Email not found' });
    return;
  }
  email.ingestStatus = 'parsed';
  email.error = null;
  await email.save();
  const job = await generatePageQueue.add(
    'generate',
    { emailId: email._id.toString(), userId: userId.toString() },
    { attempts: 3, removeOnComplete: 500, removeOnFail: 500 },
  );
  res.status(202).json({ jobId: job.id });
});

/**
 * Bulk re-enqueue every email currently stuck at `parsed`. Bounded to keep
 * the user from accidentally creating thousands of jobs at once.
 */
emailsRouter.post('/regenerate-stuck', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const limit = Math.min(Number((req.body as { limit?: number })?.limit ?? 500), 5000);
  const stuck = await Email.find({ userId, ingestStatus: 'parsed' })
    .sort({ createdAt: -1 })
    .limit(limit)
    .select('_id')
    .lean();
  for (const e of stuck) {
    await generatePageQueue.add(
      'generate',
      { emailId: String(e._id), userId: userId.toString() },
      { attempts: 3, removeOnComplete: 500, removeOnFail: 500 },
    );
  }
  res.status(202).json({ enqueued: stuck.length });
});

/**
 * History of generate-page jobs targeted at this email — across all
 * BullMQ states (failed/completed/active/waiting/delayed). Returns
 * each job's failedReason + full stacktrace so the user can see
 * exactly why generation didn't produce a page. Powers the "Why
 * didn't this generate?" panel on the inbox row.
 *
 * Bounded scan: BullMQ doesn't index by job-data, so we pull the most
 * recent N jobs per state and filter by emailId in-process. Practical
 * since pages-per-email is small.
 */
emailsRouter.get('/:id/jobs', async (req, res) => {
  const userId = String(userIdOf(req));
  const emailId = req.params.id ?? '';
  if (!emailId) {
    res.status(400).json({ error: 'invalid_request', message: 'Missing email id' });
    return;
  }
  // Confirm the email belongs to this user before scanning the queue —
  // otherwise we'd leak job metadata across accounts.
  const owns = await Email.exists({
    _id: new Types.ObjectId(emailId),
    userId: new Types.ObjectId(userId),
  });
  if (!owns) {
    res.status(404).json({ error: 'not_found', message: 'Email not found' });
    return;
  }
  const states = ['failed', 'completed', 'active', 'waiting', 'delayed'] as const;
  const buckets = await Promise.all(
    states.map(async (s) => {
      const jobs = await generatePageQueue.getJobs([s], 0, 200);
      return jobs
        .filter((j) => {
          const d = j.data as { emailId?: string; userId?: string };
          return d?.emailId === emailId && d?.userId === userId;
        })
        .map((j) => ({
          id: j.id,
          state: s as string,
          attemptsMade: j.attemptsMade,
          timestamp: j.timestamp,
          processedOn: j.processedOn ?? null,
          finishedOn: j.finishedOn ?? null,
          failedReason: j.failedReason ?? null,
          stacktrace: j.stacktrace ?? [],
          returnvalue: j.returnvalue ?? null,
        }));
    }),
  );
  const jobs = buckets.flat().sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
  res.json({ jobs });
});
