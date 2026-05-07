import { Worker, type Job, Queue } from 'bullmq';
import { Types } from 'mongoose';
import { createHash } from 'node:crypto';
import { Source, Email } from '@rose/db';
import { priorityForDate, type DiscordConfig } from '@rose/shared';
import { detectPromoCodesForEmail } from '@rose/promo-codes';
import { detectShipmentsForEmail } from '@rose/shipments';
import { decryptJson, encryptJson } from '../lib/crypto.js';
import { redis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import {
  fetchAfter,
  getGuild,
  type DiscordMessage,
} from '../lib/discordClient.js';

const QUEUE = 'rose.discord-sync';
const generateQueue = new Queue('rose.generate-page', { connection: redis });

type DiscordJobData = { sourceId: string; userId: string };

type DiscordStored = DiscordConfig & {
  guildName?: string;
  /** channelId → last seen Discord snowflake. */
  cursors?: Record<string, string>;
};

function groupByDay(msgs: DiscordMessage[]): Map<string, DiscordMessage[]> {
  const out = new Map<string, DiscordMessage[]>();
  for (const m of msgs) {
    if (m.author?.bot) continue;
    if (!m.content) continue;
    const day = m.timestamp.slice(0, 10);
    const arr = out.get(day) ?? [];
    arr.push(m);
    out.set(day, arr);
  }
  return out;
}

function renderDigest(msgs: DiscordMessage[]): string {
  return msgs
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    .map((m) => {
      const author =
        m.author?.global_name ?? m.author?.username ?? m.author?.id ?? 'unknown';
      const time = m.timestamp.slice(11, 16);
      return `[${time}] ${author}: ${(m.content ?? '').replace(/\n/g, ' ')}`;
    })
    .join('\n');
}

export function startDiscordSyncWorker() {
  const worker = new Worker<DiscordJobData>(
    QUEUE,
    async (job: Job<DiscordJobData>) => {
      const userId = new Types.ObjectId(job.data.userId);
      const source = await Source.findOne({ _id: job.data.sourceId, userId }).select(
        '+encryptedConfig',
      );
      if (!source || source.type !== 'discord' || !source.encryptedConfig) return;
      const cfg = decryptJson<DiscordStored>(source.encryptedConfig);

      // Lazy-bootstrap guild name.
      if (!cfg.guildName) {
        try {
          const g = await getGuild(cfg.botToken, cfg.guildId);
          cfg.guildName = g.name ?? undefined;
          source.encryptedConfig = encryptJson(cfg);
        } catch (err) {
          source.lastError = (err as Error).message;
          source.status = 'error';
          await source.save();
          throw err;
        }
      }

      // Discord snowflake for "24 hours ago" — IDs encode timestamps,
      // so a fresh sync uses an ID derived from the cutoff time.
      const dayAgoMs = Date.now() - 24 * 3600 * 1000;
      // Discord epoch is 2015-01-01T00:00:00Z (1420070400000ms).
      const defaultAfter = String(BigInt(dayAgoMs - 1420070400000) << 22n);

      const cursors = cfg.cursors ?? {};
      let ingested = 0;
      let skipped = 0;
      let errors = 0;

      for (const channelId of cfg.watchedChannels ?? []) {
        try {
          const after = cursors[channelId] ?? defaultAfter;
          const msgs = await fetchAfter(cfg.botToken, channelId, after);
          if (msgs.length === 0) continue;
          const byDay = groupByDay(msgs);
          for (const [day, dayMsgs] of byDay) {
            const text = renderDigest(dayMsgs);
            if (!text) continue;
            const messageId = `discord:${cfg.guildId}:${channelId}:${day}`;
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
              kind: 'discord',
              messageId,
              rawHash,
              from: {
                name: `Discord · ${cfg.guildName ?? cfg.guildId}`,
                address: `discord@${cfg.guildId}.discord`,
              },
              to: [],
              cc: [],
              subject: `Discord #${channelId} — ${day}`,
              date: new Date(`${day}T00:00:00Z`),
              text,
              rawText: text,
              html: null,
              attachments: [],
              priority: 'normal',
              topics: ['discord'],
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
          // Advance cursor to the newest message id.
          const newest = msgs.reduce(
            (acc, m) => (m.id > acc ? m.id : acc),
            after,
          );
          cursors[channelId] = newest;
        } catch (err) {
          errors += 1;
          logger.warn(
            { err: (err as Error).message, channelId },
            'discord-sync: per-channel failure (continuing)',
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
        'discord-sync: done',
      );
    },
    { connection: redis, concurrency: 2 },
  );
  worker.on('failed', (job, err) =>
    logger.error({ jobId: job?.id, err: err.message }, 'discord-sync failed'),
  );
  return worker;
}
