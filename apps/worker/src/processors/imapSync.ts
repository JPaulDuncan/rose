import { Worker, type Job, Queue } from 'bullmq';
import { ImapFlow } from 'imapflow';
import { Types } from 'mongoose';
import { Source, Email } from '@rose/db';
import { parseEmail, formatImapError } from '@rose/email-parser';
import { decryptJson } from '../lib/crypto.js';
import { redis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import type { ImapConfig } from '@rose/shared';

const QUEUE = 'rose.imap-sync';
const generateQueue = new Queue('rose.generate-page', { connection: redis });

type ImapJobData = { sourceId: string; userId: string };

export function startImapSyncWorker() {
  const worker = new Worker<ImapJobData>(
    QUEUE,
    async (job: Job<ImapJobData>) => {
      const userId = new Types.ObjectId(job.data.userId);
      const source = await Source.findOne({ _id: job.data.sourceId, userId }).select('+encryptedConfig');
      if (!source || source.type !== 'imap' || !source.encryptedConfig) return;

      const cfg = decryptJson<ImapConfig>(source.encryptedConfig);
      const client = new ImapFlow({
        host: cfg.host,
        port: cfg.port,
        secure: cfg.secure,
        auth: { user: cfg.username, pass: cfg.password },
        logger: false,
      });

      try {
        await client.connect();
        const lock = await client.getMailboxLock(cfg.mailbox);
        let ingested = 0;
        let skippedDup = 0;
        let failed = 0;
        try {
          const backfillDays = cfg.historicalBackfillDays ?? 30;
          const cap = cfg.maxPerSync ?? 2000;
          const since =
            source.lastSyncAt ?? new Date(Date.now() - backfillDays * 24 * 3600 * 1000);
          const uids = (await client.search({ since })) as number[];
          // Newest first so user sees recent mail in the UI sooner.
          const ordered = [...uids].sort((a, b) => b - a);
          const toFetch = cap > 0 ? ordered.slice(0, cap) : ordered;
          logger.info(
            { sourceId: String(source._id), found: uids.length, fetching: toFetch.length, backfillDays },
            'imap-sync: starting fetch',
          );
          for (const uid of toFetch) {
            try {
              const msg = await client.fetchOne(String(uid), { source: true });
              if (!msg) {
                failed += 1;
                continue;
              }
              const buf = msg.source as Buffer | undefined;
              if (!buf) {
                failed += 1;
                continue;
              }
              const cleaned = await parseEmail(buf);
              const exists = await Email.findOne({ userId, rawHash: cleaned.rawHash });
              if (exists) {
                skippedDup += 1;
                continue;
              }
              const created = await Email.create({
                userId,
                sourceId: source._id,
                messageId: cleaned.messageId,
                threadKey: cleaned.threadKey,
                rawHash: cleaned.rawHash,
                from: cleaned.from,
                to: cleaned.to,
                cc: cleaned.cc,
                subject: cleaned.subject,
                date: cleaned.date,
                text: cleaned.text,
                rawText: cleaned.rawText,
                html: cleaned.html,
                attachments: cleaned.attachments.map((a) => ({
                  filename: a.filename,
                  contentType: a.contentType,
                  size: a.size,
                  contentId: a.contentId,
                })),
                ingestStatus: 'parsed',
              });
              await generateQueue.add(
                'generate',
                { emailId: created._id.toString(), userId: userId.toString() },
                { attempts: 3, removeOnComplete: 500, removeOnFail: 500 },
              );
              ingested += 1;
            } catch (perMsgErr) {
              failed += 1;
              logger.warn({ uid, err: perMsgErr }, 'imap-sync: per-message failure (continuing)');
            }
          }
        } finally {
          lock.release();
        }
        logger.info(
          { sourceId: String(source._id), ingested, skippedDup, failed },
          'imap-sync: done',
        );
        source.lastSyncAt = new Date();
        source.lastError = null;
        source.status = 'active';
        await source.save();
      } catch (err) {
        source.lastError = formatImapError(err, cfg.host);
        source.status = 'error';
        await source.save();
        throw err;
      } finally {
        await client.logout().catch(() => null);
      }
    },
    { connection: redis, concurrency: 2 },
  );
  worker.on('failed', (job, err) => logger.error({ jobId: job?.id, err }, 'imap-sync failed'));
  return worker;
}
