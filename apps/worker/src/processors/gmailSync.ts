import { Worker, type Job, Queue } from 'bullmq';
import { google } from 'googleapis';
import { Types } from 'mongoose';
import { Source, Email } from '@rose/db';
import { parseEmail } from '@rose/email-parser';
import { decryptJson, encryptJson } from '../lib/crypto.js';
import { redis } from '../lib/redis.js';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';

const QUEUE = 'rose.gmail-sync';
const generateQueue = new Queue('rose.generate-page', { connection: redis });

type GmailJobData = { sourceId: string; userId: string };

type GmailStored = { authCode?: string; refreshToken?: string; lastHistoryId?: string };

export function startGmailSyncWorker() {
  const worker = new Worker<GmailJobData>(
    QUEUE,
    async (job: Job<GmailJobData>) => {
      const userId = new Types.ObjectId(job.data.userId);
      const source = await Source.findOne({ _id: job.data.sourceId, userId }).select('+encryptedConfig');
      if (!source || source.type !== 'gmail' || !source.encryptedConfig) return;
      if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
        throw new Error('Gmail OAuth credentials not configured');
      }

      const stored = decryptJson<GmailStored>(source.encryptedConfig);
      const oauth2 = new google.auth.OAuth2(
        env.GOOGLE_CLIENT_ID,
        env.GOOGLE_CLIENT_SECRET,
        env.GOOGLE_REDIRECT_URI,
      );

      if (!stored.refreshToken && stored.authCode) {
        const { tokens } = await oauth2.getToken(stored.authCode);
        if (!tokens.refresh_token) throw new Error('Gmail did not return a refresh_token');
        stored.refreshToken = tokens.refresh_token;
        stored.authCode = undefined;
        source.encryptedConfig = encryptJson(stored);
      }
      oauth2.setCredentials({ refresh_token: stored.refreshToken });

      const gmail = google.gmail({ version: 'v1', auth: oauth2 });
      const list = await gmail.users.messages.list({
        userId: 'me',
        maxResults: 25,
        q: 'newer_than:7d',
      });
      const messages = list.data.messages ?? [];
      for (const m of messages) {
        if (!m.id) continue;
        const full = await gmail.users.messages.get({
          userId: 'me',
          id: m.id,
          format: 'raw',
        });
        const raw = full.data.raw ? Buffer.from(full.data.raw, 'base64url') : null;
        if (!raw) continue;
        const cleaned = await parseEmail(raw);
        const exists = await Email.findOne({ userId, rawHash: cleaned.rawHash });
        if (exists) continue;
        const created = await Email.create({
          userId,
          sourceId: source._id,
          messageId: cleaned.messageId,
          threadKey: cleaned.threadKey,
          subjectTemplate: cleaned.subjectTemplate,
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
          priority: cleaned.metadata.priority,
          topics: cleaned.metadata.topics,
          links: cleaned.metadata.links,
          images: cleaned.metadata.images,
          spamScore: cleaned.metadata.spamScore,
          spamSignals: cleaned.metadata.spamSignals,
          isMassMailing: cleaned.metadata.isMassMailing,
          promotionalScore: cleaned.metadata.promotionalScore,
          isPromotional: cleaned.metadata.isPromotional,
          promotionalSignals: cleaned.metadata.promotionalSignals,
          authResults: cleaned.metadata.authResults,
          logoCandidate: cleaned.metadata.logoCandidate ?? undefined,
          unsubscribeUrls: cleaned.metadata.unsubscribeUrls,
          ingestStatus: 'parsed',
        });
        await generateQueue.add(
          'generate',
          { emailId: created._id.toString(), userId: userId.toString() },
          { attempts: 3, removeOnComplete: 500, removeOnFail: 500 },
        );
      }
      source.lastSyncAt = new Date();
      source.lastError = null;
      await source.save();
    },
    { connection: redis, concurrency: 1 },
  );
  worker.on('failed', (job, err) => logger.error({ jobId: job?.id, err }, 'gmail-sync failed'));
  return worker;
}
