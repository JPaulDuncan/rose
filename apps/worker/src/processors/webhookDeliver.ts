import { Worker, type Job } from 'bullmq';
import { createHmac, randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import { WebhookSubscription } from '@rose/db';
import { decryptJson } from '../lib/crypto.js';
import { redis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';

const QUEUE = 'rose.webhook-deliver';

type DeliverJobData = {
  subscriptionId: string;
  event: string;
  payload: unknown;
};

/** Fan out a single event to all enabled subscriptions that listen
 *  for it. Caller hands us the user + event + payload. */
export async function dispatchWebhookEvent(
  userId: Types.ObjectId,
  event: string,
  payload: unknown,
): Promise<void> {
  const subs = await WebhookSubscription.find({
    userId,
    enabled: true,
    events: event,
  })
    .select('_id')
    .lean();
  if (!subs.length) return;
  const queue = (await import('bullmq')).Queue;
  const q = new queue(QUEUE, { connection: redis });
  for (const s of subs) {
    await q.add(
      event,
      { subscriptionId: String(s._id), event, payload },
      {
        attempts: 6,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: 200,
        removeOnFail: 500,
      },
    );
  }
}

export function startWebhookDeliverWorker() {
  const worker = new Worker<DeliverJobData>(
    QUEUE,
    async (job: Job<DeliverJobData>) => {
      const sub = await WebhookSubscription.findById(job.data.subscriptionId).select(
        '+encryptedSecret',
      );
      if (!sub || !sub.enabled) return;
      const secret = sub.encryptedSecret
        ? (decryptJson<{ s: string }>(sub.encryptedSecret).s ?? '')
        : '';
      const deliveryId = randomUUID();
      const body = JSON.stringify({
        event: job.data.event,
        deliveryId,
        timestamp: new Date().toISOString(),
        payload: job.data.payload,
      });
      const sig = secret
        ? `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
        : '';
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8_000);
      try {
        const res = await fetch(sub.url, {
          method: 'POST',
          signal: ctrl.signal,
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Rose-Webhooks/1.0',
            'X-Rose-Event': job.data.event,
            'X-Rose-Delivery': deliveryId,
            ...(sig ? { 'X-Rose-Signature': sig } : {}),
          },
          body,
        });
        if (!res.ok) {
          throw new Error(`Receiver responded ${res.status} ${res.statusText}`);
        }
        sub.deliveryCount = (sub.deliveryCount ?? 0) + 1;
        sub.lastDeliveredAt = new Date();
        sub.lastError = null;
        await sub.save();
      } catch (err) {
        sub.failureCount = (sub.failureCount ?? 0) + 1;
        sub.lastError = (err as Error).message;
        await sub.save();
        throw err;
      } finally {
        clearTimeout(timer);
      }
    },
    { connection: redis, concurrency: 4 },
  );
  worker.on('failed', (job, err) =>
    logger.warn({ jobId: job?.id, err: err.message }, 'webhook-deliver failed (will retry)'),
  );
  return worker;
}
