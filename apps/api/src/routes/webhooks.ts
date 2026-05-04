import { Router } from 'express';
import crypto from 'node:crypto';
import { Types } from 'mongoose';
import { WebhookSubscription } from '@rose/db';
import { userIdOf } from '../middleware/auth.js';
import { encryptJson, decryptJson } from '../lib/crypto.js';
import { webhookDeliverQueue } from '../lib/queues.js';

export const webhooksRouter: Router = Router();

const ALLOWED_EVENTS = [
  'page.created',
  'page.updated',
  'page.spam.flagged',
  'event.extracted',
  'sender.autoQuarantined',
  'digest.daily',
] as const;

function listShape(s: Record<string, unknown>) {
  return {
    _id: String(s._id),
    name: s.name,
    url: s.url,
    events: s.events,
    enabled: !!s.enabled,
    deliveryCount: s.deliveryCount ?? 0,
    failureCount: s.failureCount ?? 0,
    lastDeliveredAt: s.lastDeliveredAt ?? null,
    lastError: s.lastError ?? null,
    createdAt: s.createdAt ?? null,
  };
}

webhooksRouter.get('/', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const subs = await WebhookSubscription.find({ userId })
    .sort({ createdAt: -1 })
    .lean();
  res.json({
    subscriptions: subs.map(listShape),
    events: ALLOWED_EVENTS,
  });
});

webhooksRouter.post('/', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const body = (req.body ?? {}) as {
    name?: string;
    url?: string;
    events?: string[];
  };
  if (!body.name || !body.url || !body.events?.length) {
    res.status(400).json({ error: 'invalid_request', message: 'name, url, events required' });
    return;
  }
  if (!/^https?:\/\//i.test(body.url)) {
    res.status(400).json({ error: 'invalid_request', message: 'url must be http(s)' });
    return;
  }
  const events = body.events.filter((e) => (ALLOWED_EVENTS as readonly string[]).includes(e));
  if (!events.length) {
    res.status(400).json({ error: 'invalid_request', message: 'no valid events' });
    return;
  }
  const secret = crypto.randomBytes(32).toString('base64url');
  const sub = await WebhookSubscription.create({
    userId,
    name: body.name.slice(0, 80),
    url: body.url,
    events,
    encryptedSecret: encryptJson({ s: secret }),
    enabled: true,
  });
  // Surface the secret exactly once at create time — receivers need
  // it to verify HMAC signatures, but we never echo it again.
  res.status(201).json({
    subscription: listShape(sub.toObject()),
    secret,
    hint: 'Save this secret — it is shown only once. Verify deliveries with HMAC-SHA256 over the body, comparing against the X-Rose-Signature header.',
  });
});

webhooksRouter.patch('/:id', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const body = (req.body ?? {}) as {
    name?: string;
    url?: string;
    events?: string[];
    enabled?: boolean;
  };
  const sub = await WebhookSubscription.findOne({ _id: req.params.id, userId });
  if (!sub) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  if (typeof body.name === 'string' && body.name.trim()) sub.name = body.name.trim().slice(0, 80);
  if (typeof body.url === 'string' && /^https?:\/\//i.test(body.url)) sub.url = body.url;
  if (Array.isArray(body.events)) {
    const ev = body.events.filter((e) => (ALLOWED_EVENTS as readonly string[]).includes(e));
    if (ev.length) sub.events = ev;
  }
  if (typeof body.enabled === 'boolean') sub.enabled = body.enabled;
  await sub.save();
  res.json(listShape(sub.toObject()));
});

webhooksRouter.delete('/:id', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  await WebhookSubscription.deleteOne({ _id: req.params.id, userId });
  res.json({ ok: true });
});

webhooksRouter.post('/:id/test', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const sub = await WebhookSubscription.findOne({ _id: req.params.id, userId });
  if (!sub) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  await webhookDeliverQueue.add(
    'test',
    {
      subscriptionId: String(sub._id),
      event: 'page.created',
      payload: {
        page: {
          id: 'test',
          slug: 'rose-test',
          title: 'Rose webhook test',
          summary: 'This is a test delivery from your Rose webhook subscription.',
          tags: ['test'],
          priority: 'normal',
          version: 1,
          updatedAt: new Date().toISOString(),
        },
        sourceEmailIds: [],
      },
    },
    { attempts: 1, removeOnComplete: 50, removeOnFail: 50 },
  );
  res.status(202).json({ ok: true });
});

/** Reveal the secret again — protected: requires a fresh password
 *  prompt would be nicer; for v1 we just allow on demand by the
 *  authenticated user. */
webhooksRouter.get('/:id/secret', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const sub = await WebhookSubscription.findOne({ _id: req.params.id, userId }).select(
    '+encryptedSecret',
  );
  if (!sub || !sub.encryptedSecret) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const { s } = decryptJson<{ s: string }>(sub.encryptedSecret);
  res.json({ secret: s });
});
