import { Worker, type Job, Queue } from 'bullmq';
import { Types } from 'mongoose';
import {
  User,
  Page,
  PageRevision,
  Instruction,
  type PageDoc,
} from '@rose/db';
import { renderTemplate, SYSTEM_PROMPT_BASE } from '@rose/llm';
import { slugify } from '@rose/shared';
import { redis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { resolveProviderForUser, applyParamOverrides } from '../lib/providers.js';
import { runPostWriteEntityExtraction } from '../services/extractEntities.js';
import { hashContent } from '../services/extractPlaces.js';

const QUEUE = 'rose.briefing';

type BriefingJobData = { userId?: string; force?: boolean };

/** Whether this user is due for a briefing right now per their
 *  configured cadence + local time. Sweep runs hourly. */
function isDue(
  cfg: {
    cadence?: 'weekly' | 'monthly';
    timeOfDayLocal?: string;
    dayOfWeek?: number;
    timezone?: string;
    lastGeneratedAt?: Date | null;
  },
  now = new Date(),
): boolean {
  const tz = cfg.timezone || 'UTC';
  const target = (cfg.timeOfDayLocal ?? '08:00').slice(0, 5);
  const [hh] = target.split(':').map((s) => Number(s));
  if (Number.isNaN(hh)) return false;
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    hour: '2-digit',
    weekday: 'short',
    day: '2-digit',
  });
  const parts = fmt.formatToParts(now);
  const localHour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const wd = parts.find((p) => p.type === 'weekday')?.value ?? '';
  const dom = Number(parts.find((p) => p.type === 'day')?.value ?? '0');
  const wdMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const localWd = wdMap[wd] ?? -1;

  if (localHour !== hh) return false;
  if (cfg.cadence === 'weekly' && localWd !== (cfg.dayOfWeek ?? 1)) return false;
  if (cfg.cadence === 'monthly' && dom !== 1) return false;
  // De-dup: don't re-run within 12 hours.
  if (cfg.lastGeneratedAt) {
    const ms = now.getTime() - new Date(cfg.lastGeneratedAt).getTime();
    if (ms < 12 * 3600 * 1000) return false;
  }
  return true;
}

/**
 * Cosine similarity between page topic centroids — good enough for a
 * cheap k-means pass. Returns 0 when either centroid is missing or
 * dimensions don't match.
 */
