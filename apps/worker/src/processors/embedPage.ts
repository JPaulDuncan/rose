import { Worker, type Job } from 'bullmq';
import { Page } from '@rose/db';
import { redis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { resolveProviderForUser } from '../lib/providers.js';

const QUEUE = 'rose.embed-page';

type EmbedJobData = { pageId: string; userId?: string };

export function startEmbedPageWorker() {
  const worker = new Worker<EmbedJobData>(
    QUEUE,
    async (job: Job<EmbedJobData>) => {
      const page = await Page.findById(job.data.pageId);
      if (!page) return;
      const { provider, model } = await resolveProviderForUser(page.userId, 'embedding');
      if (!provider.supportsEmbeddings) {
        throw new Error(
          `Configured embedding provider (${provider.id}) does not support embeddings`,
        );
      }
      const text = `${page.title}\n${page.summary}\n${page.contentMd}`.slice(0, 8000);
      const embedding = await provider.embed(model, text);
      page.embedding = embedding;
      page.embeddingModel = `${provider.id}:${model}`;
      await page.save();
    },
    { connection: redis, concurrency: 4 },
  );
  worker.on('failed', (job, err) => logger.error({ jobId: job?.id, err }, 'embed-page failed'));
  return worker;
}
