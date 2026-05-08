import { Worker, Queue, type Job } from 'bullmq';
import { User, runRetentionCleanup } from '@rose/db';
import { redis, bullConnection } from '../lib/redis.js';
import { logger } from '../lib/logger.js';

const QUEUE = 'rose.cleanup';

/**
 * Nightly retention sweep. Walks every user, applies their
 * configured retention windows via @rose/db's runRetentionCleanup,
 * and persists the resulting summary on the user so the settings
 * page can render "last cleanup: x rows pruned" inline.
 */
async function runCleanupSweep(): Promise<{ users: number }> {
  const users = await User.find({}).select('_id').lean();
  let processed = 0;
  for (const u of users) {
    try {
      const summary = await runRetentionCleanup(u._id);
      logger.info(
        { userId: String(u._id), summary },
        'cleanup sweep: user complete',
      );
      processed += 1;
    } catch (err) {
      logger.error({ err, userId: String(u._id) }, 'cleanup sweep: user failed');
    }
  }
  return { users: processed };
}

export function startCleanupWorker() {
  const worker = new Worker(
    QUEUE,
    async (_job: Job) => {
      logger.info('cleanup sweep: starting');
      const r = await runCleanupSweep();
      logger.info({ users: r.users }, 'cleanup sweep: done');
    },
    { connection: bullConnection(), concurrency: 1 },
  );
  worker.on('failed', (job, err) =>
    logger.error({ err, jobId: job?.id }, 'cleanup sweep failed'),
  );
  return worker;
}

/** Schedule a daily cleanup sweep + an immediate one at boot so
 *  newly-tweaked retention settings take effect without a 24h wait. */
export async function scheduleCleanupSweeper(): Promise<void> {
  const queue = new Queue(QUEUE, { connection: bullConnection() });
  await queue.add(
    'sweep',
    {},
    { repeat: { every: 24 * 60 * 60 * 1000 }, jobId: 'cleanup:sweep' },
  );
  await queue.add('sweep', {}, { attempts: 1, removeOnComplete: 5 });
}
