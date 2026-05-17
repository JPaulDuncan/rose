import { Worker, type Job } from 'bullmq';
import { Types } from 'mongoose';
import { Page, type PageDoc } from '@rose/db';
import { redis, bullConnection } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { runPostWriteEntityExtraction } from '../services/extractEntities.js';
import { extractComponentsFromPage } from '../services/extractUserFacts.js';
import { hashContent } from '../services/extractPlaces.js';
import { proposeDesksForUser } from '../services/proposeDesks.js';
import { runDeskProposalSweepNow } from '../services/deskProposalSweeper.js';
import { runMemoryGroupingForUser } from '../services/memoryGroupingSweep.js';

const QUEUE = 'rose.post-write-hooks';

/**
 * Plan 12 follow-up — generic post-write hook runner. Handlers:
 *
 *   - `entity-extract`: extract named entities + push to daydream
 *     subjects. The synthesis route enqueues this after creating
 *     its page (the route lives in the API process and can't
 *     import worker services directly).
 *   - `user-facts-extract`: extract atomic claims about the user
 *     into the MemoryComponent collection. xMemory's "components"
 *     layer (arXiv:2602.02007), scoped here to user-facts only;
 *     the grouping sweeper picks them up and aggregates into
 *     MemoryGroup themes.
 *
 * Best-effort: any failure is logged + dropped. Pages persist
 * regardless; the next surface that touches the page (regenerate,
 * direct daydream click) will re-trigger extraction.
 */
type PostWriteJobData =
  | { kind: 'entity-extract'; userId: string; pageId: string }
  | { kind: 'user-facts-extract'; userId: string; pageId: string }
  | { kind: 'suggest-desks'; userId: string }
  | { kind: 'desk-sweep-tick'; force?: boolean }
  | { kind: 'memory-backfill'; userId: string; limit?: number }
  | { kind: 'memory-regroup'; userId: string };

export function startPostWriteHooksWorker() {
  const worker = new Worker<PostWriteJobData>(
    QUEUE,
    async (job: Job<PostWriteJobData>) => {
      // Admin-triggered desk-sweep tick. No userId on the payload —
      // walks every user, gated by their per-user opt-out flag.
      // `force` skips the threshold gates (new-content, pending-
      // backlog) so the run actually does something even when those
      // would normally hold it.
      if (job.data.kind === 'desk-sweep-tick') {
        try {
          const summary = await runDeskProposalSweepNow({ force: job.data.force });
          return { ok: true, ...summary };
        } catch (err) {
          logger.warn(
            { err },
            'post-write hooks: desk-sweep-tick failed',
          );
          return { ok: false };
        }
      }

      const userId = new Types.ObjectId(job.data.userId);

      // xMemory ad-hoc operations — user-triggered via the
      // Settings → Memory maintenance panel.
      if (job.data.kind === 'memory-backfill') {
        const limit = Math.min(job.data.limit ?? 200, 500);
        try {
          // Pages that have never been through the components
          // extractor (legacy data + pages where the gen path
          // bailed). Cap aggressively so a 5000-page archive
          // doesn't burn the LLM cap in one click — the UI
          // surfaces the remaining count so the user knows.
          const pages = (await Page.find({
            userId,
            $or: [
              { memoryComponentsExtractedFromHash: null },
              { memoryComponentsExtractedFromHash: { $exists: false } },
            ],
          })
            .sort({ updatedAt: -1 })
            .limit(limit)
            .lean()) as PageDoc[];
          let extracted = 0;
          for (const p of pages) {
            try {
              await extractComponentsFromPage(userId, p);
              const hash = hashContent(p.contentMd ?? '');
              await Page.updateOne(
                { _id: p._id, userId },
                { $set: { memoryComponentsExtractedFromHash: hash } },
              );
              extracted += 1;
            } catch (err) {
              logger.debug(
                { err, pageId: String(p._id) },
                'memory-backfill: per-page failure (continuing)',
              );
            }
          }
          return { ok: true, scanned: pages.length, extracted };
        } catch (err) {
          logger.warn(
            { err, userId: String(userId) },
            'memory-backfill: failed',
          );
          return { ok: false };
        }
      }

      if (job.data.kind === 'memory-regroup') {
        try {
          const summary = await runMemoryGroupingForUser(userId);
          return { ok: true, ...summary };
        } catch (err) {
          logger.warn(
            { err, userId: String(userId) },
            'memory-regroup: failed',
          );
          return { ok: false };
        }
      }

      // suggest-desks isn't pageId-scoped; handle before the page
      // lookup so it doesn't bail on "page-not-found".
      if (job.data.kind === 'suggest-desks') {
        try {
          const summary = await proposeDesksForUser(userId);
          return { ok: true, ...summary };
        } catch (err) {
          logger.warn(
            { err, userId: job.data.userId },
            'post-write hooks: propose-desks failed',
          );
          return { ok: false };
        }
      }

      const page = (await Page.findOne({
        _id: job.data.pageId,
        userId,
      })) as PageDoc | null;
      if (!page) return { skipped: 'page-not-found' };

      if (job.data.kind === 'entity-extract') {
        try {
          await runPostWriteEntityExtraction(
            userId,
            page,
            hashContent(page.contentMd ?? ''),
          );
          return { ok: true };
        } catch (err) {
          logger.warn(
            { err, pageId: job.data.pageId },
            'post-write hooks: entity extraction failed',
          );
          return { ok: false };
        }
      }

      if (job.data.kind === 'user-facts-extract') {
        // Job-kind name preserved for back-compat with already-enqueued
        // jobs, but the handler now runs the dual-subject extractor —
        // emits both user-facts AND world-facts in one LLM call.
        const componentsHash = hashContent(page.contentMd ?? '');
        if (page.memoryComponentsExtractedFromHash === componentsHash) {
          return { ok: true, extracted: 0, skipped: 'unchanged-content' };
        }
        try {
          const out = await extractComponentsFromPage(userId, page);
          page.memoryComponentsExtractedFromHash = componentsHash;
          await page.save();
          return { ok: true, extracted: out.length };
        } catch (err) {
          logger.warn(
            { err, pageId: job.data.pageId },
            'post-write hooks: components extraction failed',
          );
          return { ok: false };
        }
      }

      return { skipped: 'unknown-kind' };
    },
    {
      connection: bullConnection(),
      concurrency: 2,
      lockDuration: 2 * 60_000,
    },
  );
  worker.on('failed', (job, err) =>
    logger.error({ jobId: job?.id, err }, 'post-write hooks: job failed'),
  );
  worker.on('error', (err) =>
    logger.error({ err }, 'post-write hooks: worker error'),
  );
}
