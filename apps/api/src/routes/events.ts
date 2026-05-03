import { Router } from 'express';
import { Types } from 'mongoose';
import { CalendarEvent, Email } from '@rose/db';
import { userIdOf } from '../middleware/auth.js';

export const eventsRouter: Router = Router();

/**
 * Look up the source emails referenced by a batch of events and join in
 * the sender name + address (and the email subject as a fallback). Done
 * in one query to keep the list endpoints O(1) on the DB side.
 */
async function attachSourceInfo<T extends { sourceEmailId?: Types.ObjectId | string | null }>(
  userId: Types.ObjectId,
  events: T[],
): Promise<(T & {
  sourceFromName: string | null;
  sourceFromAddress: string | null;
  sourceSubject: string | null;
  sourceKind: 'email' | 'rss' | null;
})[]> {
  const ids = [
    ...new Set(
      events
        .map((e) => e.sourceEmailId)
        .filter((x): x is Types.ObjectId | string => !!x)
        .map((x) => String(x)),
    ),
  ];
  if (!ids.length) {
    return events.map((e) => ({
      ...e,
      sourceFromName: null,
      sourceFromAddress: null,
      sourceSubject: null,
      sourceKind: null,
    }));
  }
  const emails = await Email.find({ userId, _id: { $in: ids } })
    .select('subject from kind')
    .lean();
  const byId = new Map(emails.map((e) => [String(e._id), e]));
  return events.map((e) => {
    const src = e.sourceEmailId ? byId.get(String(e.sourceEmailId)) : null;
    return {
      ...e,
      sourceFromName: src?.from?.name ?? null,
      sourceFromAddress: src?.from?.address ?? null,
      sourceSubject: src?.subject ?? null,
      sourceKind: (src?.kind as 'email' | 'rss' | undefined) ?? null,
    };
  });
}

eventsRouter.get('/', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const from = req.query.from ? new Date(req.query.from as string) : null;
  const to = req.query.to ? new Date(req.query.to as string) : null;
  const includeDismissed = req.query.includeDismissed === '1';

  const filter: Record<string, unknown> = { userId };
  if (!includeDismissed) filter.dismissed = { $ne: true };
  if (from || to) {
    filter.start = {
      ...(from ? { $gte: from } : {}),
      ...(to ? { $lte: to } : {}),
    };
  }
  const events = await CalendarEvent.find(filter)
    .sort({ start: 1 })
    .limit(2000)
    .lean();
  res.json({ events: await attachSourceInfo(userId, events) });
});

eventsRouter.get('/upcoming', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const limit = Math.min(Number(req.query.limit ?? 10), 50);
  const events = await CalendarEvent.find({
    userId,
    dismissed: { $ne: true },
    start: { $gte: new Date() },
  })
    .sort({ start: 1 })
    .limit(limit)
    .lean();
  res.json({ events: await attachSourceInfo(userId, events) });
});

eventsRouter.post('/:id/dismiss', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  await CalendarEvent.updateOne(
    { _id: req.params.id, userId },
    { $set: { dismissed: true } },
  );
  res.json({ ok: true });
});

eventsRouter.post('/:id/restore', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  await CalendarEvent.updateOne(
    { _id: req.params.id, userId },
    { $set: { dismissed: false } },
  );
  res.json({ ok: true });
});

eventsRouter.delete('/:id', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  await CalendarEvent.deleteOne({ _id: req.params.id, userId });
  res.json({ ok: true });
});
