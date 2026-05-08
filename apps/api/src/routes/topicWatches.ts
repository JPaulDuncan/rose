import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { Recipe, Page } from '@rose/db';
import type { RecipeEvent } from '@rose/shared';
import { userIdOf } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { recipesQueue } from '../lib/queues.js';
import { logger } from '../lib/logger.js';

export const topicWatchesRouter: Router = Router();

/**
 * Topic Watches — friendly surface for "search topic X on schedule Y
 * and file a brief". Implemented on top of the existing Recipes
 * machinery: each watch is just a Recipe with a `time.scheduled`
 * trigger paired with a `briefing.generate` action. We tag those
 * recipes `importedFrom: 'topic-watch'` so the regular Recipes
 * settings list can filter them out and this surface owns the UX.
 *
 * Cron + timezone are accepted as separate fields — the API doesn't
 * make the user write cron syntax. The web client converts a
 * "Daily at 8 AM, America/New_York" form into the right cron string
 * before posting.
 */

function cronJobKey(recipeId: string): string {
  return `cron:${recipeId}`;
}

async function syncCronSchedule(opts: {
  recipeId: Types.ObjectId;
  userId: Types.ObjectId;
  enabled: boolean;
  cron: string | null;
  timezone: string;
}): Promise<void> {
  const key = cronJobKey(String(opts.recipeId));
  // Always drop the prior schedule first so a cron change replaces
  // cleanly without overlapping ticks.
  await recipesQueue.removeRepeatableByKey(key).catch(() => null);
  if (!opts.enabled || !opts.cron) return;
  const event: RecipeEvent = {
    kind: 'time.scheduled',
    userId: String(opts.userId),
    recipeId: String(opts.recipeId),
  };
  await recipesQueue.add('time.scheduled', event, {
    repeat: { pattern: opts.cron, tz: opts.timezone },
    jobId: key,
    removeOnComplete: 100,
    removeOnFail: 100,
  });
}

const TopicWatchUpsert = z.object({
  name: z.string().min(1).max(120),
  topic: z.string().min(1).max(200),
  /** Standard 5-field cron. The novice UI builds it from the
   *  preset chips ("Daily at 8 AM", "Hourly", "Weekly Mon"). */
  cron: z.string().min(5).max(80),
  /** IANA timezone — the cron is interpreted in this zone, so
   *  "0 8 * * *" with America/New_York means 8 AM Eastern. */
  timezone: z.string().min(1).max(64),
  enabled: z.boolean().optional(),
  /** Loose word-count hint passed to the LLM. */
  targetWords: z.number().int().min(80).max(2000).optional(),
  /** Optional override for the prompt template. Mustache vars:
   *  {{topic}}, {{date}}, {{snippets}}, {{targetWords}}. */
  customPrompt: z.string().max(4000).optional(),
  maxResultsPerSource: z.number().int().min(1).max(10).optional(),
  /** Force-enable Daydream's federated news / web-search adapters
   *  (Marginalia, DuckDuckGo, Brave, SearXNG) for this watch even
   *  when the user's global externalSearch toggle is off. Defaults
   *  true since topic watches are usually news-leaning. */
  includeNewsSearch: z.boolean().optional(),
  /** Web-integration Phase 2 follow-up — when true, every fire of
   *  this watch enqueues a topicResearch run after the snippet
   *  synthesis lands. Gated by the user's master webResearch
   *  toggle inside the worker; the API just passes the flag
   *  through. */
  deepResearchAfter: z.boolean().optional(),
});

type TopicWatchInput = z.infer<typeof TopicWatchUpsert>;

function recipeFromInput(input: TopicWatchInput, name?: string) {
  return {
    name: name ?? input.name,
    description: `Topic watch — ${input.topic}`,
    enabled: input.enabled ?? true,
    trigger: {
      kind: 'time.scheduled' as const,
      config: { cron: input.cron, timezone: input.timezone },
    },
    conditions: [],
    actions: [
      {
        kind: 'briefing.generate' as const,
        config: {
          topic: input.topic,
          targetWords: input.targetWords ?? 400,
          maxResultsPerSource: input.maxResultsPerSource ?? 5,
          includeNewsSearch: input.includeNewsSearch ?? true,
          deepResearchAfter: input.deepResearchAfter ?? false,
          ...(input.customPrompt ? { promptTemplate: input.customPrompt } : {}),
        },
      },
    ],
    cooldownSeconds: 0,
    fireLimitPerHour: 60,
  };
}

topicWatchesRouter.get('/', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const watches = await Recipe.find({
    userId,
    importedFrom: 'topic-watch',
  })
    .sort({ createdAt: -1 })
    .lean();
  // Each topic watch maps to one Page (upsert by recipeId on every
  // run). Pull the slugs in a single $in query so the client can
  // render an "Open" link per watch without N round-trips.
  const recipeIds = watches.map((r) => r._id);
  const pages = recipeIds.length
    ? await Page.find({ userId, recipeId: { $in: recipeIds } })
        .select('slug recipeId')
        .lean()
    : [];
  const slugByRecipeId = new Map<string, string>();
  for (const p of pages) {
    if (p.recipeId) slugByRecipeId.set(String(p.recipeId), p.slug);
  }
  res.json({
    watches: watches.map((r) => {
      const action = (r.actions ?? [])[0] as
        | {
            kind: string;
            config: {
              topic?: string;
              targetWords?: number;
              promptTemplate?: string;
              maxResultsPerSource?: number;
              includeNewsSearch?: boolean;
              deepResearchAfter?: boolean;
            };
          }
        | undefined;
      const trigger = r.trigger as {
        kind: string;
        config?: { cron?: string; timezone?: string };
      };
      return {
        _id: String(r._id),
        name: r.name,
        topic: action?.config?.topic ?? '',
        cron: trigger.config?.cron ?? '',
        timezone: trigger.config?.timezone ?? 'UTC',
        targetWords: action?.config?.targetWords ?? 400,
        customPrompt: action?.config?.promptTemplate ?? null,
        maxResultsPerSource: action?.config?.maxResultsPerSource ?? 5,
        includeNewsSearch:
          (action?.config as { includeNewsSearch?: boolean } | undefined)
            ?.includeNewsSearch ?? true,
        deepResearchAfter:
          (action?.config as { deepResearchAfter?: boolean } | undefined)
            ?.deepResearchAfter ?? false,
        pageSlug: slugByRecipeId.get(String(r._id)) ?? null,
        enabled: r.enabled,
        fireCount: r.fireCount ?? 0,
        errorCount: r.errorCount ?? 0,
        lastFiredAt: r.lastFiredAt ?? null,
        lastErrorAt: r.lastErrorAt ?? null,
        lastErrorMessage: r.lastErrorMessage ?? null,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      };
    }),
  });
});

