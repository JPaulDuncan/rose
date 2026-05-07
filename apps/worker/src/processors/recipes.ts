import { Worker, type Job } from 'bullmq';
import { Types } from 'mongoose';
import {
  Recipe,
  RecipeAudit,
  Page,
  Email,
  User,
  Category,
  normalizeCategoryName,
  type RecipeDoc,
} from '@rose/db';
import {
  type RecipeEvent,
  type Trigger,
  type Condition,
  type Action,
} from '@rose/shared';
import { assertSafeHttpUrl } from '@rose/llm';
import { redis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { pushToUser } from './pushNotify.js';
import { deleteOnSource as deleteEmailOnSource } from '../lib/sourceMailDelete.js';
import { resolveProviderForUser } from '../lib/providers.js';

const QUEUE = 'rose.recipes';
const WEBHOOK_TIMEOUT_MS = 15_000;

/* ─── Trigger / condition matchers ────────────────────────────────── */

/**
 * Decide whether an event is a candidate for this recipe. Trigger
 * filter is inline-matched here so the dispatcher never even
 * evaluates conditions for irrelevant recipes.
 */
function triggerMatches(trigger: Trigger, event: RecipeEvent): boolean {
  if (trigger.kind !== event.kind) return false;
  if (trigger.kind === 'email.ingested' && event.kind === 'email.ingested') {
    const cfg = trigger.config;
    if (
      cfg.senderContains &&
      !(event.from ?? '').toLowerCase().includes(cfg.senderContains.toLowerCase())
    ) {
      return false;
    }
    if (cfg.brandKey && event.brandKey !== cfg.brandKey.toLowerCase()) {
      return false;
    }
    if (
      cfg.subjectContains &&
      !event.subject.toLowerCase().includes(cfg.subjectContains.toLowerCase())
    ) {
      return false;
    }
    return true;
  }
  if (trigger.kind === 'tag.applied' && event.kind === 'tag.applied') {
    return trigger.config.tag.toLowerCase() === event.tag.toLowerCase();
  }
  return true;
}

function conditionMatches(condition: Condition, event: RecipeEvent): boolean {
  switch (condition.kind) {
    case 'tag.contains': {
      const target = condition.config.tag.toLowerCase();
      const tags =
        'tags' in event ? event.tags.map((t) => t.toLowerCase()) : [];
      return tags.includes(target);
    }
    case 'sender.brand': {
      const want = condition.config.brandKey.toLowerCase();
      const has =
        event.kind === 'email.ingested'
          ? (event.brandKey ?? '').toLowerCase()
          : event.kind === 'page.created' || event.kind === 'tag.applied'
            ? event.brandKeys.map((k) => k.toLowerCase()).join(',')
            : '';
      return has.split(',').includes(want);
    }
    case 'priority.is': {
      // Works on every event that carries priority — emails when they
      // arrive, pages when they're created, and the per-tag fan-out.
      if (
        event.kind === 'email.ingested' ||
        event.kind === 'page.created' ||
        event.kind === 'tag.applied'
      ) {
        return event.priority === condition.config.priority;
      }
      return false;
    }
    case 'subject.matches': {
      if (event.kind !== 'email.ingested') return false;
      try {
        const re = new RegExp(condition.config.pattern, 'i');
        return re.test(event.subject);
      } catch {
        return false;
      }
    }
    default:
      return false;
  }
}

function subjectKeyOf(event: RecipeEvent): string | null {
  if (event.kind === 'email.ingested') return `email:${event.emailId}`;
  if (event.kind === 'page.created' || event.kind === 'tag.applied')
    return `page:${event.pageId}`;
  if (event.kind === 'time.scheduled') return `cron:${event.recipeId}`;
  return null;
}

/* ─── Cooldown + rate-limit (Redis-backed) ────────────────────────── */

/**
 * Acquire the cooldown lock for (recipe, subject). Returns true if
 * the recipe may fire. Uses SET NX EX so concurrent dispatchers
 * race-safely.
 */
async function acquireCooldown(
  recipeId: string,
  subjectKey: string | null,
  cooldownSeconds: number,
): Promise<boolean> {
  if (cooldownSeconds <= 0 || !subjectKey) return true;
  const key = `recipe-cd:${recipeId}:${subjectKey}`;
  // ioredis SET NX EX returns 'OK' on success, null if the key
  // exists. We bail out only when the SET was rejected.
  const r = await redis.set(key, '1', 'EX', cooldownSeconds, 'NX');
  return r === 'OK';
}

/** Returns true if the recipe is under its hourly fire limit. */
async function checkRateLimit(
  recipeId: string,
  fireLimitPerHour: number,
): Promise<boolean> {
  const hourBucket = Math.floor(Date.now() / 3_600_000);
  const key = `recipe-rate:${recipeId}:${hourBucket}`;
  // INCR returns the new value; first call creates the key.
  const count = await redis.incr(key);
  if (count === 1) {
    // First fire this hour — set TTL so the key auto-prunes.
    await redis.expire(key, 3_600);
  }
  return count <= fireLimitPerHour;
}

/* ─── Action runners ──────────────────────────────────────────────── */

type ActionResult = {
  ok: boolean;
  error?: string;
  durationMs: number;
  /** Free-form action-specific evidence (LLM reply preview, deleteOnSource
   *  reason, etc.) — surfaced in RecipeAudit so the user can debug. */
  detail?: string;
};

async function runNotifyPush(
  userId: Types.ObjectId,
  config: { message?: string; title?: string },
  event: RecipeEvent,
): Promise<void> {
  const { title, body, url } = derivePushPayload(config, event);
  await pushToUser(userId, { title, body, url });
}

function derivePushPayload(
  cfg: { message?: string; title?: string },
  event: RecipeEvent,
): { title: string; body: string; url?: string } {
  if (event.kind === 'email.ingested') {
    return {
      title: cfg.title ?? 'New email',
      body: cfg.message ?? `${event.from ?? 'unknown'} — ${event.subject}`,
      url: `/e/${event.emailId}`,
    };
  }
  if (event.kind === 'page.created' || event.kind === 'tag.applied') {
    return {
      title: cfg.title ?? (event.kind === 'tag.applied' ? `#${event.tag}` : 'New page'),
      body: cfg.message ?? event.title,
      url: `/p/${event.slug}`,
    };
  }
  return {
    title: cfg.title ?? 'Recipe fired',
    body: cfg.message ?? 'Scheduled trigger fired',
  };
}

async function runTagAdd(
  userId: Types.ObjectId,
  config: { tag: string },
  event: RecipeEvent,
): Promise<void> {
  if (event.kind !== 'page.created' && event.kind !== 'tag.applied') {
    throw new Error('tag.add requires a page subject');
  }
  const tag = config.tag.trim().toLowerCase();
  if (!tag) throw new Error('tag.add: empty tag');
  await Page.updateOne(
    { _id: new Types.ObjectId(event.pageId), userId },
    { $addToSet: { tags: tag } },
  );
}

async function runCategorySet(
  userId: Types.ObjectId,
  config: { name: string },
  event: RecipeEvent,
): Promise<void> {
  if (event.kind !== 'page.created' && event.kind !== 'tag.applied') {
    throw new Error('category.set requires a page subject');
  }
  const name = config.name.trim();
  if (!name) throw new Error('category.set: empty name');
  const normalized = normalizeCategoryName(name);
  const cat =
    (await Category.findOne({ userId, normalizedName: normalized })) ??
    (await Category.findOne({ userId, name })) ??
    (await Category.create({ userId, name, normalizedName: normalized }));
  await Page.updateOne(
    { _id: new Types.ObjectId(event.pageId), userId },
    { $set: { categoryId: cat._id } },
  );
}

/* ─── Email-shaped actions ───────────────────────────────────────── */

function requireEmailEvent(
  event: RecipeEvent,
  actionKind: string,
): event is Extract<RecipeEvent, { kind: 'email.ingested' }> {
  if (event.kind !== 'email.ingested') {
    throw new Error(`${actionKind} requires an email subject`);
  }
  return true;
}

async function runEmailDelete(
  userId: Types.ObjectId,
  event: RecipeEvent,
): Promise<void> {
  if (!requireEmailEvent(event, 'email.delete')) return;
  await Email.deleteOne({ _id: new Types.ObjectId(event.emailId), userId });
}

async function runEmailDeleteOnSource(
  userId: Types.ObjectId,
  config: { deleteLocal?: boolean },
  event: RecipeEvent,
): Promise<{ deletedOnSource: boolean; reason?: string }> {
  if (!requireEmailEvent(event, 'email.deleteOnSource')) {
    return { deletedOnSource: false };
  }
  const email = await Email.findOne({
    _id: new Types.ObjectId(event.emailId),
    userId,
  })
    .select('messageId sourceId')
    .lean();
  if (!email) {
    return { deletedOnSource: false, reason: 'email already gone' };
  }
  const result = await deleteEmailOnSource(email.sourceId, email.messageId ?? null);
  if (config.deleteLocal !== false) {
    await Email.deleteOne({ _id: new Types.ObjectId(event.emailId), userId });
  }
  return result;
}

async function runEmailMarkSpam(
  userId: Types.ObjectId,
  event: RecipeEvent,
): Promise<void> {
  if (!requireEmailEvent(event, 'email.markSpam')) return;
  const address = (event.from ?? '').toLowerCase().trim();
  if (!address) throw new Error('email.markSpam: email has no sender address');
  await User.updateOne(
    { _id: userId },
    { $addToSet: { 'spamPolicy.senders': address } },
  );
  await Page.updateMany(
    { userId, senderAddresses: address },
    { $set: { 'flags.userMarkedSpam': true } },
  );
}

async function runEmailArchive(
  userId: Types.ObjectId,
  event: RecipeEvent,
): Promise<void> {
  if (!requireEmailEvent(event, 'email.archive')) return;
  await Email.updateOne(
    { _id: new Types.ObjectId(event.emailId), userId },
    { $set: { archivedAt: new Date() } },
  );
}

async function runEmailBlock(
  userId: Types.ObjectId,
  config: { removeExisting?: boolean },
  event: RecipeEvent,
): Promise<void> {
  if (!requireEmailEvent(event, 'email.block')) return;
  const address = (event.from ?? '').toLowerCase().trim();
  if (!address) throw new Error('email.block: email has no sender address');
  await User.updateOne(
    { _id: userId },
    {
      $addToSet: { 'spamPolicy.blockedSenders': address },
      $pull: { 'spamPolicy.senders': address },
    },
  );
  if (config.removeExisting !== false) {
    // Pages where this sender is the sole contributor get deleted;
    // pages with other contributors lose just this sender's rows.
    const affectedPages = await Page.find({ userId, senderAddresses: address })
      .select('_id senderAddresses')
      .lean();
    for (const page of affectedPages) {
      const others = (page.senderAddresses ?? []).filter((a: string) => a !== address);
      if (others.length === 0) {
        await Page.deleteOne({ _id: page._id, userId });
      } else {
        await Page.updateOne(
          { _id: page._id, userId },
          { $pull: { senderAddresses: address } },
        );
      }
    }
    await Email.deleteMany({ userId, 'from.address': address });
  }
}

/* ─── LLM action ──────────────────────────────────────────────────── */

function renderTemplate(
  template: string,
  vars: Record<string, string | undefined>,
): string {
  return template.replace(/{{\s*([\w.]+)\s*}}/g, (_, key: string) =>
    (vars[key] ?? '').toString(),
  );
}

async function buildLlmContext(
  userId: Types.ObjectId,
  event: RecipeEvent,
): Promise<Record<string, string>> {
  if (event.kind === 'email.ingested') {
    const email = await Email.findOne({
      _id: new Types.ObjectId(event.emailId),
      userId,
    })
      .select('from subject text')
      .lean();
    return {
      from: email?.from?.address ?? event.from ?? '',
      subject: email?.subject ?? event.subject,
      // Cap the body so prompts stay within model limits; long emails
      // get truncated rather than failing the recipe outright.
      body: (email?.text ?? '').slice(0, 8000),
      tags: event.tags.join(', '),
    };
  }
  if (event.kind === 'page.created' || event.kind === 'tag.applied') {
    const page = await Page.findOne({
      _id: new Types.ObjectId(event.pageId),
      userId,
    })
      .select('title summary contentMd tags')
      .lean();
    return {
      title: page?.title ?? event.title,
      summary: page?.summary ?? '',
      body: (page?.contentMd ?? '').slice(0, 8000),
      tag: 'tag' in event ? event.tag : '',
      tags: event.tags.join(', '),
    };
  }
  return {};
}

type LlmRunResult = { reply: string };

async function runLlmAction(
  userId: Types.ObjectId,
  config: {
    prompt: string;
    system?: string;
    output: 'push' | 'tag' | 'audit-only';
    pushTitle?: string;
    temperature?: number;
    maxTokens?: number;
  },
  event: RecipeEvent,
  recipeName: string,
): Promise<LlmRunResult> {
  const ctx = await buildLlmContext(userId, event);
  const prompt = renderTemplate(config.prompt, ctx);
  const system = config.system
    ? renderTemplate(config.system, ctx)
    : 'You are a helpful assistant running inside a recipe automation. Keep replies short and useful.';

  const resolved = await resolveProviderForUser(userId, 'generation');
  const reply = (
    await resolved.provider.generate({
      model: resolved.model,
      prompt,
      system,
      temperature: config.temperature ?? 0.4,
      maxTokens: config.maxTokens ?? 400,
    })
  ).trim();

  if (!reply) return { reply: '' };

  if (config.output === 'push') {
    await pushToUser(userId, {
      title: config.pushTitle ?? recipeName,
      body: reply.slice(0, 280),
      url:
        event.kind === 'email.ingested'
          ? `/e/${event.emailId}`
          : event.kind === 'page.created' || event.kind === 'tag.applied'
            ? `/p/${event.slug}`
            : undefined,
    });
  } else if (config.output === 'tag') {
    if (event.kind !== 'page.created' && event.kind !== 'tag.applied') {
      throw new Error('llm.run output=tag requires a page subject');
    }
    const tags = reply
      .split(/[,\n]/)
      .map((t) => t.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, ''))
      .filter((t) => t && t.length <= 80)
      .slice(0, 8);
    if (tags.length > 0) {
      await Page.updateOne(
        { _id: new Types.ObjectId(event.pageId), userId },
        { $addToSet: { tags: { $each: tags } } },
      );
    }
  }
  return { reply };
}

