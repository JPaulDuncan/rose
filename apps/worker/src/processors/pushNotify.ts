import { Worker, type Job, Queue } from 'bullmq';
import { Types } from 'mongoose';
import {
  PushSubscription,
  NotificationRule,
  Sender,
  Page,
  type PageDoc,
} from '@rose/db';
import { senderDomainTag } from '@rose/email-parser';
import { getVapidKeys, webpush } from '../lib/vapid.js';
import { redis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';

const QUEUE = 'rose.push-notify';

type PushJobData = {
  userId: string;
  /** Notification body to render. Kept small — most browsers cap at
   *  4KB total payload after encryption. */
  notification: {
    title: string;
    body: string;
    url?: string;
    tag?: string;
  };
};

/**
 * Send `notification` to every active subscription belonging to
 * `userId`. 410 / 404 responses delete the subscription
 * (browser invalidated it).
 */
export async function pushToUser(
  userId: Types.ObjectId,
  notification: PushJobData['notification'],
): Promise<{ sent: number; removed: number }> {
  // Make sure VAPID is initialized. No-op when env keys present.
  getVapidKeys();
  const subs = await PushSubscription.find({ userId }).lean();
  let sent = 0;
  let removed = 0;
  for (const sub of subs) {
    const keys = (sub.keys ?? {}) as { p256dh?: string; auth?: string };
    if (!keys.p256dh || !keys.auth) {
      continue;
    }
    try {
      await webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: { p256dh: keys.p256dh, auth: keys.auth },
        },
        JSON.stringify(notification),
      );
      sent += 1;
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        await PushSubscription.deleteOne({ _id: sub._id });
        removed += 1;
        continue;
      }
      logger.warn(
        { err, endpoint: sub.endpoint.slice(0, 40) },
        'push: send failed (will retry next event)',
      );
    }
  }
  return { sent, removed };
}

/**
 * Evaluate every `priority-high` / `tag` / `sender` notification rule
 * against a freshly-generated page; for each match, enqueue a push.
 * Idempotent — we tag the BullMQ jobs with the page id so duplicate
 * events for the same page+rule combo collapse.
 */
export async function evaluatePageNotifications(
  userId: Types.ObjectId,
  page: PageDoc,
): Promise<void> {
  const rules = await NotificationRule.find({ userId, enabled: true })
    .select('kind match')
    .lean();
  if (!rules.length) return;
  const pageTags = new Set([
    ...((page.tags as string[]) ?? []),
    ...((page.topics as string[]) ?? []),
  ]);
  const senderAddrs = (page.senderAddresses as string[] | undefined) ?? [];
  // Resolve each contributing address to its brand for `sender` rules.
  const senderBrandKeys = new Set<string>();
  for (const a of senderAddrs) {
    const tag = senderDomainTag(a);
    if (tag) senderBrandKeys.add(tag.toLowerCase());
  }

  const queue = new Queue(QUEUE, { connection: redis });
  for (const r of rules) {
    let matches = false;
    const m = (r.match ?? {}) as { tag?: string; brandKey?: string };
    if (r.kind === 'priority-high') {
      matches = page.priority === 'high';
    } else if (r.kind === 'tag') {
      matches = !!m.tag && pageTags.has(m.tag.toLowerCase());
    } else if (r.kind === 'sender') {
      matches = !!m.brandKey && senderBrandKeys.has(m.brandKey.toLowerCase());
    }
    if (!matches) continue;
    const ruleId = String(r._id);
    await queue.add(
      'page',
      {
        userId: String(userId),
        notification: {
          title: titleFor(r.kind, m, page),
          body: page.summary?.slice(0, 200) ?? page.title,
          url: `/p/${page.slug}`,
          tag: `page:${String(page._id)}:${ruleId}`,
        },
      },
      {
        jobId: `push__${userId}__${page._id}__${ruleId}`,
        attempts: 1,
        removeOnComplete: 200,
        removeOnFail: 200,
      },
    );
  }
}

function titleFor(
  kind: string,
  m: { tag?: string; brandKey?: string },
  page: PageDoc,
): string {
  if (kind === 'priority-high') return `High priority — ${page.title}`;
  if (kind === 'tag' && m.tag) return `#${m.tag} — ${page.title}`;
  if (kind === 'sender' && m.brandKey) return `${m.brandKey} — ${page.title}`;
  return page.title;
}

/** Periodic sweep for `event-soon` rules — nudge the user when an
 *  extracted calendar event is within `match.hoursAhead` (default 6). */
export async function eventSoonSweep(): Promise<void> {
  const rules = await NotificationRule.find({ kind: 'event-soon', enabled: true }).lean();
  if (!rules.length) return;
  const { CalendarEvent } = await import('@rose/db');
  for (const r of rules) {
    const m = (r.match ?? {}) as { hoursAhead?: number };
    const window = (m.hoursAhead ?? 6) * 3600 * 1000;
    const events = await CalendarEvent.find({
      userId: r.userId,
      dismissed: { $ne: true },
      start: { $gte: new Date(), $lte: new Date(Date.now() + window) },
    })
      .limit(5)
      .lean();
    for (const e of events) {
      const queue = new Queue(QUEUE, { connection: redis });
      await queue.add(
        'event-soon',
        {
          userId: String(r.userId),
          notification: {
            title: `Soon: ${e.title}`,
            body: e.location
              ? `${new Date(e.start).toLocaleTimeString()} · ${e.location}`
              : new Date(e.start).toLocaleTimeString(),
            url: e.pageSlug ? `/p/${e.pageSlug}` : '/calendar',
            tag: `event:${String(e._id)}`,
          },
        },
        {
          jobId: `push__event__${r.userId}__${e._id}`,
          attempts: 1,
          removeOnComplete: 100,
          removeOnFail: 100,
        },
      );
    }
  }
  // Mark unused imports as touched to avoid lint warnings.
  void Sender;
  void Page;
}

export function startPushNotifyWorker() {
  const worker = new Worker<PushJobData>(
    QUEUE,
    async (job: Job<PushJobData>) => {
      const userId = new Types.ObjectId(job.data.userId);
      const r = await pushToUser(userId, job.data.notification);
      if (r.sent > 0 || r.removed > 0) {
        logger.info({ userId: String(userId), ...r }, 'push: delivered');
      }
    },
    { connection: redis, concurrency: 4 },
  );
  worker.on('failed', (job, err) =>
    logger.warn({ jobId: job?.id, err: err.message }, 'push-notify failed'),
  );
  return worker;
}

/** Periodic 15-min sweep that fires `event-soon` notification rules. */
export function startEventSoonSweep(): NodeJS.Timeout {
  const tick = () => {
    eventSoonSweep().catch((err) =>
      logger.warn({ err }, 'push: event-soon sweep failed'),
    );
  };
  const timer = setInterval(tick, 15 * 60 * 1000);
  timer.unref?.();
  setTimeout(tick, 5_000).unref?.();
  return timer;
}
