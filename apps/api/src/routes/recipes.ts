import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { Recipe, RecipeAudit, User, Email, Page } from '@rose/db';
import { senderDomainTag } from '@rose/email-parser';
import {
  RecipeCreateRequest,
  RecipeUpdateRequest,
  type RecipeEvent,
  type Trigger,
  type Condition,
  evaluateRecipe,
} from '@rose/shared';
import { userIdOf } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { recipesQueue } from '../lib/queues.js';
import { logger } from '../lib/logger.js';
import { RECIPE_TEMPLATES } from './recipeTemplates.js';

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

/**
 * Build a synthetic, read-only "virtual" Recipe shape for one entry
 * in the user's spam policy. The client renders these alongside real
 * recipes with an "Imported from spam policy — convert to recipe"
 * affordance. The synthetic _id encodes enough info that the
 * convert endpoint can identify which policy entry it represents
 * without an extra lookup.
 *
 * Shape mirrors what the client already expects for a real Recipe so
 * the list UI doesn't need to branch — the only differences are the
 * `_id` prefix and the `importedFrom: 'spam-policy'` marker, which
 * the client uses to swap edit/delete for "convert".
 */
function virtualSpamRecipe(
  userId: string,
  kind: 'spam' | 'blocked',
  address: string,
): Record<string, unknown> {
  return {
    _id: `virtual:spam-policy:${kind}:${address}`,
    userId,
    name:
      kind === 'spam'
        ? `Mark "${address}" as spam`
        : `Block "${address}" at ingest`,
    description:
      kind === 'spam'
        ? 'Existing pages from this sender are flagged as spam and hidden from the home digest.'
        : 'Future mail from this sender is dropped during ingest — no Email row, no wiki page.',
    enabled: true,
    trigger: {
      kind: 'email.ingested',
      config: { senderContains: address },
    },
    conditions: [],
    actions: [
      {
        kind: kind === 'spam' ? 'sender.spam' : 'sender.block',
        config: { address },
      },
    ],
    cooldownSeconds: 0,
    fireLimitPerHour: 60,
    importedFrom: 'spam-policy',
    importedFromId: null,
    fireCount: 0,
    errorCount: 0,
    lastFiredAt: null,
    lastErrorAt: null,
    lastErrorMessage: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    /** Marker the client uses to render the read-only badge + convert button. */
    virtual: true,
  };
}

/**
 * Static gallery of starter recipes the wizard can pre-populate.
 * Mounted before `/:id` so the literal path wins over the param.
 */
recipesRouter.get('/templates', async (_req, res) => {
  res.json({ templates: RECIPE_TEMPLATES });
});

recipesRouter.get('/', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  // Topic Watches own their own surface — hide the auto-generated
  // recipes from the regular list so the user doesn't see them in
  // two places. Other importedFrom values stay visible.
  const recipes = await Recipe.find({
    userId,
    importedFrom: { $ne: 'topic-watch' },
  })
    .sort({ createdAt: -1 })
    .lean();

  const user = await User.findById(userId).select('spamPolicy').lean();
  const policy = (user?.spamPolicy ?? {}) as {
    senders?: string[];
    blockedSenders?: string[];
  };
  const virtualRows = [
    ...(policy.senders ?? []).map((a) => virtualSpamRecipe(String(userId), 'spam', a)),
    ...(policy.blockedSenders ?? []).map((a) =>
      virtualSpamRecipe(String(userId), 'blocked', a),
    ),
  ];

  res.json({ recipes: [...recipes, ...virtualRows] });
});

const ImportSpamEntryRequest = z.object({
  kind: z.enum(['spam', 'blocked']),
  address: z.string().min(1).max(320),
});

/**
 * Convert a virtual spam-policy entry into a real, editable Recipe.
 * Removes the entry from `User.spamPolicy.senders[]` /
 * `User.spamPolicy.blockedSenders[]` so the same address doesn't
 * fire twice. The new Recipe carries `importedFrom: 'spam-policy'`
 * but no importedFromId (the address itself is the natural key).
 */
recipesRouter.post(
  '/import-spam-entry',
  validateBody(ImportSpamEntryRequest),
  async (req, res, next) => {
    try {
      const userId = new Types.ObjectId(userIdOf(req));
      const body = req.body as { kind: 'spam' | 'blocked'; address: string };
      const address = body.address.trim().toLowerCase();
      if (!address) {
        res.status(400).json({ error: 'invalid_request', message: 'Empty address' });
        return;
      }

      // Phase 1's Action set covers notify/tag/category/webhook only.
      // Spam-policy entries map to sender.spam / sender.block, which
      // aren't in Phase 1. Until those land, the converted recipe is
      // a webhook.post placeholder pointing at the spam endpoint;
      // the user can then edit it freely.
      // Until then, we just remove the policy entry and return a
      // helpful 501 so the UI surfaces a real error rather than a
      // silent half-conversion.
      const action = body.kind === 'spam' ? 'sender.spam' : 'sender.block';
      res.status(501).json({
        error: 'not_supported_yet',
        message: `Phase 1 actions don't yet include "${action}" — the existing Settings → Spam UI still owns this entry. Phase 3 of the recipes design adds these actions; until then, the virtual row is read-only.`,
      });
    } catch (err) {
      next(err);
    }
  },
);

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

