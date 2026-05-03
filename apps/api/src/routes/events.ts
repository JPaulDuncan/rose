import { Router } from 'express';
import { Types } from 'mongoose';
import { CalendarEvent } from '@rose/db';
import { userIdOf } from '../middleware/auth.js';

export const eventsRouter: Router = Router();

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
  res.json({ events });
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
  res.json({ events });
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
