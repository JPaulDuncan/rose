import { Worker, type Job, Queue } from 'bullmq';
import { ImapFlow } from 'imapflow';
import { Types } from 'mongoose';
import { Source, User } from '@rose/db';
import {
  parseEmail,
  formatImapError,
  compileSenderBlocklist,
  isSenderBlocked,
  isSenderWhitelisted,
} from '@rose/email-parser';
import { decryptJson } from '../lib/crypto.js';
import { bullConnection } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import {
  DEFAULT_FLUSH_SIZE,
  flushPendingEmails,
  type PendingEmail,
} from '../lib/bulkIngestEmails.js';
import { type ImapConfig } from '@rose/shared';

const QUEUE = 'rose.imap-sync';
const generateQueue = new Queue('rose.generate-page', { connection: bullConnection() });

type ImapJobData = { sourceId: string; userId: string };

export function startImapSyncWorker() {
  const worker = new Worker<ImapJobData>(
    QUEUE,
    async (job: Job<ImapJobData>) => {
      const userId = new Types.ObjectId(job.data.userId);
      const source = await Source.findOne({ _id: job.data.sourceId, userId }).select('+encryptedConfig');
      if (!source || source.type !== 'imap' || !source.encryptedConfig) return;

      const cfg = decryptJson<ImapConfig>(source.encryptedConfig);
      // Snapshot the user's blocklist + whitelist once per sync run
      // so we don't round-trip Mongo per message. Both compile into
      // address + brand sets so a `notices.medium.com` entry also
      // covers every other `*.medium.com` mailer.
      const userPrefs = await User.findById(userId)
        .select('spamPolicy.blockedSenders spamPolicy.whitelistedSenders')
        .lean();
      const blocked = compileSenderBlocklist(
        (userPrefs?.spamPolicy?.blockedSenders as string[] | undefined) ?? [],
      );
      const whitelisted = compileSenderBlocklist(
        (userPrefs?.spamPolicy?.whitelistedSenders as string[] | undefined) ?? [],
      );
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
          // historicalBackfillDays=0 + no prior sync = "pull everything":
          // search the whole mailbox with no date filter. Once lastSyncAt
          // is set the next run is incremental from there regardless.
          const since = source.lastSyncAt
            ?? (backfillDays > 0
              ? new Date(Date.now() - backfillDays * 24 * 3600 * 1000)
              : null);
          const uids = (await client.search(
            since ? { since } : { all: true },
          )) as number[];
          // Newest first so user sees recent mail in the UI sooner.
          const ordered = [...uids].sort((a, b) => b - a);
          const toFetch = cap > 0 ? ordered.slice(0, cap) : ordered;
          logger.info(
            {
              sourceId: String(source._id),
              found: uids.length,
              fetching: toFetch.length,
              backfillDays,
              mode: since ? 'incremental' : 'all',
            },
            'imap-sync: starting fetch',
          );
          const pending: PendingEmail[] = [];
          const flushCtx = {
            userId,
            sourceId: source._id as Types.ObjectId,
            sourceTag: 'imap' as const,
            generateQueue,
          };
          const flush = async () => {
            const r = await flushPendingEmails(pending, flushCtx);
            ingested += r.ingested;
            skippedDup += r.skippedDup;
          };
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
              // Hard block — drop on the floor before we spend a row +
              // page-generation pass on it. Counts as `skippedDup` so
              // the user's stats keep reading "we ignored this".
              const fromAddr = cleaned.from?.address?.toLowerCase() ?? '';
              // Whitelist wins — the .gov / .edu default plus the
              // user's trusted-sender list both bypass the blocklist
              // and the per-message spam classifier downstream.
              const isWhitelisted = isSenderWhitelisted(whitelisted, fromAddr);
              if (
                fromAddr &&
                !isWhitelisted &&
                isSenderBlocked(blocked, fromAddr)
              ) {
                skippedDup += 1;
                continue;
              }
              pending.push({ assignedId: new Types.ObjectId(), cleaned });
              if (pending.length >= DEFAULT_FLUSH_SIZE) await flush();
            } catch (perMsgErr) {
              failed += 1;
              logger.warn({ uid, err: perMsgErr }, 'imap-sync: per-message failure (continuing)');
            }
          }
          await flush();
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
    { connection: bullConnection(), concurrency: 2 },
  );
  worker.on('failed', (job, err) => logger.error({ jobId: job?.id, err }, 'imap-sync failed'));
  return worker;
}
