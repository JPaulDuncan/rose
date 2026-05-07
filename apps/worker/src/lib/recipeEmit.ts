import { Queue } from 'bullmq';
import type { RecipeEvent } from '@rose/shared';
import { redis } from './redis.js';
import { logger } from './logger.js';

/** Single shared queue handle so processors don't each construct a
 *  new Queue object per import. */
const queue = new Queue('rose.recipes', { connection: redis });

/**
 * Enqueue a recipe event. Fire-and-forget — we never want a failure
 * to emit to break the upstream processor that called us. Errors are
 * logged but never thrown.
 */
export async function emitRecipeEvent(event: RecipeEvent): Promise<void> {
  try {
    await queue.add(event.kind, event, {
      removeOnComplete: 200,
      removeOnFail: 200,
      attempts: 1,
    });
  } catch (err) {
    logger.warn({ err, kind: event.kind }, 'recipes: emit failed (continuing)');
  }
}