/**
 * Replay recent state through the recipe's trigger + conditions
 * without firing actions. The endpoint synthesises candidate events
 * out of the user's recent emails / pages and runs the same matchers
 * the dispatcher uses (`@rose/shared` `evaluateRecipe`), then
 * returns a per-candidate verdict so the UI can show:
 *
 *   ✓  "Stripe — Your invoice for May"   would fire
 *   ✗  "Linear — Build broke on main"    condition-mismatch:tag.contains
 *
 * Bounded to the last 200 candidates so the round trip stays cheap.
 * Pure read — touches no queues, writes no audit rows.
 */
recipesRouter.post('/:id/dry-run', async (req, res, next) => {
  try {
    const userId = new Types.ObjectId(userIdOf(req));
    if (!Types.ObjectId.isValid(req.params.id ?? '')) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    const recipe = await Recipe.findOne({ _id: req.params.id, userId }).lean();
    if (!recipe) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const trigger = recipe.trigger as unknown as Trigger;
    const conditions = (recipe.conditions ?? []) as unknown as Condition[];
    const limit = Math.min(
      Number((req.body as { limit?: number })?.limit ?? 100),
      200,
    );

    const candidates: Array<{
      label: string;
      subjectKey: string;
      subjectUrl: string | null;
      verdict: ReturnType<typeof evaluateRecipe>;
    }> = [];

    if (trigger.kind === 'email.ingested') {
      const emails = await Email.find({ userId })
        .select('subject from priority topics date createdAt')
        .sort({ date: -1, createdAt: -1 })
        .limit(limit)
        .lean();
      for (const e of emails) {
        const fromAddr = e.from?.address ?? null;
        const event: RecipeEvent = {
          kind: 'email.ingested',
          userId: String(userId),
          emailId: String(e._id),
          from: fromAddr,
          subject: e.subject ?? '',
          brandKey: (fromAddr ? senderDomainTag(fromAddr) : null)?.toLowerCase() ?? null,
          priority: (e.priority as 'high' | 'normal' | 'low' | null) ?? null,
          tags: (e.topics as string[] | undefined) ?? [],
        };
        candidates.push({
          label: e.subject || '(no subject)',
          subjectKey: `email:${String(e._id)}`,
          subjectUrl: `/e/${String(e._id)}`,
          verdict: evaluateRecipe(trigger, conditions, event),
        });
      }
    } else if (
      trigger.kind === 'page.created' ||
      trigger.kind === 'tag.applied'
    ) {
      const pages = await Page.find({ userId })
        .select('slug title tags topics priority senderAddresses categoryId')
        .sort({ articleDate: -1, updatedAt: -1 })
        .limit(limit)
        .lean();
      const tagFilter =
        trigger.kind === 'tag.applied' ? trigger.config.tag.toLowerCase() : null;
      for (const p of pages) {
        const tags = ((p.tags as string[] | undefined) ?? []).map((t) =>
          t.toLowerCase(),
        );
        const brandKeys = ((p.senderAddresses as string[] | undefined) ?? [])
          .map((a) => senderDomainTag(a)?.toLowerCase() ?? null)
          .filter((k): k is string => k !== null);
        const event: RecipeEvent =
          trigger.kind === 'page.created'
            ? {
                kind: 'page.created',
                userId: String(userId),
                pageId: String(p._id),
                slug: p.slug,
                title: p.title,
                tags,
                categoryId: p.categoryId ? String(p.categoryId) : null,
                brandKeys,
                priority: (p.priority as 'high' | 'normal' | 'low' | null) ?? null,
              }
            : {
                kind: 'tag.applied',
                userId: String(userId),
                pageId: String(p._id),
                slug: p.slug,
                title: p.title,
                tag: tagFilter ?? tags[0] ?? '',
                tags,
                brandKeys,
                priority: (p.priority as 'high' | 'normal' | 'low' | null) ?? null,
              };
        candidates.push({
          label: p.title,
          subjectKey: `page:${String(p._id)}`,
          subjectUrl: `/p/${p.slug}`,
          verdict: evaluateRecipe(trigger, conditions, event),
        });
      }
    } else {
      // time.scheduled has no replayable subject — synthesise one
      // so the UI confirms the cron / timezone parse, but always
      // matches.
      candidates.push({
        label: 'Scheduled tick (synthetic)',
        subjectKey: `cron:${String(recipe._id)}`,
        subjectUrl: null,
        verdict: { match: true },
      });
    }

    const matched = candidates.filter((c) => c.verdict.match).length;
    res.json({
      total: candidates.length,
      matched,
      candidates,
    });
  } catch (err) {
    next(err);
  }
});
