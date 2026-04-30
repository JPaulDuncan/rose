import { Worker, type Job, Queue } from 'bullmq';
import { ImapFlow } from 'imapflow';
import { Types } from 'mongoose';
import { Source, Email } from '@rose/db';
import { parseEmail } from '@rose/email-parser';
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
        try {
          const since = source.lastSyncAt ?? new Date(Date.now() - 24 * 3600 * 1000);
          const uids = (await client.search({ since })) as number[];
          for (const uid of uids.slice(-50)) {
            const msg = await client.fetchOne(String(uid), { source: true });
            if (!msg) continue;
            const buf = msg.source as Buffer | undefined;
            if (!buf) continue;
            const cleaned = await parseEmail(buf);
            const exists = await Email.findOne({ userId, rawHash: cleaned.rawHash });
            if (exists) continue;
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
          }
        } finally {
          lock.release();
        }
        source.lastSyncAt = new Date();
        source.lastError = null;
        source.status = 'active';
        await source.save();
      } catch (err) {
        source.lastError = (err as Error).message;
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