function cosine(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/**
 * Greedy theme clustering: pick the page with the most distinct
 * primary topic / tag, anchor a cluster on it, attach its 2-3 most
 * similar pages, repeat. We deliberately avoid full k-means here — at
 * the volumes a single user generates per week (≤ 100 pages) the
 * greedy approach lands on sensible-looking themes and runs in O(N²)
 * tops without needing a tuned `k`.
 */
function clusterPages(
  pages: PageDoc[],
  maxThemes = 5,
): { label: string; pages: PageDoc[] }[] {
  const remaining = [...pages];
  const themes: { label: string; pages: PageDoc[] }[] = [];
  while (remaining.length > 0 && themes.length < maxThemes) {
    // Anchor = page with the highest-priority + most-distinct tag.
    remaining.sort((a, b) => {
      const ap = a.priority === 'high' ? 2 : a.priority === 'low' ? 0 : 1;
      const bp = b.priority === 'high' ? 2 : b.priority === 'low' ? 0 : 1;
      return bp - ap;
    });
    const anchor = remaining.shift()!;
    const anchorTopics = new Set([
      ...((anchor.tags as string[]) ?? []),
      ...((anchor.topics as string[]) ?? []),
    ]);
    const label =
      (anchor.primaryTopic as string | null | undefined) ??
      [...anchorTopics][0] ??
      anchor.title.split(/[—\-:]/)[0]?.trim() ??
      'Other';
    const cluster: PageDoc[] = [anchor];
    // Attach pages that share a tag/topic OR have high centroid sim.
    const anchorVec = (anchor.topicCentroid as number[] | null) ?? null;
    const remCopy = [...remaining];
    for (const p of remCopy) {
      const tags = new Set([
        ...((p.tags as string[]) ?? []),
        ...((p.topics as string[]) ?? []),
      ]);
      const shared = [...tags].some((t) => anchorTopics.has(t));
      const vec = (p.topicCentroid as number[] | null) ?? null;
      const sim = anchorVec && vec ? cosine(anchorVec, vec) : 0;
      if (shared || sim > 0.6) {
        cluster.push(p);
        const idx = remaining.indexOf(p);
        if (idx >= 0) remaining.splice(idx, 1);
      }
      if (cluster.length >= 6) break;
    }
    themes.push({ label, pages: cluster });
  }
  // Anything left over goes into a final "Misc" theme so nothing's dropped.
  if (remaining.length > 0) {
    themes.push({ label: 'Misc', pages: remaining.slice(0, 6) });
  }
  return themes;
}

async function templateFor(userId: Types.ObjectId): Promise<string> {
  const userOverride = await Instruction.findOne({
    userId,
    scope: 'briefing',
    isDefault: true,
  });
  if (userOverride) return userOverride.template;
  const system = await Instruction.findOne({ userId, scope: 'briefing', isSystem: true });
  return system?.template ?? '';
}

async function uniqueSlugForUser(
  userId: Types.ObjectId,
  base: string,
): Promise<string> {
  let slug = base;
  let n = 1;
  while (await Page.findOne({ userId, slug })) {
    n += 1;
    slug = `${base}-${n}`;
  }
  return slug;
}

async function generateBriefingForUser(
  userId: Types.ObjectId,
  cfg: { cadence?: 'weekly' | 'monthly' } | null,
): Promise<{ generated: boolean; reason?: string; pageId?: string; slug?: string }> {
  const period = cfg?.cadence === 'monthly' ? 30 : 7;
  const since = new Date(Date.now() - period * 24 * 3600 * 1000);

  // Plan 12 (G9) — uniqueness gate. The hourly briefing sweep can
  // tick twice within the same calendar period if the worker
  // restarts; without this check we'd produce two briefings for
  // the same week/month. Skip when an LLM-authored briefing of the
  // same cadence already exists since `since`.
  const periodLabelForCheck: 'weekly' | 'monthly' = cfg?.cadence === 'monthly' ? 'monthly' : 'weekly';
  const existing = await Page.findOne({
    userId,
    groupingMode: 'briefing',
    tags: `${periodLabelForCheck}-briefing`,
    generatedBy: 'briefing',
    generatedAt: { $gte: since },
  })
    .select('_id slug')
    .lean();
  if (existing) {
    return {
      generated: false,
      reason: 'briefing-already-exists-for-period',
      pageId: String(existing._id),
      slug: existing.slug,
    };
  }
  const pool = (await Page.find({
    userId,
    updatedAt: { $gte: since },
    'flags.userMarkedSpam': { $ne: true },
    'flags.autoQuarantined': { $ne: true },
    'flags.isPromotional': { $ne: true },
    groupingMode: { $nin: ['briefing', 'synthesis'] },
  })
    .sort({ updatedAt: -1 })
    .limit(80)
    .select(
      '+topicCentroid slug title summary tags topics priority primaryTopic groupingMode updatedAt',
    )
    .lean()) as unknown as PageDoc[];
  if (pool.length === 0) {
    return { generated: false, reason: 'no recent pages' };
  }
  const themes = clusterPages(pool, 5);

  const template = await templateFor(userId);
  if (!template) return { generated: false, reason: 'no instruction available' };

  const periodLabel = period === 7 ? 'weekly' : 'monthly';
  const clustersBlock = themes
    .map((t, i) => {
      const lines = t.pages
        .slice(0, 6)
        .map((p) => `- [[${p.slug}]] ${p.title}${p.summary ? ` — ${p.summary.slice(0, 120)}` : ''}`)
        .join('\n');
      return `THEME ${i + 1}: ${t.label}\n${lines}`;
    })
    .join('\n\n');
  const prompt = renderTemplate(template, {
    period_label: periodLabel,
    clusters: clustersBlock,
  });

  const { provider, model: genModel, providerId, params: userParams } =
    await resolveProviderForUser(userId, 'generation');
  // Briefing is a narrative write — slightly higher temp than the
  // JSON-mode generate-page job. User overrides win.
  const merged = applyParamOverrides({ temperature: 0.4 }, userParams);
  const text = await provider.generate({
    model: genModel,
    prompt,
    system: SYSTEM_PROMPT_BASE,
    temperature: merged.temperature ?? 0.4,
    maxTokens: merged.maxTokens ?? undefined,
    topP: merged.topP ?? undefined,
    topK: merged.topK ?? undefined,
    repeatPenalty: merged.repeatPenalty ?? undefined,
    numCtx: merged.numCtx ?? undefined,
  });
  const body = text.trim();
  if (!body) return { generated: false, reason: 'empty LLM output' };

  const periodTag = `${periodLabel}-briefing`;
  const baseSlug = slugify(
    `briefing-${new Date().toISOString().slice(0, 10)}-${periodLabel}`,
  );
  const slug = await uniqueSlugForUser(userId, baseSlug);
  const title =
    periodLabel === 'weekly'
      ? `Briefing · Week of ${new Date().toLocaleDateString(undefined, {
          month: 'short',
          day: 'numeric',
        })}`
      : `Briefing · ${new Date().toLocaleDateString(undefined, {
          month: 'long',
          year: 'numeric',
        })}`;
  const created = await Page.create({
    userId,
    slug,
    title,
    summary: body.split('\n\n')[0]?.slice(0, 280) ?? '',
    contentMd: body,
    tags: ['briefing', periodTag],
    topics: ['briefing'],
    priority: 'normal',
    groupingMode: 'briefing',
    synthesisOf: pool.map((p) => p._id),
    sourceEmailIds: [],
    senderAddresses: [],
    threadKeys: [],
    citations: {},
    version: 1,
    generationModel: `${providerId}:${genModel}`,
    generatedAt: new Date(),
    generatedBy: 'briefing',
  });
  await PageRevision.create({
    pageId: created._id,
    version: 1,
    title: created.title,
    summary: created.summary,
    contentMd: created.contentMd,
    editor: 'briefing',
    model: `${providerId}:${genModel}`,
  });
  // Plan 12 (G1) — extract named entities from the briefing prose so
  // mentions auto-link to /n/<key>. Best-effort; never blocks the
  // briefing job on its own failures.
  try {
    await runPostWriteEntityExtraction(
      userId,
      created as unknown as Parameters<typeof runPostWriteEntityExtraction>[1],
      hashContent(created.contentMd ?? ''),
    );
  } catch (err) {
    logger.warn(
      { err, pageId: String(created._id) },
      'briefing: post-write entity extraction failed',
    );
  }
  return { generated: true, pageId: String(created._id), slug };
}

export function startBriefingWorker() {
  const worker = new Worker<BriefingJobData>(
    QUEUE,
    async (job: Job<BriefingJobData>) => {
      // Forced run for a single user (Settings → Generate now).
      if (job.data.userId) {
        const user = await User.findById(job.data.userId).select('settings').lean();
        const cfg = (user?.settings as { briefing?: { cadence?: 'weekly' | 'monthly' } } | undefined)
          ?.briefing ?? null;
        const r = await generateBriefingForUser(
          new Types.ObjectId(job.data.userId),
          cfg,
        );
        await User.updateOne(
          { _id: job.data.userId },
          {
            $set: {
              'settings.briefing.lastGeneratedAt': new Date(),
              'settings.briefing.lastError': r.generated ? null : r.reason ?? 'unknown',
            },
          },
        );
        logger.info({ userId: job.data.userId, ...r }, 'briefing: forced');
        return r;
      }
      // Sweep — every user with briefings enabled whose configured
      // local time matches now in their tz.
      const candidates = await User.find({ 'settings.briefing.enabled': true })
        .select('_id settings')
        .lean();
      let generated = 0;
      for (const u of candidates) {
        const cfg = (u.settings as { briefing?: Record<string, unknown> } | undefined)?.briefing ?? {};
        if (!isDue(cfg as never)) continue;
        try {
          const r = await generateBriefingForUser(u._id as Types.ObjectId, cfg as never);
          await User.updateOne(
            { _id: u._id },
            {
              $set: {
                'settings.briefing.lastGeneratedAt': new Date(),
                'settings.briefing.lastError': r.generated ? null : r.reason ?? 'unknown',
              },
            },
          );
          if (r.generated) generated += 1;
        } catch (err) {
          logger.warn(
            { err, userId: String(u._id) },
            'briefing: per-user failure',
          );
        }
      }
      if (generated > 0) {
        logger.info({ swept: candidates.length, generated }, 'briefing: sweep');
      }
      return { swept: candidates.length, generated };
    },
    { connection: redis, concurrency: 1, lockDuration: 10 * 60_000, stalledInterval: 60_000, maxStalledCount: 1 },
  );
  worker.on('failed', (job, err) =>
    logger.error({ jobId: job?.id, err }, 'briefing failed'),
  );
  return worker;
}

export const briefingQueueName = QUEUE;
export { Queue };
