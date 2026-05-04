import { Router } from 'express';
import { Types } from 'mongoose';
import { PushSubscription, NotificationRule } from '@rose/db';
import { userIdOf } from '../middleware/auth.js';
import { getVapidPublicKey } from '../lib/vapid.js';

export const pushRouter: Router = Router();

/** Public VAPID key the SPA needs to call `pushManager.subscribe()`.
 *  Returns null when push isn't configured by the operator yet. */
pushRouter.get('/key', (_req, res) => {
  res.json({ publicKey: getVapidPublicKey() });
});

pushRouter.get('/subscriptions', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const subs = await PushSubscription.find({ userId })
    .select('endpoint userAgent createdAt')
    .lean();
  res.json({
    subscriptions: subs.map((s) => ({
      _id: String(s._id),
      endpointPreview: (s.endpoint ?? '').slice(0, 60) + '…',
      userAgent: s.userAgent,
      createdAt: s.createdAt,
    })),
  });
});

pushRouter.post('/subscribe', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const body = (req.body ?? {}) as {
    endpoint?: string;
    keys?: { p256dh?: string; auth?: string };
    userAgent?: string;
  };
  if (!body.endpoint || !body.keys?.p256dh || !body.keys?.auth) {
    res.status(400).json({ error: 'invalid_request', message: 'endpoint + keys required' });
    return;
  }
  const upserted = await PushSubscription.findOneAndUpdate(
    { endpoint: body.endpoint },
    {
      $set: {
        userId,
        endpoint: body.endpoint,
        keys: { p256dh: body.keys.p256dh, auth: body.keys.auth },
        userAgent: body.userAgent ?? null,
        lastError: null,
      },
    },
    { upsert: true, new: true },
  );
  res.status(201).json({ ok: true, _id: String(upserted._id) });
});

pushRouter.post('/unsubscribe', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const body = (req.body ?? {}) as { endpoint?: string };
  if (!body.endpoint) {
    res.status(400).json({ error: 'invalid_request' });
    return;
  }
  await PushSubscription.deleteOne({ userId, endpoint: body.endpoint });
  res.json({ ok: true });
});

// ── Notification rules ──────────────────────────────────────────────

pushRouter.get('/rules', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const rules = await NotificationRule.find({ userId }).sort({ createdAt: -1 }).lean();
  res.json({ rules });
});

pushRouter.post('/rules', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const body = (req.body ?? {}) as {
    kind?: 'priority-high' | 'tag' | 'sender' | 'event-soon';
    match?: Record<string, unknown>;
  };
  if (!body.kind) {
    res.status(400).json({ error: 'invalid_request', message: 'kind required' });
    return;
  }
  const rule = await NotificationRule.create({
    userId,
    kind: body.kind,
    match: body.match ?? {},
    enabled: true,
  });
  res.status(201).json(rule);
});

pushRouter.patch('/rules/:id', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const body = (req.body ?? {}) as { enabled?: boolean; match?: Record<string, unknown> };
  const update: Record<string, unknown> = {};
  if (typeof body.enabled === 'boolean') update.enabled = body.enabled;
  if (body.match) update.match = body.match;
  const rule = await NotificationRule.findOneAndUpdate(
    { _id: req.params.id, userId },
    update,
    { new: true },
  );
  if (!rule) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json(rule);
});

pushRouter.delete('/rules/:id', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  await NotificationRule.deleteOne({ _id: req.params.id, userId });
  res.json({ ok: true });
});
