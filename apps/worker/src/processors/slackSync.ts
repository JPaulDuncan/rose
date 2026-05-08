import { Worker, type Job, Queue } from 'bullmq';
import { Types } from 'mongoose';
import { createHash } from 'node:crypto';
import { Source, Email } from '@rose/db';
import { priorityForDate, type SlackConfig } from '@rose/shared';
import { detectPromoCodesForEmail } from '@rose/promo-codes';
import { detectShipmentsForEmail } from '@rose/shipments';
import { decryptJson, encryptJson } from '../lib/crypto.js';
import { redis, bullConnection } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import {
  authTest,
  fetchHistory,
  resolveUserName,
  type SlackMessage,
} from '../lib/slackClient.js';

const QUEUE = 'rose.slack-sync';
const generateQueue = new Queue('rose.generate-page', { connection: bullConnection() });

type SlackJobData = { sourceId: string; userId: string };

type SlackStored = SlackConfig & {
  workspaceName?: string;
  /** Per-channel cursor — Slack `ts` of the most recent ingested message. */
  cursors?: Record<string, string>;
};

/** Group messages into a per-day channel digest. Returns one synthetic
 *  email per (channel, day) so the existing page pipeline sees one
 *  high-quality summary instead of N micro-pages. */
function groupByDay(
  msgs: SlackMessage[],
): Map<string, SlackMessage[]> {
  const out = new Map<string, SlackMessage[]>();
  for (const m of msgs) {
    if (!m.text) continue;
    if (m.subtype && /channel_(join|leave|topic|purpose)|bot_message/.test(m.subtype)) continue;
    const day = new Date(Math.floor(Number(m.ts) * 1000)).toISOString().slice(0, 10);
    const arr = out.get(day) ?? [];
    arr.push(m);
    out.set(day, arr);
  }
  return out;
}

async function renderDigest(
  token: string,
  msgs: SlackMessage[],
): Promise<string> {
  const lines: string[] = [];
  for (const m of msgs.sort((a, b) => Number(a.ts) - Number(b.ts))) {
    const author = m.user ? await resolveUserName(token, m.user) : m.bot_id ?? 'unknown';
    const time = new Date(Math.floor(Number(m.ts) * 1000)).toISOString().slice(11, 16);
    lines.push(`[${time}] ${author}: ${(m.text ?? '').replace(/\n/g, ' ')}`);
  }
  return lines.join('\n');
}

export function startSlackSyncWorker() {
  const worker = new Worker<SlackJobData>(
    QUEUE,
    async (job: Job<SlackJobData>) => {
      const userId = new Types.ObjectId(job.data.userId);
      const source = await Source.findOne({ _id: job.data.sourceId, userId }).select(
        '+encryptedConfig',
      );
      if (!source || source.type !== 'slack' || !source.encryptedConfig) return;

      const cfg = decryptJson<SlackStored>(source.encryptedConfig);
      // Lazy-bootstrap workspaceName so the UI has a label.
      if (!cfg.workspaceName) {
        try {
          const auth = await authTest(cfg.token);
          cfg.workspaceName = auth.team ?? undefined;
          source.encryptedConfig = encryptJson(cfg);
        } catch (err) {
          source.lastError = (err as Error).message;
          source.status = 'error';
          await source.save();
          throw err;
        }
      }

      const cursors = cfg.cursors ?? {};
      let ingested = 0;
      let skipped = 0;
      let errors = 0;
      // Default backfill window: 24h on first sync per channel.
      const defaultOldest = String(Math.floor((Date.now() - 24 * 3600 * 1000) / 1000));

      for (const channelId of cfg.watchedChannels ?? []) {
        try {
          const oldest = cursors[channelId] ?? defaultOldest;
          const msgs = await fetchHistory(cfg.token, channelId, oldest);
          if (msgs.length === 0) continue;
          const byDay = groupByDay(msgs);
          for (const [day, dayMsgs] of byDay) {
            const text = await renderDigest(cfg.token, dayMsgs);
            if (!text) continue;
            const messageId = `slack:${cfg.workspaceName ?? 'ws'}:${channelId}:${day}`;
            const rawHash = createHash('sha256').update(messageId).update(' ').update(text).digest('hex');
            const exists = await Email.findOne({ userId, $or: [{ messageId }, { rawHash }] })
              .select('_id')
              .lean();
            if (exists) {
              skipped += 1;
              continue;
            }
            const created = await Email.create({
              userId,
              sourceId: source._id,
              kind: 'slack',
              messageId,
              threadKey: null,
              subjectTemplate: null,
              rawHash,
              from: {
                name: `Slack · ${cfg.workspaceName ?? 'workspace'}`,
                address: `slack@${(cfg.workspaceId ?? 'ws').toLowerCase()}.slack`,
              },
              to: [],
              cc: [],
              subject: `Slack #${channelId} — ${day}`,
              date: new Date(`${day}T00:00:00Z`),
              text,
              rawText: text,
              html: null,
              attachments: [],
              priority: 'normal',
              topics: ['slack'],
              links: [],
              images: [],
              spamScore: 0,
              spamSignals: [],
              isMassMailing: false,
              promotionalScore: 0,
              isPromotional: false,
              promotionalSignals: [],
              authResults: { spf: 'unknown', dkim: 'unknown', dmarc: 'unknown' },
              unsubscribeUrls: [],
              ingestStatus: 'parsed',
            });
            await generateQueue.add(
              'generate',
              { emailId: String(created._id), userId: userId.toString() },
              {
                attempts: 3,
                removeOnComplete: 500,
                removeOnFail: 500,
                priority: priorityForDate(new Date()),
              },
            );
            try {
              await detectPromoCodesForEmail(String(created._id));
            } catch (err) {
              logger.warn({ err, emailId: String(created._id) }, 'promo-code detection failed');
            }
            try {
              await detectShipmentsForEmail(String(created._id));
            } catch (err) {
              logger.warn({ err, emailId: String(created._id) }, 'shipment detection failed');
            }
            ingested += 1;
          }
          // Advance the cursor to the newest message we saw.
          const newest = msgs.reduce(
            (acc, m) => (Number(m.ts) > Number(acc) ? m.ts : acc),
            oldest,
          );
          cursors[channelId] = newest;
        } catch (err) {
          errors += 1;
          logger.warn(
            { err: (err as Error).message, channelId },
            'slack-sync: per-channel failure (continuing)',
          );
        }
      }

      cfg.cursors = cursors;
      source.encryptedConfig = encryptJson(cfg);
      source.lastSyncAt = new Date();
      source.lastError = errors > 0 ? `${errors} channel(s) failed this sync` : null;
      source.status = errors > 0 ? 'error' : 'active';
      await source.save();
      logger.info(
        { sourceId: String(source._id), ingested, skipped, errors },
        'slack-sync: done',
      );
    },
    { connection: bullConnection(), concurrency: 2 },
  );
  worker.on('failed', (job, err) =>
    logger.error({ jobId: job?.id, err: err.message }, 'slack-sync failed'),
  );
  return worker;
}
