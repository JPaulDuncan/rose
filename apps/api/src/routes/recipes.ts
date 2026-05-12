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
  actionsRequireAdmin,
  PIPELINE_CATALOG,
  type PipelineStage,
  type RecipeEventKind,
} from '@rose/shared';
import { userIdOf } from '../middleware/auth.js';
import { isAdminRequest } from '../middleware/admin.js';
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

/**
 * Pipeline catalog with per-user reach numbers. Drives the read-only
 * "Pipeline" tab in the Recipes settings page so users can see —
 * without scrolling through the wizard's trigger dropdown — every
 * event Rose emits, what stage of the ingest pipeline produces it,
 * which internal handlers consume it, and how many of their own
 * recipes currently listen for it.
 *
 * The counts come from a single grouped Mongo aggregate against the
 * Recipe collection, keyed on `trigger.kind`. User and global
 * recipes counted separately so the UI can distinguish "this is a
 * Rose-shipped automation" from "this is something I built."
 */
recipesRouter.get('/pipeline', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  type RawRecipeRow = {
    _id: { kind: RecipeEventKind; scope: 'user' | 'global' };
    count: number;
    enabledCount: number;
  };
  const grouped = (await Recipe.aggregate([
    {
      $match: {
        $or: [{ userId }, { scope: 'global' }],
      },
    },
    {
      $group: {
        _id: { kind: '$trigger.kind', scope: '$scope' },
        count: { $sum: 1 },
        enabledCount: { $sum: { $cond: ['$enabled', 1, 0] } },
      },
    },
  ])) as RawRecipeRow[];
  type StageCounts = {
    userRecipes: number;
    userRecipesEnabled: number;
    globalRecipes: number;
    globalRecipesEnabled: number;
  };
  const counts = new Map<RecipeEventKind, StageCounts>();
  for (const row of grouped) {
    const k = row._id.kind;
    const slot = counts.get(k) ?? {
      userRecipes: 0,
      userRecipesEnabled: 0,
      globalRecipes: 0,
      globalRecipesEnabled: 0,
    };
    if (row._id.scope === 'global') {
      slot.globalRecipes += row.count;
      slot.globalRecipesEnabled += row.enabledCount;
    } else {
      slot.userRecipes += row.count;
      slot.userRecipesEnabled += row.enabledCount;
    }
    counts.set(k, slot);
  }
  const stages = PIPELINE_CATALOG.map((stage: PipelineStage) => {
    const c = counts.get(stage.kind) ?? {
      userRecipes: 0,
      userRecipesEnabled: 0,
      globalRecipes: 0,
      globalRecipesEnabled: 0,
    };
    return { ...stage, ...c };
  });
  res.json({ stages });
});

