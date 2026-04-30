import { QueueEvents, Queue } from 'bullmq';
import { redis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';

const generateEvents = new QueueEvents('rose.generate-page', { connection: redis });
const embedQueue = new Queue('rose.embed-page', { connection: redis });

/**
 * Bridge: after a page is generated, enqueue an embedding job.
 * Worker.returnvalue from generatePage returns { pageId, slug } as JSON string.
 */
export function startEmbedBridge() {
  generateEvents.on('completed', async ({ returnvalue, jobId }) => {
    try {
      const parsed = typeof returnvalue === 'string' ? JSON.parse(returnvalue) : returnvalue;
      const pageId = (parsed as { pageId?: string })?.pageId;
      if (!pageId) return;
      // userId is on the original job data; we don't have it on the event.
      // The embed worker reads userId from page.userId via the page document instead.
      await embedQueue.add(
        'embed',
        { pageId, userId: '' },
        { attempts: 3, removeOnComplete: 200, removeOnFail: 200 },
      );
    } catch (err) {
      logger.warn({ err, jobId }, 'embed bridge failed');
    }
  });
}
