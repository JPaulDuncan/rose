import { Router } from 'express';
import { Types } from 'mongoose';
import { Recipe, RecipeAudit } from '@rose/db';
import {
  RecipeCreateRequest,
  RecipeUpdateRequest,
  type RecipeEvent,
} from '@rose/shared';
import { userIdOf } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { recipesQueue } from '../lib/queues.js';
import { logger } from '../lib/logger.js';

export const recipesRouter: Router = Router();

/**
 * Cron job key for a time-scheduled recipe. Used both when
 * registering the BullMQ repeatable on save AND when removing it on
 * disable / delete. Stable per-recipe so re-registers replace
 * cleanly.
 */
function cronJobKey(recipeId: string): string {
  return `cron:${recipeId}`;
}

/** Register / re-register / remove a recipe's BullMQ repeatable so
 *  the schedule matches what the recipe says. Idempotent. */
async function syncCronSchedule(recipe: {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  enabled: boolean;
  trigger: { kind: string; config?: { cron?: string; timezone?: string } };
}): Promise<void> {
  const id = String(recipe._id);
  const key = cronJobKey(id);
  // Always remove first so a config change (different cron, new
  // timezone) takes effect on the next tick rather than running
  // both the old and new schedule until manual cleanup.
  await recipesQueue.removeRepeatableByKey(key).catch(() => null);
  if (!recipe.enabled) return;
  if (recipe.trigger.kind !== 'time.scheduled') return;
  const cron = recipe.trigger.config?.cron;
  if (!cron) return;
  const tz = recipe.trigger.config?.timezone || 'UTC';
  const event: RecipeEvent = {
    kind: 'time.scheduled',
    userId: String(recipe.userId),
    recipeId: id,
  };
  try {
    await recipesQueue.add('time.scheduled', event, {
      repeat: { pattern: cron, tz },
      jobId: key,
      removeOnComplete: 100,
      removeOnFail: 100,
    });
  } catch (err) {
    // BullMQ throws on invalid cron — surface as a per-recipe error
    // marker rather than blowing up the whole save.
    logger.warn({ err, recipeId: id, cron }, 'recipe cron register failed');
    throw err;
  }
}

recipesRouter.get('/', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const recipes = await Recipe.find({ userId }).sort({ createdAt: -1 }).lean();
  res.json({ recipes });
});

recipesRouter.get('/:id', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  if (!Types.ObjectId.isValid(req.params.id ?? '')) {
    res.status(400).json({ error: 'invalid_request', message: 'Invalid id' });
    return;
  }
  const recipe = await Recipe.findOne({ _id: req.params.id, userId }).lean();
  if (!recipe) {
    res.status(404).json({ error: 'not_found', message: 'Recipe not found' });
    return;
  }
  res.json(recipe);
});

recipesRouter.post('/', validateBody(RecipeCreateRequest), async (req, res, next) => {
  try {
    const userId = new Types.ObjectId(userIdOf(req));
    const body = req.body as typeof RecipeCreateRequest._type;
    const recipe = await Recipe.create({ userId, ...body });
    try {
      await syncCronSchedule({
        _id: recipe._id,
        userId,
        enabled: recipe.enabled,
        trigger: recipe.trigger as { kind: string; config?: { cron?: string; timezone?: string } },
      });
    } catch (err) {
      // Roll back on cron-register failure — better to refuse the
      // save than leave a recipe that the dispatcher won't actually
      // schedule.
      await Recipe.deleteOne({ _id: recipe._id });
      res.status(400).json({
        error: 'invalid_cron',
        message: (err as Error).message,
      });
      return;
    }
    res.status(201).json(recipe);
  } catch (err) {
    next(err);
  }
});

recipesRouter.patch('/:id', validateBody(RecipeUpdateRequest), async (req, res, next) => {
  try {
    const userId = new Types.ObjectId(userIdOf(req));
    if (!Types.ObjectId.isValid(req.params.id ?? '')) {
      res.status(400).json({ error: 'invalid_request', message: 'Invalid id' });
      return;
    }
    const body = req.body as typeof RecipeUpdateRequest._type;
    const updated = await Recipe.findOneAndUpdate(
      { _id: req.params.id, userId },
      { $set: body },
      { new: true },
    );
    if (!updated) {
      res.status(404).json({ error: 'not_found', message: 'Recipe not found' });
      return;
    }
    try {
      await syncCronSchedule({
        _id: updated._id,
        userId,
        enabled: updated.enabled,
        trigger: updated.trigger as { kind: string; config?: { cron?: string; timezone?: string } },
      });
    } catch (err) {
      res.status(400).json({
        error: 'invalid_cron',
        message: (err as Error).message,
      });
      return;
    }
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

recipesRouter.delete('/:id', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  if (!Types.ObjectId.isValid(req.params.id ?? '')) {
    res.status(400).json({ error: 'invalid_request', message: 'Invalid id' });
    return;
  }
  await recipesQueue.removeRepeatableByKey(cronJobKey(req.params.id)).catch(() => null);
  await Recipe.deleteOne({ _id: req.params.id, userId });
  await RecipeAudit.deleteMany({ recipeId: req.params.id, userId });
  res.json({ ok: true });
});

recipesRouter.get('/:id/audit', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  if (!Types.ObjectId.isValid(req.params.id ?? '')) {
    res.status(400).json({ error: 'invalid_request', message: 'Invalid id' });
    return;
  }
  const limit = Math.min(Number(req.query.limit ?? 50), 200);
  const rows = await RecipeAudit.find({ userId, recipeId: req.params.id })
    .sort({ firedAt: -1 })
    .limit(limit)
    .lean();
  res.json({ audit: rows });
});