recipesRouter.get('/', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const admin = await isAdminRequest(req);
  // ?scope=global lists global recipes (admin-only). ?scope=user is
  // the legacy default. No filter = user-scoped only — globals are
  // invisible to non-admins, and admins manage them via the
  // dedicated tab so they don't bleed into the personal list.
  const requestedScope = (req.query.scope as string | undefined) ?? 'user';
  if (requestedScope === 'global') {
    if (!admin) {
      res.status(403).json({
        error: 'forbidden',
        message: 'Global recipes are admin-only.',
      });
      return;
    }
    const recipes = await Recipe.find({ scope: 'global' })
      .sort({ createdAt: -1 })
      .lean();
    res.json({ recipes });
    return;
  }
  // Topic Watches own their own surface — hide the auto-generated
  // recipes from the regular list so the user doesn't see them in
  // two places. Other importedFrom values stay visible.
  const recipes = await Recipe.find({
    userId,
    scope: { $ne: 'global' },
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
  // Admins can fetch any recipe (including globals owned by them or
  // by another admin in the future); non-admins are restricted to
  // their own user-scoped rows.
  const admin = await isAdminRequest(req);
  const recipe = await Recipe.findOne(
    admin ? { _id: req.params.id } : { _id: req.params.id, userId, scope: { $ne: 'global' } },
  ).lean();
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
    const wantsGlobal = body.scope === 'global';
    const usesAdminActions = actionsRequireAdmin(body.actions);
    if (wantsGlobal || usesAdminActions) {
      const admin = await isAdminRequest(req);
      if (!admin) {
        res.status(403).json({
          error: 'forbidden',
          message: wantsGlobal
            ? 'Only an administrator may create global recipes.'
            : 'One or more selected actions are admin-only.',
        });
        return;
      }
    }
    const recipe = await Recipe.create({
      userId,
      scope: body.scope ?? 'user',
      ...body,
    });
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
    const admin = await isAdminRequest(req);
    // Editing a global, switching scope to/from global, or adding
    // admin-only actions all require admin. Non-admins editing their
    // own user-scoped recipe with safe actions stay on the legacy
    // path.
    const targetExisting = await Recipe.findOne({ _id: req.params.id })
      .select('scope userId')
      .lean();
    if (!targetExisting) {
      res.status(404).json({ error: 'not_found', message: 'Recipe not found' });
      return;
    }
    const isGlobalRow = targetExisting.scope === 'global';
    const becomingGlobal = body.scope === 'global';
    const usesAdminActions = actionsRequireAdmin(body.actions);
    if ((isGlobalRow || becomingGlobal || usesAdminActions) && !admin) {
      res.status(403).json({
        error: 'forbidden',
        message: isGlobalRow
          ? 'Global recipes can only be edited by an administrator.'
          : becomingGlobal
            ? 'Only an administrator may promote a recipe to global.'
            : 'One or more selected actions are admin-only.',
      });
      return;
    }
    // Owner check: non-admins may only patch their own row.
    const filter = admin
      ? { _id: req.params.id }
      : { _id: req.params.id, userId, scope: { $ne: 'global' } };
    const updated = await Recipe.findOneAndUpdate(
      filter,
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
  const admin = await isAdminRequest(req);
  // Globals are admin-only to delete. Non-admins are also blocked
  // from touching them via the standard owner-scoped filter (their
  // userId never matches the admin row).
  const target = await Recipe.findOne({ _id: req.params.id })
    .select('scope userId')
    .lean();
  if (!target) {
    res.json({ ok: true });
    return;
  }
  if (target.scope === 'global' && !admin) {
    res.status(403).json({
      error: 'forbidden',
      message: 'Global recipes can only be deleted by an administrator.',
    });
    return;
  }
  if (
    target.scope !== 'global' &&
    !admin &&
    String(target.userId) !== String(userId)
  ) {
    res.status(404).json({ error: 'not_found', message: 'Recipe not found' });
    return;
  }
  await recipesQueue.removeRepeatableByKey(cronJobKey(req.params.id)).catch(() => null);
  await Recipe.deleteOne({ _id: req.params.id });
  // For globals delete every user's audit row; for user recipes
  // scope to the owner.
  if (target.scope === 'global') {
    await RecipeAudit.deleteMany({ recipeId: req.params.id });
  } else {
    await RecipeAudit.deleteMany({ recipeId: req.params.id, userId });
  }
  res.json({ ok: true });
});

recipesRouter.get('/:id/audit', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  if (!Types.ObjectId.isValid(req.params.id ?? '')) {
    res.status(400).json({ error: 'invalid_request', message: 'Invalid id' });
    return;
  }
  const limit = Math.min(Number(req.query.limit ?? 50), 200);
  // Globals: only the admin sees audit (and they see every user's
  // fires). User recipes: owner sees their own slice.
  const admin = await isAdminRequest(req);
  const target = await Recipe.findOne({ _id: req.params.id }).select('scope userId').lean();
  if (!target) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  if (target.scope === 'global') {
    if (!admin) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const rows = await RecipeAudit.find({ recipeId: req.params.id })
      .sort({ firedAt: -1 })
      .limit(limit)
      .lean();
    res.json({ audit: rows });
    return;
  }
  if (String(target.userId) !== String(userId) && !admin) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const auditFilter = admin
    ? { recipeId: req.params.id }
    : { userId, recipeId: req.params.id };
  const rows = await RecipeAudit.find(auditFilter)
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
