import { Worker, type Job, Queue } from 'bullmq';
import { Types } from 'mongoose';
import { z } from 'zod';
import { Page, TagDigest, Instruction, User } from '@rose/db';
import { renderTemplate, SYSTEM_PROMPT_BASE } from '@rose/llm';
import { redis, bullConnection } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { resolveProviderForUser } from '../lib/providers.js';
import { xRetrieveUserFacts, augmentSystemPromptWithUserFacts } from '../services/xRetrieve.js';

const QUEUE = 'rose.tag-digest';

export type TagDigestJobData = { userId: string; tag: string };

const DigestOutput = z.object({
  headline: z.string().min(1).max(120),
  dek: z.string().min(1).max(280),
  bodyMd: z.string().max(900),
});

function utcDayKey(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

async function templateFor(userId: Types.ObjectId): Promise<string | null> {
  const userOverride = await Instruction.findOne({
    userId,
    scope: 'tag-digest',
    isDefault: true,
  })
    .select('template')
    .lean();
  if (userOverride?.template) return userOverride.template;
  const system = await Instruction.findOne({
    userId,
    scope: 'tag-digest',
    isSystem: true,
  })
    .select('template')
    .lean();
  return system?.template ?? null;
}

/**
 * Daily digest generator for one tag. Pulls the most recently
 * updated wiki pages tagged or topiced with `tag`, asks the user's
 * generation provider to write a newspaper section editor's brief
 * (headline + dek + body), and persists to the TagDigest collection
 * keyed (userId, tag, dayKey).
 *
 * Job ID is `digest:<userId>:<tag>:<dayKey>` so duplicate enqueues
 * collapse — the daily cron + an on-demand pin both produce the
 * same job.
 *
 * Failure handling matches the rest of the digest stack: a failed
 * attempt persists with `failed: true` and the UI degrades to the
 * page list with no lede.
 */
export function startTagDigestWorker(): void {
  const worker = new Worker<TagDigestJobData>(
    QUEUE,
    async (job: Job<TagDigestJobData>) => {
      const userId = new Types.ObjectId(job.data.userId);
      const tag = job.data.tag.toLowerCase();
      const dayKey = utcDayKey();
      // Multi-tag intersection: the API encodes "Receipt + Anthropic"
      // as `receipt+anthropic`. Split on `+` to drive the page
      // filter; the original joined slug stays as `tag` for the
      // (userId, tag, dayKey) digest key.
      const tagParts = tag
        .split('+')
        .map((p) => p.trim())
        .filter(Boolean);
      const tagsRequired = [...new Set(tagParts)];
      const isMulti = tagsRequired.length > 1;
      const tagDisplay = isMulti
        ? `#${tagsRequired.join(' + #')}`
        : `#${tag}`;

      // Pull the top 8 recently-updated pages for this tag (or
      // intersection). The LLM gets a compact label list (p1..pN)
      // plus title + summary so the prompt stays bounded.
      const tagFilters = tagsRequired.map((t) => ({
        $or: [{ tags: t }, { topics: t }],
      }));
      const pages = await Page.find({
        userId,
        $and: [
          ...tagFilters,
          {
            $or: [
              { 'flags.userMarkedSpam': { $ne: true } },
              { 'flags.userMarkedSpam': null },
            ],
          },
          {
            $or: [
              { 'flags.hasLikelySpam': { $ne: true } },
              { 'flags.hasLikelySpam': null },
            ],
          },
        ],
      })
        .sort({ updatedAt: -1 })
        .limit(8)
        .select('_id title summary updatedAt')
        .lean();

      if (pages.length === 0) {
        // No content — write a "Quiet day" placeholder so the
        // newsletter section still renders something coherent.
        await TagDigest.findOneAndUpdate(
          { userId, tag, dayKey },
          {
            $set: {
              userId,
              tag,
              dayKey,
              headline: `Quiet day on ${tagDisplay}`,
              dek: 'No new dispatches today.',
              bodyMd: '',
              topPageIds: [],
              pageCount: 0,
              generatedAt: new Date(),
              failed: false,
              failureReason: null,
            },
          },
          { upsert: true, new: true, setDefaultsOnInsert: true },
        );
        return { skipped: 'no-pages' };
      }

      const template = await templateFor(userId);
      if (!template) {
        logger.warn({ userId: String(userId) }, 'tag-digest: no template');
        return { skipped: 'no-template' };
      }

      const labels = pages.map((p, i) => ({ pageId: p._id, label: `p${i + 1}`, page: p }));
      const entries = labels
        .map(
          (l) =>
            `[${l.label}] ${l.page.title}\n` +
            `   ${(l.page.summary ?? '').slice(0, 240)}\n` +
            `   updated ${new Date(l.page.updatedAt as Date).toLocaleDateString()}`,
        )
        .join('\n\n');

      const prompt = renderTemplate(template, {
        // For single-tag, the template's existing {{tag}} stays
        // singular. For multi-tag intersections, render the joined
        // form (e.g. "receipt + anthropic") so the LLM frames the
        // brief as a combined view rather than picking one tag.
        tag: isMulti ? tagsRequired.join(' + ') : tag,
        day_label: new Date().toLocaleDateString(undefined, {
          weekday: 'long',
          month: 'long',
          day: 'numeric',
          year: 'numeric',
        }),
        page_count: String(pages.length),
        entries,
      });

      let provider, providerId: string, modelName: string;
      try {
        const r = await resolveProviderForUser(userId, 'generation');
        provider = r.provider;
        providerId = r.providerId;
        modelName = r.model;
      } catch (err) {
        logger.warn({ err }, 'tag-digest: provider unavailable');
        await TagDigest.findOneAndUpdate(
          { userId, tag, dayKey },
          {
            $set: {
              userId,
              tag,
              dayKey,
              failed: true,
              failureReason: 'gen provider unavailable',
              generatedAt: new Date(),
              pageCount: pages.length,
              topPageIds: labels.map((l) => l.pageId),
            },
          },
          { upsert: true, new: true, setDefaultsOnInsert: true },
        );
        return { failed: true };
      }

      // xMemory user-facts seeded with the tag itself — pulls
      // facts a user has expressed about this tag's topic area.
      // For tag "running": "I run 5K twice a week" influences the
      // digest's tone (briefing-to-a-runner vs. briefing-to-a-novice).
      let digestUserFacts: string[] = [];
      try {
        const hits = await xRetrieveUserFacts(userId, tag, { maxComponents: 5 });
        digestUserFacts = hits.map((h) => h.text);
      } catch (err) {
        logger.warn(
          { err, userId: String(userId), tag },
          'tag-digest: xRetrieve user-facts failed (continuing without)',
        );
      }
      const systemPrompt = augmentSystemPromptWithUserFacts(
        SYSTEM_PROMPT_BASE,
        digestUserFacts,
      );

      let raw: string;
      try {
        raw = await provider.generate({
          model: modelName,
          prompt,
          system: systemPrompt,
          format: 'json',
          temperature: 0.3,
        });
      } catch (err) {
        logger.warn({ err, tag }, 'tag-digest: generate failed');
        await TagDigest.findOneAndUpdate(
          { userId, tag, dayKey },
          {
            $set: {
              userId,
              tag,
              dayKey,
              failed: true,
              failureReason: (err as Error).message ?? 'generate failed',
              generatedAt: new Date(),
              pageCount: pages.length,
              topPageIds: labels.map((l) => l.pageId),
            },
          },
          { upsert: true, new: true, setDefaultsOnInsert: true },
        );
        return { failed: true };
      }

      const json = raw
        .trim()
        .replace(/^```(?:json)?/i, '')
        .replace(/```$/i, '')
        .trim();
      let parsed;
      try {
        parsed = DigestOutput.parse(JSON.parse(json));
      } catch (err) {
        logger.warn({ err, raw: raw.slice(0, 400) }, 'tag-digest: invalid JSON');
        await TagDigest.findOneAndUpdate(
          { userId, tag, dayKey },
          {
            $set: {
              userId,
              tag,
              dayKey,
              failed: true,
              failureReason: 'LLM returned invalid JSON',
              generatedAt: new Date(),
              pageCount: pages.length,
              topPageIds: labels.map((l) => l.pageId),
            },
          },
          { upsert: true, new: true, setDefaultsOnInsert: true },
        );
        return { failed: true };
      }

      await TagDigest.findOneAndUpdate(
        { userId, tag, dayKey },
        {
          $set: {
            userId,
            tag,
            dayKey,
            headline: parsed.headline.slice(0, 120),
            dek: parsed.dek.slice(0, 280),
            bodyMd: parsed.bodyMd.slice(0, 900),
            topPageIds: labels.map((l) => l.pageId),
            pageCount: pages.length,
            model: `${providerId}:${modelName}`,
            generatedAt: new Date(),
            failed: false,
            failureReason: null,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
      return { ok: true, headline: parsed.headline };
    },
    {
      connection: bullConnection(),
      concurrency: 1,
      lockDuration: 10 * 60_000,
      stalledInterval: 60_000,
      maxStalledCount: 2,
    },
  );
  worker.on('failed', (job, err) =>
    logger.error({ jobId: job?.id, err }, 'tag-digest: failed'),
  );
  worker.on('error', (err) => logger.error({ err }, 'tag-digest: worker error'));
}

/**
 * Daily sweeper. Walks every user with `featuredTags` and enqueues
 * one digest job per featured tag. Job IDs collide with on-demand
 * regens scoped to the same dayKey, so re-running this is safe.
 *
 * Default cadence: hourly poll, fires once per UTC day per (user,
 * tag) by checking whether a digest already exists for today.
 */
export function startTagDigestSweeper(): void {
  const queue = new Queue<TagDigestJobData>(QUEUE, { connection: bullConnection() });
  const SWEEP_INTERVAL_MS = 60 * 60_000; // hourly
  let inFlight = false;
  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const dayKey = utcDayKey();
      const users = await User.find({ 'featuredTags.0': { $exists: true } })
        .select('_id featuredTags')
        .lean();
      let enqueued = 0;
      for (const u of users) {
        const tags = ((u as { featuredTags?: string[] }).featuredTags ?? []).slice(0, 12);
        for (const t of tags) {
          const tag = t.trim().toLowerCase();
          if (!tag) continue;
          // Skip if today's digest already exists and isn't failed —
          // hourly poll cheap-checks via index.
          const existing = await TagDigest.findOne({
            userId: u._id,
            tag,
            dayKey,
            failed: false,
          })
            .select('_id')
            .lean();
          if (existing) continue;
          await queue.add(
            'digest',
            { userId: String(u._id), tag },
            {
              // BullMQ reserves ':' for its internal key namespacing
              // and rejects custom job IDs containing it. Use '__' as
              // our delimiter so the (user, tag, day) triple still
              // collapses duplicate enqueues to a single job.
              jobId: `digest__${String(u._id)}__${tag}__${dayKey}`,
              attempts: 1,
              removeOnComplete: 200,
              removeOnFail: 200,
            },
          );
          enqueued += 1;
        }
      }
      if (enqueued > 0) {
        logger.debug({ enqueued }, 'tag-digest sweeper: tick');
      }
    } catch (err) {
      logger.warn({ err }, 'tag-digest sweeper: tick failed');
    } finally {
      inFlight = false;
    }
  };
  const handle = setInterval(() => void tick(), SWEEP_INTERVAL_MS);
  handle.unref();
  // Kick once at boot so a freshly-started worker doesn't wait an
  // hour for the first sweep.
  setTimeout(() => void tick(), 15_000).unref();
  logger.info({ intervalMs: SWEEP_INTERVAL_MS }, 'tag-digest sweeper: started');
}
