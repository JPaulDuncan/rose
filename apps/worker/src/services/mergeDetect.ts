import { Types } from 'mongoose';
import { Instruction, Page, type PageDoc } from '@rose/db';
import { SYSTEM_PROMPT_BASE, extractJson, renderTemplate } from '@rose/llm';
import { z } from 'zod';
import { resolveProviderForUser, applyParamOverrides } from '../lib/providers.js';
import { logger } from '../lib/logger.js';

/**
 * Maximum candidates to run through the LLM dedupe check. The
 * embedding pre-filter narrows the field; the LLM is the expensive
 * step so we cap it tight. Top-3 covers the vast majority of "is
 * this a near-duplicate of an existing page" cases.
 */
const LLM_CHECK_LIMIT = 3;

/** Minimum cosine similarity for a candidate to even be considered. */
const PREFILTER_THRESHOLD = 0.85;

/**
 * Suggestions older than this are eligible to be replaced by a
 * fresh detection pass. Keeps the suggestion list responsive to
 * the page's current content without churning storage.
 */
const SUGGESTION_TTL_HOURS = 72;

const DedupeOutput = z.object({
  isDuplicate: z.boolean(),
  confidence: z.number().min(0).max(1).default(0),
  reason: z.string().max(280).default(''),
});

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
 * Look for pages that the just-saved `page` might be a duplicate of.
 *
 * Two-stage filter:
 *   1. Embedding pre-filter — any page in the same user with a
 *      `topicCentroid` that has cosine ≥ 0.85 to this page's
 *      centroid is a candidate. Excludes the page itself, briefings,
 *      and synthesis pages (those exist intentionally as
 *      consolidations of others).
 *   2. LLM check — for the top-3 candidates we run `dedupe.detect`
 *      and only persist suggestions where the model returns
 *      `isDuplicate: true`.
 *
 * Persisted suggestions are surfaced in the UI as a "Potential
 * duplicate of …" banner. Dismissals stick (we don't re-suggest a
 * pair the user said no to).
 */
export async function findMergeSuggestions(page: PageDoc): Promise<void> {
  const userId = page.userId as Types.ObjectId;
  const centroid = page.topicCentroid as number[] | null | undefined;
  if (!centroid || centroid.length === 0) return;

  // Pages the user already dismissed for this page — never re-suggest.
  const dismissed = new Set<string>(
    ((page.mergeSuggestions ?? []) as Array<{ pageId: Types.ObjectId; dismissedAt: Date | null }>)
      .filter((s) => s.dismissedAt)
      .map((s) => String(s.pageId)),
  );

  // Pull a generous candidate window — we'll filter by cosine in
  // memory. Mongo doesn't index float vectors so we can't push the
  // similarity into the query; the limit keeps the working set small.
  const candidates = (await Page.find({
    userId,
    _id: { $ne: page._id },
    groupingMode: { $nin: ['briefing', 'synthesis'] },
  })
    .select('+topicCentroid')
    .sort({ updatedAt: -1 })
    .limit(200)) as unknown as PageDoc[];

  type Scored = { page: PageDoc; sim: number };
  const scored: Scored[] = [];
  for (const c of candidates) {
    if (dismissed.has(String(c._id))) continue;
    const cv = c.topicCentroid as number[] | null | undefined;
    if (!cv || cv.length !== centroid.length) continue;
    const sim = cosine(centroid, cv);
    if (sim >= PREFILTER_THRESHOLD) scored.push({ page: c, sim });
  }
  scored.sort((a, b) => b.sim - a.sim);
  const topCandidates = scored.slice(0, LLM_CHECK_LIMIT);
  if (topCandidates.length === 0) {
    // Nothing close — clear stale suggestions if any have aged out.
    await pruneStaleSuggestions(page);
    return;
  }

  const template = await getDedupeInstruction(userId);
  if (!template) {
    logger.warn(
      { userId: String(userId), pageId: String(page._id) },
      'merge-detect: no dedupe instruction; skipping LLM check',
    );
    return;
  }

  const confirmed: { pageId: Types.ObjectId; score: number; reason: string }[] = [];
  for (const cand of topCandidates) {
    try {
      const verdict = await runDedupe(userId, page, cand.page, template);
      if (verdict?.isDuplicate) {
        confirmed.push({
          pageId: cand.page._id as Types.ObjectId,
          score: Math.max(verdict.confidence ?? cand.sim, cand.sim),
          reason: verdict.reason ?? '',
        });
      }
    } catch (err) {
      logger.warn(
        {
          err,
          pageId: String(page._id),
          candidateId: String(cand.page._id),
        },
        'merge-detect: dedupe check failed for candidate',
      );
    }
  }

  // Compose the new suggestion list: keep prior dismissals (so the
  // UI knows not to re-show), drop prior live suggestions, append
  // the freshly confirmed ones. Cap at 5 entries.
  const priorDismissed = ((page.mergeSuggestions ?? []) as Array<{
    pageId: Types.ObjectId;
    score: number;
    reason: string;
    suggestedAt: Date | null;
    dismissedAt: Date | null;
  }>).filter((s) => s.dismissedAt);
  const now = new Date();
  const freshSuggestions = confirmed.map((c) => ({
    pageId: c.pageId,
    score: c.score,
    reason: c.reason,
    suggestedAt: now,
    dismissedAt: null,
  }));
  const merged = [...priorDismissed, ...freshSuggestions].slice(0, 5);
  page.set('mergeSuggestions', merged);
  page.markModified('mergeSuggestions');
  await page.save();
}

