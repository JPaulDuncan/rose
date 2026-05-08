import { Worker, type Job } from 'bullmq';
import { Types } from 'mongoose';
import { LibraryDocument } from '@rose/db';
import { redis, bullConnection } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { resolveProviderForUser } from '../lib/providers.js';

const QUEUE = 'rose.library-embed';

export type LibraryEmbedJobData = { documentId: string; userId: string };

/** Compose the embedding input string. Title carries strong signal so
 *  we repeat it, then summary, then a slice of body text. Bound at
 *  ~6KB so embedding is cheap and we don't blow past model context. */
function embeddingInput(doc: {
  title?: string;
  summary?: string;
  bodyText?: string;
}): string {
  const parts: string[] = [];
  if (doc.title) parts.push(doc.title);
  if (doc.summary) parts.push(doc.summary);
  if (doc.bodyText) parts.push(doc.bodyText.slice(0, 5000));
  return parts.join('\n\n');
}

export function startLibraryEmbedWorker(): void {
  const worker = new Worker<LibraryEmbedJobData>(
    QUEUE,
    async (job: Job<LibraryEmbedJobData>) => {
      const userId = new Types.ObjectId(job.data.userId);
      const doc = await LibraryDocument.findOne({ _id: job.data.documentId, userId });
      if (!doc) return { skipped: 'doc-not-found' };
      const input = embeddingInput(doc);
      if (!input) return { skipped: 'empty-input' };
      const r = await resolveProviderForUser(userId, 'embedding');
      if (!r.provider.supportsEmbeddings) {
        return { skipped: 'embedder-not-supported' };
      }
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30_000);
      let vec: number[];
      try {
        vec = await r.provider.embed(r.model, input, ctrl.signal);
      } finally {
        clearTimeout(timer);
      }
      doc.embedding = vec;
      doc.embeddingModel = `${r.providerId}:${r.model}`;
      await doc.save();
      return { dims: vec.length };
    },
    {
      connection: bullConnection(),
      concurrency: 4,
      lockDuration: 2 * 60_000,
      stalledInterval: 60_000,
      maxStalledCount: 1,
    },
  );
  worker.on('failed', (job, err) =>
    logger.warn({ jobId: job?.id, err }, 'library-embed: failed'),
  );
  worker.on('error', (err) => logger.error({ err }, 'library-embed: worker error'));
}
