import { Worker, Queue, type Job } from 'bullmq';
import { Types } from 'mongoose';
import { Page, User, type PageDoc } from '@rose/db';
import { redis, bullConnection } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { runPostWriteReceiptExtraction } from '../services/extractReceipt.js';
import { runPostWriteRelationExtraction } from '../services/extractRelations.js';
import { runPostWriteSubscriptionExtraction } from '../services/extractSubscription.js';
import { extractOutboundLinks } from '../services/outboundLinks.js';

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
 * The `daydream` kind is different: instead of running an
 * extractor in-process, it enqueues a `kind: 'page'` job onto the
 * shared `rose.daydream` queue so the dedicated daydream worker
 * (with its own daily cap + opt-in gate) does the research. Jobs
 * use a deterministic id so a re-run collapses to one outstanding
 * job per (user, page).
 *
 * Concurrency stays low (2) so a deployment-wide backfill doesn't
 * starve real-time generation work.
 */

const QUEUE = 'rose.backfill';

/**
 * Standalone handle to the daydream queue. The backfill worker
 * doesn't share `@rose/api`'s queue registry (separate process,
 * separate dependency graph) so we construct our own. Same
 * connection options as `daydreamSweeper.ts` — point them at the
 * same Redis and BullMQ deduplicates the jobs by id.
 */
const daydreamQueue = new Queue('rose.daydream', { connection: redis });

export type BackfillJobData = {
  kind:
    | 'receipt'
    | 'subscription'
    | 'relations'
    | 'daydream'
    | 'outbound-links'
    | 'all';
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
  if (kind === 'outbound-links' || kind === 'all') {
    // Populate / refresh Page.outboundLinks. Cheap — runs the same
    // regex `extractOutboundLinks` does at write time. Idempotent;
    // if the cache is already up to date, the write is a no-op.
    const slug = (page.slug as string | undefined) ?? null;
    const body = (page.contentMd as string | undefined) ?? '';
    const next = extractOutboundLinks(body, slug);
    const prev = (page.outboundLinks as string[] | undefined) ?? [];
    const same =
      prev.length === next.length && prev.every((s, i) => s === next[i]);
    if (!same) {
      page.outboundLinks = next;
      try {
        await page.save();
      } catch (err) {
        logger.debug(
          { err, pageId },
          'backfill: outbound-links save failed (continuing)',
        );
      }
    }
    ran.push('outbound-links');
  }
  // Daydream backfill — enqueue a per-page daydream job. The
  // daydream worker walks the page's `daydreamSubjects[]` array,
  // runs adapters against each, and writes notes. This mirrors what
  // the idle-time sweeper does (`daydreamSweeper.ts`) but on demand
  // — useful for admins after a daydream-subject-extraction change.
  //
  // Per-job gates we still respect even though the sweeper skipped:
  //   • Skip if the user has daydream disabled.
  //   • Skip if the page has no `daydreamSubjects[]` to research.
  //   • Skip spam-flagged pages.
  // The daydream worker itself enforces the daily call cap (Redis
  // counter), so enqueuing more than the cap is a no-op — the
  // worker drains the queue and only the first N actually run.
  if (kind === 'daydream' || kind === 'all') {
    const user = await User.findById(userId)
      .select('settings.daydream.enabled settings.daydream.schedule')
      .lean();
    const enabled =
      (user?.settings as { daydream?: { enabled?: boolean; schedule?: string } } | undefined)
        ?.daydream?.enabled === true;
    const subjects = (page.daydreamSubjects as
      | Array<{ kind: string; subjectKey: string }>
      | undefined) ?? [];
    const flags = (page.flags as
      | { userMarkedSpam?: boolean; hasLikelySpam?: boolean }
      | undefined) ?? {};
    const isSpammy =
      flags.userMarkedSpam === true || flags.hasLikelySpam === true;

    if (!enabled) {
      logger.debug(
        { pageId, userId: String(userId) },
        'backfill: daydream skipped — user disabled',
      );
      ran.push('daydream(skip:disabled)');
    } else if (isSpammy) {
      logger.debug(
        { pageId, userId: String(userId) },
        'backfill: daydream skipped — spam-flagged page',
      );
      ran.push('daydream(skip:spam)');
    } else if (subjects.length === 0) {
      logger.debug(
        { pageId, userId: String(userId) },
        'backfill: daydream skipped — no subjects on page',
      );
      ran.push('daydream(skip:empty)');
    } else {
      try {
        await daydreamQueue.add(
          'page',
          {
            kind: 'page',
            userId: String(userId),
            pageId: String(page._id),
          },
          {
            // Collapse to one job per (userId, pageId) so a
            // re-run backfill doesn't fan out duplicate work.
            jobId: `backfill-daydream__${String(userId)}__${String(page._id)}`,
            attempts: 1,
            removeOnComplete: 200,
            removeOnFail: 200,
            // Same priority as the sweeper — sits behind every
            // real-time generation job. Daydream's own
            // concurrency=1 keeps the cap honest.
            priority: 10,
          },
        );
        ran.push('daydream(enqueued)');
      } catch (err) {
        logger.warn(
          { err, pageId, userId: String(userId) },
          'backfill: daydream enqueue failed (continuing)',
        );
        ran.push('daydream(error)');
      }
    }
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
