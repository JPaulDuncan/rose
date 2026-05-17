import { Worker, type Job } from 'bullmq';
import { Types } from 'mongoose';
import { Page, type PageDoc } from '@rose/db';
import { redis, bullConnection } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { runPostWriteEntityExtraction } from '../services/extractEntities.js';
import { extractUserFactsFromPage } from '../services/extractUserFacts.js';
import { hashContent } from '../services/extractPlaces.js';

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
  | { kind: 'user-facts-extract'; userId: string; pageId: string };

export function startPostWriteHooksWorker() {
  const worker = new Worker<PostWriteJobData>(
    QUEUE,
    async (job: Job<PostWriteJobData>) => {
      const userId = new Types.ObjectId(job.data.userId);
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
        try {
          const out = await extractUserFactsFromPage(userId, page);
          return { ok: true, extracted: out.length };
        } catch (err) {
          logger.warn(
            { err, pageId: job.data.pageId },
            'post-write hooks: user-facts extraction failed',
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
