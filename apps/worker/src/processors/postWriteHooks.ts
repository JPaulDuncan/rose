import { Worker, type Job } from 'bullmq';
import { Types } from 'mongoose';
import { Page, type PageDoc } from '@rose/db';
import { redis, bullConnection } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { runPostWriteEntityExtraction } from '../services/extractEntities.js';
import { hashContent } from '../services/extractPlaces.js';

const QUEUE = 'rose.post-write-hooks';

/**
 * Plan 12 follow-up — generic post-write hook runner. Today the
 * only handler is "extract entities + push to daydream subjects",
 * which the synthesis route enqueues after creating its page (it
 * lives in the API process and can't import worker services
 * directly).
 *
 * Job shape:
 *   { kind: 'entity-extract', userId, pageId }
 *
 * Best-effort: any failure is logged + dropped. Pages persist
 * regardless; the next surface that touches the page (regenerate,
 * direct daydream click) will re-trigger extraction.
 */
type PostWriteJobData = {
  kind: 'entity-extract';
  userId: string;
  pageId: string;
};

export function startPostWriteHooksWorker() {
  const worker = new Worker<PostWriteJobData>(
    QUEUE,
    async (job: Job<PostWriteJobData>) => {
      if (job.data.kind !== 'entity-extract') return { skipped: 'unknown-kind' };
      const userId = new Types.ObjectId(job.data.userId);
      const page = (await Page.findOne({
        _id: job.data.pageId,
        userId,
      })) as PageDoc | null;
      if (!page) return { skipped: 'page-not-found' };
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