async function pruneStaleSuggestions(page: PageDoc): Promise<void> {
  const cutoff = new Date(Date.now() - SUGGESTION_TTL_HOURS * 3600 * 1000);
  const suggestions = ((page.mergeSuggestions ?? []) as Array<{
    pageId: Types.ObjectId;
    suggestedAt: Date | null;
    dismissedAt: Date | null;
  }>).filter((s) => {
    // Keep dismissals indefinitely; drop live suggestions older
    // than the TTL.
    if (s.dismissedAt) return true;
    return s.suggestedAt ? new Date(s.suggestedAt) >= cutoff : false;
  });
  if (suggestions.length !== (page.mergeSuggestions ?? []).length) {
    page.set('mergeSuggestions', suggestions);
    page.markModified('mergeSuggestions');
    await page.save();
  }
}

async function getDedupeInstruction(userId: Types.ObjectId): Promise<string> {
  const userDef = await Instruction.findOne({
    userId,
    scope: 'dedupe',
    isDefault: true,
  });
  if (userDef?.template) return userDef.template;
  const sys = await Instruction.findOne({ userId, scope: 'dedupe', isSystem: true });
  return sys?.template ?? '';
}

async function runDedupe(
  userId: Types.ObjectId,
  candidate: PageDoc,
  neighbor: PageDoc,
  template: string,
): Promise<z.infer<typeof DedupeOutput> | null> {
  const prompt = renderTemplate(template, {
    candidate: describePage(candidate),
    neighbor: describePage(neighbor),
  });
  const { provider, model, params: userParams } = await resolveProviderForUser(
    userId,
    'generation',
  );
  const merged = applyParamOverrides({ temperature: 0.1 }, userParams);
  const text = await provider.generate({
    model,
    prompt,
    system: SYSTEM_PROMPT_BASE,
    format: 'json',
    temperature: merged.temperature ?? 0.1,
    maxTokens: 300,
  });
  return DedupeOutput.parse(extractJson(text));
}

function describePage(p: PageDoc): string {
  const tags = ((p.tags as string[] | undefined) ?? []).slice(0, 8).join(', ');
  return [
    `Title: ${p.title ?? ''}`,
    `Summary: ${p.summary ?? ''}`,
    `Tags: ${tags}`,
    `Body excerpt: ${(p.contentMd ?? '').slice(0, 1200)}`,
  ].join('\n');
}
