import type { RecipeEvent } from '@rose/shared';
import { recipesQueue } from './queues.js';
import { logger } from './logger.js';

/**
 * API-side recipe-event emitter. Mirrors `apps/worker/src/lib/recipeEmit.ts`
 * for the cases where a state change happens inside an Express handler
 * (sender block, soon: source create, source delete, settings updates).
 * Fire-and-forget — never lets a failed enqueue break the request that
 * caused it.
 */
export async function emitRecipeEvent(event: RecipeEvent): Promise<void> {
  try {
    await recipesQueue.add(event.kind, event, {
      removeOnComplete: 200,
      removeOnFail: 200,
      attempts: 1,
    });
  } catch (err) {
    logger.warn({ err, kind: event.kind }, 'recipes: emit failed (continuing)');
  }
}