topicWatchesRouter.post(
  '/',
  validateBody(TopicWatchUpsert),
  async (req, res, next) => {
    try {
      const userId = new Types.ObjectId(userIdOf(req));
      const body = req.body as TopicWatchInput;
      const recipe = await Recipe.create({
        userId,
        ...recipeFromInput(body),
        importedFrom: 'topic-watch',
      });
      try {
        await syncCronSchedule({
          recipeId: recipe._id,
          userId,
          enabled: !!recipe.enabled,
          cron: body.cron,
          timezone: body.timezone,
        });
      } catch (err) {
        logger.warn({ err, recipeId: String(recipe._id) }, 'topic-watch cron register failed');
        await Recipe.deleteOne({ _id: recipe._id });
        res.status(400).json({
          error: 'invalid_request',
          message: `Couldn't schedule the cron — ${(err as Error).message}`,
        });
        return;
      }
      res.json({ _id: String(recipe._id) });
    } catch (err) {
      next(err);
    }
  },
);

topicWatchesRouter.patch(
  '/:id',
  validateBody(TopicWatchUpsert.partial()),
  async (req, res, next) => {
    try {
      const userId = new Types.ObjectId(userIdOf(req));
      if (!Types.ObjectId.isValid(req.params.id ?? '')) {
        res.status(400).json({ error: 'invalid_request' });
        return;
      }
      const existing = await Recipe.findOne({
        _id: req.params.id,
        userId,
        importedFrom: 'topic-watch',
      });
      if (!existing) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      const partial = req.body as Partial<TopicWatchInput>;
      // Re-build from the merged shape so the embedded action config
      // and trigger config stay in lockstep.
      const action = (existing.actions ?? [])[0] as
        | { kind: string; config: Record<string, unknown> }
        | undefined;
      const trigger = existing.trigger as {
        kind: string;
        config?: { cron?: string; timezone?: string };
      };
      const merged: TopicWatchInput = {
        name: partial.name ?? existing.name,
        topic:
          partial.topic ??
          ((action?.config as { topic?: string } | undefined)?.topic ?? ''),
        cron: partial.cron ?? trigger.config?.cron ?? '',
        timezone: partial.timezone ?? trigger.config?.timezone ?? 'UTC',
        enabled: partial.enabled ?? existing.enabled,
        targetWords:
          partial.targetWords ??
          ((action?.config as { targetWords?: number } | undefined)
            ?.targetWords ?? 400),
        customPrompt:
          partial.customPrompt ??
          ((action?.config as { promptTemplate?: string } | undefined)
            ?.promptTemplate ?? undefined),
        maxResultsPerSource:
          partial.maxResultsPerSource ??
          ((action?.config as { maxResultsPerSource?: number } | undefined)
            ?.maxResultsPerSource ?? 5),
        includeNewsSearch:
          partial.includeNewsSearch ??
          ((action?.config as { includeNewsSearch?: boolean } | undefined)
            ?.includeNewsSearch ?? true),
      };
      const next = recipeFromInput(merged);
      existing.set(next);
      await existing.save();
      try {
        await syncCronSchedule({
          recipeId: existing._id,
          userId,
          enabled: !!existing.enabled,
          cron: merged.cron,
          timezone: merged.timezone,
        });
      } catch (err) {
        logger.warn(
          { err, recipeId: String(existing._id) },
          'topic-watch cron re-register failed',
        );
      }
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

topicWatchesRouter.delete('/:id', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  if (!Types.ObjectId.isValid(req.params.id ?? '')) {
    res.status(400).json({ error: 'invalid_request' });
    return;
  }
  await recipesQueue
    .removeRepeatableByKey(cronJobKey(req.params.id ?? ''))
    .catch(() => null);
  await Recipe.deleteOne({
    _id: req.params.id,
    userId,
    importedFrom: 'topic-watch',
  });
  res.json({ ok: true });
});

/**
 * Fire the watch immediately, ignoring its schedule. Useful for
 * testing the topic and prompt before committing to a daily cadence.
 */
topicWatchesRouter.post('/:id/run-now', async (req, res, next) => {
  try {
    const userId = new Types.ObjectId(userIdOf(req));
    if (!Types.ObjectId.isValid(req.params.id ?? '')) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    const recipe = await Recipe.findOne({
      _id: req.params.id,
      userId,
      importedFrom: 'topic-watch',
    }).lean();
    if (!recipe) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const event: RecipeEvent = {
      kind: 'time.scheduled',
      userId: String(userId),
      recipeId: String(recipe._id),
    };
    await recipesQueue.add('time.scheduled', event, {
      attempts: 1,
      removeOnComplete: 50,
      removeOnFail: 50,
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
