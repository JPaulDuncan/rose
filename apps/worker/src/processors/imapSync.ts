import { Worker, type Job, Queue } from 'bullmq';
import { ImapFlow } from 'imapflow';
import { Types } from 'mongoose';
import { Source, Email, User } from '@rose/db';
import { parseEmail, formatImapError, senderDomainTag } from '@rose/email-parser';
import { decryptJson } from '../lib/crypto.js';
import { redis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { emitRecipeEvent } from '../lib/recipeEmit.js';
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
      // Snapshot the user's blocklist once per sync run so we don't
      // round-trip Mongo per message. The list is small.
      const userPrefs = await User.findById(userId).select('spamPolicy.blockedSenders').lean();
      const blocked = new Set(
        ((userPrefs?.spamPolicy?.blockedSenders as string[] | undefined) ?? []).map((a) =>
          a.toLowerCase(),
        ),
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
              if (fromAddr && blocked.has(fromAddr)) {
                skippedDup += 1;
                continue;
              }
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
              // Recipes — fire-and-forget, won't block ingest if it
              // fails. brand-key is derived from the from-address so
              // recipes can match on a normalized brand identifier.
              const recipeFromAddr = cleaned.from?.address ?? null;
              const recipeBrandKey = recipeFromAddr
                ? senderDomainTag(recipeFromAddr)
                : null;
              await emitRecipeEvent({
                kind: 'email.ingested',
                userId: userId.toString(),
                emailId: String(created._id),
                from: recipeFromAddr,
                subject: cleaned.subject ?? '',
                brandKey: recipeBrandKey ? recipeBrandKey.toLowerCase() : null,
                priority: cleaned.metadata.priority ?? null,
                tags: cleaned.metadata.topics ?? [],
              });
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
