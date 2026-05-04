import { Worker, type Job, Queue } from 'bullmq';
import { Types } from 'mongoose';
import {
  User,
  Source,
  OutboundMessage,
} from '@rose/db';
import { redis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { renderDigestEmail } from '../services/digestMail.js';

const QUEUE = 'rose.digest-email';
const sendQueue = new Queue('rose.send-outbound', { connection: redis });

type DigestJobData = { userId?: string; force?: boolean };

/** Determine whether this user is due to receive a digest right now,
 *  per their configured cadence + local time. The sweep job runs
 *  hourly; we send when the local hour matches the configured hour
 *  and (for weekly) the configured weekday — and we haven't already
 *  sent in the past 12 hours. */
function isDue(
  cfg: {
    cadence?: 'daily' | 'weekly';
    timeOfDayLocal?: string;
    weeklyDay?: number;
    timezone?: string;
    lastSentAt?: Date | null;
  },
  now = new Date(),
): boolean {
  const tz = cfg.timezone || 'UTC';
  const target = (cfg.timeOfDayLocal ?? '08:00').slice(0, 5);
  const [hh, mm] = target.split(':').map((s) => Number(s));
  if (Number.isNaN(hh) || Number.isNaN(mm)) return false;
  // Resolve the user's local time using Intl.
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  });
  const parts = fmt.formatToParts(now);
  const localHour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const localWeekdayShort = parts.find((p) => p.type === 'weekday')?.value ?? '';
  const wdMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const localWeekday = wdMap[localWeekdayShort] ?? -1;

  if (localHour !== hh) return false;
  if (cfg.cadence === 'weekly' && localWeekday !== (cfg.weeklyDay ?? 1)) return false;
  // De-dup window: don't re-send within 12 hours.
  if (cfg.lastSentAt) {
    const ms = now.getTime() - new Date(cfg.lastSentAt).getTime();
    if (ms < 12 * 3600 * 1000) return false;
  }
  return true;
}

/** Pick an outbound transport for digest mail. Prefers Gmail (best
 *  deliverability), falls back to the first IMAP source. */
async function pickTransport(userId: Types.ObjectId): Promise<{
  sourceId: Types.ObjectId;
  transport: 'smtp' | 'gmail';
} | null> {
  const gmail = await Source.findOne({ userId, type: 'gmail', status: 'active' });
  if (gmail) return { sourceId: gmail._id as Types.ObjectId, transport: 'gmail' };
  const imap = await Source.findOne({ userId, type: 'imap', status: 'active' });
  if (imap) return { sourceId: imap._id as Types.ObjectId, transport: 'smtp' };
  return null;
}

async function sendOneUser(userId: Types.ObjectId, force: boolean): Promise<{
  sent: boolean;
  reason?: string;
}> {
  const user = await User.findById(userId).select('email displayName settings');
  if (!user) return { sent: false, reason: 'user not found' };
  const cfg = (user.settings as { digestEmail?: Record<string, unknown> } | undefined)?.digestEmail ?? {};
  if (!force && !cfg.enabled) return { sent: false, reason: 'disabled' };
  if (!force && !isDue(cfg as never)) return { sent: false, reason: 'not due' };

  const rendered = await renderDigestEmail(userId);
  if (!rendered.hasContent) {
    user.set('settings.digestEmail.lastSentAt', new Date());
    user.set('settings.digestEmail.lastError', null);
    await user.save();
    return { sent: false, reason: 'empty edition' };
  }

  const transport = await pickTransport(userId);
  if (!transport) {
    user.set('settings.digestEmail.lastError', 'No active outbound source');
    await user.save();
    return { sent: false, reason: 'no transport' };
  }

  const toAddress = (cfg.toAddress as string | null | undefined) || user.email;
  const out = await OutboundMessage.create({
    userId,
    inReplyToEmailId: null,
    sourceId: transport.sourceId,
    transport: transport.transport,
    to: [{ address: toAddress }],
    cc: [],
    bcc: [],
    subject: rendered.subject,
    bodyMd: rendered.text,
    bodyHtml: rendered.html,
    status: 'queued',
  });
  await sendQueue.add(
    'send',
    { outboundId: String(out._id), userId: String(userId) },
    { attempts: 1, removeOnComplete: 100, removeOnFail: 100 },
  );

  user.set('settings.digestEmail.lastSentAt', new Date());
  user.set('settings.digestEmail.lastError', null);
  await user.save();
  return { sent: true };
}

export function startDigestEmailWorker() {
  const worker = new Worker<DigestJobData>(
    QUEUE,
    async (job: Job<DigestJobData>) => {
      // Force-send a single user (from the API "Send now" button).
      if (job.data.userId) {
        const r = await sendOneUser(new Types.ObjectId(job.data.userId), !!job.data.force);
        logger.info({ userId: job.data.userId, ...r }, 'digest-email: forced send');
        return r;
      }
      // Sweep: walk every user with digest enabled and send those that
      // are due right now in their timezone.
      const candidates = await User.find({ 'settings.digestEmail.enabled': true })
        .select('_id')
        .lean();
      let sent = 0;
      for (const u of candidates) {
        try {
          const r = await sendOneUser(u._id as Types.ObjectId, false);
          if (r.sent) sent += 1;
        } catch (err) {
          logger.warn({ err, userId: String(u._id) }, 'digest-email: per-user error');
        }
      }
      if (sent > 0) logger.info({ swept: candidates.length, sent }, 'digest-email: sweep');
      return { swept: candidates.length, sent };
    },
    { connection: redis, concurrency: 1 },
  );
  worker.on('failed', (job, err) =>
    logger.error({ jobId: job?.id, err }, 'digest-email failed'),
  );
  return worker;
}