async function runWebhookPost(
  config: { url: string; headers?: Record<string, string> },
  event: RecipeEvent,
): Promise<void> {
  // SSRF guard — reuse the shared helper used by safeFetch / Library /
  // url-save so private IPs and metadata endpoints are blocked.
  await assertSafeHttpUrl(config.url);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    const res = await fetch(config.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'Rose-Recipes/1.0 (+https://rose.local)',
        ...(config.headers ?? {}),
      },
      body: JSON.stringify({ event }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`webhook responded ${res.status}: ${text.slice(0, 200)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

async function runAction(
  userId: Types.ObjectId,
  action: Action,
  event: RecipeEvent,
  recipeName: string,
): Promise<ActionResult> {
  const start = Date.now();
  try {
    let detail: string | undefined;
    switch (action.kind) {
      case 'notify.push':
        await runNotifyPush(userId, action.config, event);
        break;
      case 'tag.add':
        await runTagAdd(userId, action.config, event);
        break;
      case 'category.set':
        await runCategorySet(userId, action.config, event);
        break;
      case 'webhook.post':
        await runWebhookPost(action.config, event);
        break;
      case 'email.delete':
        await runEmailDelete(userId, event);
        break;
      case 'email.deleteOnSource': {
        const r = await runEmailDeleteOnSource(userId, action.config, event);
        detail = r.deletedOnSource ? 'deleted on source' : `local-only: ${r.reason ?? 'unknown'}`;
        break;
      }
      case 'email.markSpam':
        await runEmailMarkSpam(userId, event);
        break;
      case 'email.archive':
        await runEmailArchive(userId, event);
        break;
      case 'email.block':
        await runEmailBlock(userId, action.config, event);
        break;
      case 'llm.run': {
        const r = await runLlmAction(userId, action.config, event, recipeName);
        detail = r.reply.slice(0, 400);
        break;
      }
    }
    return { ok: true, durationMs: Date.now() - start, detail };
  } catch (err) {
    return {
      ok: false,
      error: (err as Error).message,
      durationMs: Date.now() - start,
    };
  }
}

/* ─── Dispatcher ──────────────────────────────────────────────────── */

async function processEvent(event: RecipeEvent): Promise<void> {
  const userObjId = new Types.ObjectId(event.userId);
  // Recipes are loaded fresh per event so a save during dispatch is
  // visible immediately. Phase 1 has small per-user recipe counts;
  // a user-scoped in-memory cache is a Phase 5 polish.
  const recipes = await Recipe.find({
    userId: userObjId,
    enabled: true,
    'trigger.kind': event.kind,
  }).lean();
  if (recipes.length === 0) return;

  for (const recipe of recipes as unknown as RecipeDoc[]) {
    const trigger = recipe.trigger as unknown as Trigger;
    if (!triggerMatches(trigger, event)) continue;

    const conditions = (recipe.conditions ?? []) as unknown as Condition[];
    if (!conditions.every((c) => conditionMatches(c, event))) {
      await RecipeAudit.create({
        userId: userObjId,
        recipeId: recipe._id,
        subjectKey: subjectKeyOf(event),
        fired: false,
        reason: 'condition-mismatch',
        evidence: trimEvidence(event),
      });
      continue;
    }

    const subjectKey = subjectKeyOf(event);
    const allowed = await acquireCooldown(
      String(recipe._id),
      subjectKey,
      recipe.cooldownSeconds ?? 0,
    );
    if (!allowed) {
      await RecipeAudit.create({
        userId: userObjId,
        recipeId: recipe._id,
        subjectKey,
        fired: false,
        reason: 'cooldown',
        evidence: trimEvidence(event),
      });
      continue;
    }

    const underLimit = await checkRateLimit(
      String(recipe._id),
      recipe.fireLimitPerHour ?? 60,
    );
    if (!underLimit) {
      await RecipeAudit.create({
        userId: userObjId,
        recipeId: recipe._id,
        subjectKey,
        fired: false,
        reason: 'rate-limited',
        evidence: trimEvidence(event),
      });
      continue;
    }

    const actions = (recipe.actions ?? []) as unknown as Action[];
    const results = [] as {
      actionKind: string;
      ok: boolean;
      error?: string;
      durationMs: number;
      detail?: string;
    }[];
    for (const action of actions) {
      const r = await runAction(userObjId, action, event, recipe.name);
      results.push({
        actionKind: action.kind,
        ok: r.ok,
        error: r.error,
        durationMs: r.durationMs,
        detail: r.detail,
      });
    }
    const anyError = results.some((r) => !r.ok);

    await Recipe.updateOne(
      { _id: recipe._id },
      {
        $set: {
          lastFiredAt: new Date(),
          ...(anyError
            ? {
                lastErrorAt: new Date(),
                lastErrorMessage: results.find((r) => !r.ok)?.error ?? null,
              }
            : {}),
        },
        $inc: {
          fireCount: 1,
          ...(anyError ? { errorCount: 1 } : {}),
        },
      },
    );
    await RecipeAudit.create({
      userId: userObjId,
      recipeId: recipe._id,
      subjectKey,
      fired: true,
      reason: anyError ? 'partial-error' : null,
      results,
      evidence: trimEvidence(event),
    });
  }
}

/** Cap the audit evidence at ~2 KB so the collection doesn't grow
 *  unbounded with full email bodies. */
function trimEvidence(event: RecipeEvent): Record<string, unknown> {
  const json = JSON.stringify(event);
  if (json.length <= 2048) return event as unknown as Record<string, unknown>;
  return { kind: event.kind, _truncated: true };
}

export function startRecipesWorker() {
  const worker = new Worker<RecipeEvent>(
    QUEUE,
    async (job: Job<RecipeEvent>) => {
      await processEvent(job.data);
    },
    { connection: redis, concurrency: 4 },
  );
  worker.on('failed', (job, err) =>
    logger.error({ jobId: job?.id, err }, 'recipes dispatch failed'),
  );
  return worker;
}
