import { Worker, type Job } from 'bullmq';
import { Types } from 'mongoose';
import { Page, type PageDoc } from '@rose/db';
import { bullConnection } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { runPostWriteReceiptExtraction } from '../services/extractReceipt.js';
import { runPostWriteRelationExtraction } from '../services/extractRelations.js';
import { runPostWriteSubscriptionExtraction } from '../services/extractSubscription.js';

/**
 * Backfill worker. Replays the four post-write extractors against
 * existing pages so historical archives benefit from extractor
 * improvements (structured-data fast paths, Wikidata enrichment,
 * verbatim Wikipedia notes) without waiting for each page to be
 * organically regenerated.
 *
 * Job shape:
 *   { kind: 'receipt' | 'subscription' | 'relations' | 'daydream' | 'all',
 *     userId, pageId }
 *
 * Each extractor is idempotent via its own content-hash gate, so
 * the worker happily re-runs the chain against pages that already
 * upgraded — those calls short-circuit cheaply. The point of the
 * gate is that the FIRST time we replay against a page from
 * BEFORE the extractor existed, the hash doesn't match, the
 * extractor runs, and the upgraded row replaces the older /
 * less-trusted one (typically `llm` → `structured`).
 *
 * Concurrency stays low (2) so a deployment-wide backfill doesn't
 * starve real-time generation work.
 */

const QUEUE = 'rose.backfill';

export type BackfillJobData = {
  kind: 'receipt' | 'subscription' | 'relations' | 'daydream' | 'all';
  userId: string;
  pageId: string;
};

async function processJob(job: Job<BackfillJobData>): Promise<unknown> {
  const { kind, userId: userIdStr, pageId } = job.data;
  if (!Types.ObjectId.isValid(userIdStr) || !Types.ObjectId.isValid(pageId)) {
    return { skipped: 'invalid-id' };
  }
  const userId = new Types.ObjectId(userIdStr);
  const page = (await Page.findOne({ _id: pageId, userId })) as PageDoc | null;
  if (!page) return { skipped: 'page-not-found' };

  const ran: string[] = [];
  if (kind === 'receipt' || kind === 'all') {
    await runPostWriteReceiptExtraction(userId, page);
    ran.push('receipt');
  }
  if (kind === 'subscription' || kind === 'all') {
    await runPostWriteSubscriptionExtraction(userId, page);
    ran.push('subscription');
  }
  if (kind === 'relations' || kind === 'all') {
    await runPostWriteRelationExtraction(userId, page);
    ran.push('relations');
  }
  // Daydream backfill — these notes are global, so the right
  // hook isn't per-page but per-subject. We surface the page's
  // existing daydreamSubjects[] and let the worker's daydream
  // queue do the actual research. For now we just no-op when
  // kind=daydream; a future expansion can enqueue daydream jobs
  // directly. Keeping the code path here so the admin UI's
  // "Daydream" button isn't dead — it just logs and exits.
  if (kind === 'daydream' || kind === 'all') {
    logger.debug(
      { pageId, kind },
      'backfill: daydream kind is a no-op today (per-subject queue handles refreshes)',
    );
    ran.push('daydream(noop)');
  }
  return { ran };
}

export function startBackfillWorker(): void {
  const worker = new Worker<BackfillJobData>(QUEUE, processJob, {
    connection: bullConnection(),
    // Backfill is a background sweep; bigger concurrency would
    // contend with real-time work for the LLM provider's queue.
    concurrency: 2,
    lockDuration: 10 * 60_000,
    stalledInterval: 60_000,
    maxStalledCount: 2,
  });
  worker.on('failed', (job, err) =>
    logger.warn({ jobId: job?.id, err }, 'backfill: job failed'),
  );
  worker.on('error', (err) =>
    logger.error({ err }, 'backfill: worker error'),
  );
}
