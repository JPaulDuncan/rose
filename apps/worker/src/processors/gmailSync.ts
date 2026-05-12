import { Worker, type Job, Queue } from 'bullmq';
import { google } from 'googleapis';
import { Types } from 'mongoose';
import { Source, User } from '@rose/db';
import {
  parseEmail,
  compileSenderBlocklist,
  isSenderBlocked,
  isSenderWhitelisted,
} from '@rose/email-parser';
import { decryptJson, encryptJson } from '../lib/crypto.js';
import { bullConnection } from '../lib/redis.js';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import {
  DEFAULT_FLUSH_SIZE,
  flushPendingEmails,
  type PendingEmail,
} from '../lib/bulkIngestEmails.js';

const QUEUE = 'rose.gmail-sync';
const generateQueue = new Queue('rose.generate-page', { connection: bullConnection() });

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
      // Snapshot the user's blocklist + whitelist once per sync run.
      // Whitelist wins: a `.gov`/`.edu` sender or anything the user
      // explicitly trusted bypasses the blocklist and downstream
      // spam classifier.
      const userPrefs = await User.findById(userId)
        .select('spamPolicy.blockedSenders spamPolicy.whitelistedSenders')
        .lean();
      const blocked = compileSenderBlocklist(
        (userPrefs?.spamPolicy?.blockedSenders as string[] | undefined) ?? [],
      );
      const whitelisted = compileSenderBlocklist(
        (userPrefs?.spamPolicy?.whitelistedSenders as string[] | undefined) ?? [],
      );
      const list = await gmail.users.messages.list({
        userId: 'me',
        maxResults: 25,
        q: 'newer_than:7d',
      });
      const messages = list.data.messages ?? [];
      const pending: PendingEmail[] = [];
      const flushCtx = {
        userId,
        sourceId: source._id as Types.ObjectId,
        sourceTag: 'gmail' as const,
        generateQueue,
      };
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
        const fromAddr = cleaned.from?.address?.toLowerCase() ?? '';
        const isWhitelisted = isSenderWhitelisted(whitelisted, fromAddr);
        if (fromAddr && !isWhitelisted && isSenderBlocked(blocked, fromAddr)) continue;
        pending.push({ assignedId: new Types.ObjectId(), cleaned });
        if (pending.length >= DEFAULT_FLUSH_SIZE) await flushPendingEmails(pending, flushCtx);
      }
      await flushPendingEmails(pending, flushCtx);
      source.lastSyncAt = new Date();
      source.lastError = null;
      await source.save();
    },
    { connection: bullConnection(), concurrency: 1 },
  );
  worker.on('failed', (job, err) => logger.error({ jobId: job?.id, err }, 'gmail-sync failed'));
  return worker;
}
