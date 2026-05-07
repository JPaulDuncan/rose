import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { PageUpdateRequest } from '@rose/shared';
import { userIdOf } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { Page, SenderBrand, DaydreamNote, TagCanonical, Email, titleCaseTag, Category, normalizeCategoryName } from '@rose/db';
import { PageRevision } from '@rose/db';
import { SYSTEM_PROMPT_BASE, extractJson } from '@rose/llm';
import { resolveProviderForUser } from '../lib/providers.js';
import { logger } from '../lib/logger.js';

/**
 * Resolve every senderAddress on a page to its (brandKey, name, logoUrl).
 * The Page route includes this map so the wiki view can render brand
 * chips and link each sender to its address-book page (`/s/:brandKey`)
 * without per-address requests.
 *
 * Plans 14–15 — reads exclusively from the **global** `SenderBrand`
 * collection. This is the source of the "logos shared system-wide"
 * guarantee: a logo learned from one user's email shows up for
 * every user encountering the same sender, even users who've never
 * interacted with that brand.
 */
async function senderBrandsForPage(
  userId: Types.ObjectId,
  addresses: string[],
): Promise<Record<string, { brandKey: string; name: string; logoUrl: string | null }>> {
  if (!addresses?.length) return {};
  const out: Record<string, { brandKey: string; name: string; logoUrl: string | null }> =
    {};
  // Pass 1: global brand rows.
  const brands = await SenderBrand.find({ addresses: { $in: addresses } })
    .select('brandKey name logoUrl addresses')
    .lean();
  for (const b of brands) {
    for (const a of (b.addresses as string[] | undefined) ?? []) {
      if (!out[a]) {
        out[a] = { brandKey: b.brandKey, name: b.name, logoUrl: b.logoUrl ?? null };
      }
    }
  }
  // Plan 15 — `Sender` no longer carries brand-global fields, so
  // the per-user fallback that used to live here is gone. The
  // boot-time migration backfills SenderBrand for every existing
  // brand on first boot; subsequent worker writes keep it in sync.
  // If an address is missing from the result map at this point,
  // the user's mail just hasn't reached the senderUpsert step yet —
  // the chip will appear without a logo until the next page write
  // catches up.
  return out;
}
/**
 * Resolve a list of canonical kebab tags to the user's preferred
 * display names. Mirrors the worker-side helper but lives in the
 * API layer so we can attach the map to GET /api/pages responses
 * without round-tripping through the worker. Returns an exhaustive
 * map (one entry per input) — falls back to title-cased canonical
 * for tags the user hasn't customized yet.
 */
async function tagDisplayNamesFor(
  userId: Types.ObjectId,
  canonicals: string[],
): Promise<Record<string, string>> {
  const keys = [...new Set(canonicals.filter((c) => typeof c === 'string' && c.length > 0))];
  if (keys.length === 0) return {};
  const rows = await TagCanonical.find({ userId, canonical: { $in: keys } })
    .select('canonical displayName')
    .lean();
  const out: Record<string, string> = {};
  for (const k of keys) out[k] = titleCaseTag(k);
  for (const r of rows) {
    if (r.displayName && r.displayName.trim()) out[r.canonical] = r.displayName;
  }
  return out;
}

/**
 * Fetch metadata for any *live* (non-dismissed) merge suggestions
 * on a page so the UI banner can show "Potential duplicate of
 * <title>" with a one-line summary. Returns an empty array when
 * the suggestions have nothing to surface (all dismissed, or the
 * target pages have since been deleted).
 */
async function liveMergeSuggestions(
  userId: Types.ObjectId,
  rawSuggestions: unknown,
): Promise<
  Array<{
    pageId: string;
    score: number;
    reason: string;
    suggestedAt: string | null;
    title: string;
    slug: string;
    summary: string;
  }>
> {
  const suggestions = (rawSuggestions ?? []) as Array<{
    pageId: Types.ObjectId | string;
    score: number;
    reason: string;
    suggestedAt?: Date | string | null;
    dismissedAt?: Date | string | null;
  }>;
  const live = suggestions.filter((s) => !s.dismissedAt);
  if (live.length === 0) return [];
  const ids = live.map((s) => new Types.ObjectId(String(s.pageId)));
  const targets = await Page.find({ _id: { $in: ids }, userId })
    .select('title slug summary')
    .lean();
  const byId = new Map(targets.map((t) => [String(t._id), t]));
  return live
    .map((s) => {
      const t = byId.get(String(s.pageId));
      if (!t) return null;
      return {
        pageId: String(s.pageId),
        score: s.score,
        reason: s.reason ?? '',
        suggestedAt: s.suggestedAt ? new Date(s.suggestedAt).toISOString() : null,
        title: t.title,
        slug: t.slug,
        summary: t.summary ?? '',
      };
    })
    .filter((v): v is NonNullable<typeof v> => v != null)
    .sort((a, b) => b.score - a.score);
}

import { embedPageQueue, daydreamQueue, generatePageQueue } from '../lib/queues.js';
import { llmForceLimiter } from '../middleware/rateLimit.js';
import { recordRevision, uniqueSlug } from '../services/wiki.js';

export const pagesRouter: Router = Router();

pagesRouter.get('/', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const limit = Math.min(Number(req.query.limit ?? 50), 200);
  const tag = req.query.tag as string | undefined;
  const filter: Record<string, unknown> = { userId };
  if (tag) filter.tags = tag;
  const pages = await Page.find(filter)
    .sort({ updatedAt: -1 })
    .limit(limit)
    .select('-contentMd')
    .lean();
  res.json({ pages });
});

pagesRouter.get('/by-slug/:slug', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const page = await Page.findOne({ userId, slug: req.params.slug }).lean();
  if (!page) {
    res.status(404).json({ error: 'not_found', message: 'Page not found' });
    return;
  }
  const [senderBrands, tagDisplayNames, mergeSuggestions] = await Promise.all([
    senderBrandsForPage(userId, page.senderAddresses ?? []),
    tagDisplayNamesFor(userId, (page.tags ?? []) as string[]),
    liveMergeSuggestions(userId, page.mergeSuggestions),
  ]);
  res.json({ ...page, senderBrands, tagDisplayNames, mergeSuggestions });
});

pagesRouter.get('/:id', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  if (!Types.ObjectId.isValid(req.params.id)) {
    res.status(400).json({ error: 'invalid_request', message: 'Invalid id' });
    return;
  }
  const page = await Page.findOne({ _id: req.params.id, userId }).lean();
  if (!page) {
    res.status(404).json({ error: 'not_found', message: 'Page not found' });
    return;
  }
  const [senderBrands, tagDisplayNames, mergeSuggestions] = await Promise.all([
    senderBrandsForPage(userId, page.senderAddresses ?? []),
    tagDisplayNamesFor(userId, (page.tags ?? []) as string[]),
    liveMergeSuggestions(userId, page.mergeSuggestions),
  ]);
  res.json({ ...page, senderBrands, tagDisplayNames, mergeSuggestions });
});

pagesRouter.patch('/:id', validateBody(PageUpdateRequest), async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const page = await Page.findOne({ _id: req.params.id, userId });
  if (!page) {
    res.status(404).json({ error: 'not_found', message: 'Page not found' });
    return;
  }
  const update = req.body as typeof PageUpdateRequest._type;
  const titleChanged = update.title && update.title !== page.title;
  if (titleChanged) page.slug = await uniqueSlug(userId, update.title!, page._id);
  if (update.title) page.title = update.title;
  if (update.summary !== undefined) page.summary = update.summary;
  if (update.contentMd !== undefined) page.contentMd = update.contentMd;
  if (update.tags) page.tags = update.tags;
  if (update.categoryId !== undefined)
    page.categoryId = update.categoryId ? new Types.ObjectId(update.categoryId) : null;
  page.version += 1;
  page.generatedBy = 'human';
  page.generatedAt = new Date();
  await page.save();
  await recordRevision(
    {
      _id: page._id,
      version: page.version,
      title: page.title,
      summary: page.summary,
      contentMd: page.contentMd,
    },
    'user',
  );
  await embedPageQueue.add(
    'embed',
    { pageId: page._id.toString(), userId: userId.toString() },
    { removeOnComplete: 200, removeOnFail: 200, attempts: 3 },
  );
  res.json(page);
});

pagesRouter.delete('/:id', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  await Page.deleteOne({ _id: req.params.id, userId });
  await PageRevision.deleteMany({ pageId: req.params.id });
  res.json({ ok: true });
});

const MergeRequest = z.object({
  intoPageId: z.string().refine((v) => Types.ObjectId.isValid(v), 'invalid id'),
});

/**
 * Merge `:id` (the source page) into `intoPageId` (the target page).
 *
 *   • Source emails, threadKeys, sender addresses, subject templates,
 *     synthesisOf, and topicAliases all roll up onto the target.
 *   • Email.pageId rewrites to the target so future regenerations
 *     see the combined corpus.
 *   • Target switches to topic + incremental mode so the next
 *     generation pass folds the new sources into the existing prose
 *     instead of rewriting from scratch.
 *   • A regenerate job is enqueued for the target via its newest
 *     contributing email so the UI catches up.
 *   • The source page is deleted along with its revisions.
 *
 * The dedupe check that produces `mergeSuggestions` is conservative
 * (multi-stage cosine + LLM verification), but this action is
 * destructive — the UI should always confirm before calling.
 */
pagesRouter.post('/:id/merge', validateBody(MergeRequest), async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const sourceId = req.params.id ?? '';
  if (!sourceId || !Types.ObjectId.isValid(sourceId)) {
    res.status(400).json({ error: 'invalid_request', message: 'Invalid id' });
    return;
  }
  const body = req.body as typeof MergeRequest._type;
  const targetId = body.intoPageId;
  if (sourceId === targetId) {
    res.status(400).json({ error: 'invalid_request', message: 'Cannot merge a page into itself' });
    return;
  }
  const [source, target] = await Promise.all([
    Page.findOne({ _id: sourceId, userId }),
    Page.findOne({ _id: targetId, userId }),
  ]);
  if (!source || !target) {
    res.status(404).json({ error: 'not_found', message: 'Source or target page not found' });
    return;
  }

  // Roll source bookkeeping onto target. Sets dedup, arrays unionised.
  const setOf = <T,>(...arrs: Array<T[] | undefined>) =>
    [...new Set(arrs.flatMap((a) => a ?? []))];
  target.sourceEmailIds = setOf(
    target.sourceEmailIds as Types.ObjectId[],
    source.sourceEmailIds as Types.ObjectId[],
  );
  target.threadKeys = setOf(target.threadKeys as string[], source.threadKeys as string[]);
  target.senderAddresses = setOf(
    target.senderAddresses as string[],
    source.senderAddresses as string[],
  );
  target.subjectTemplates = setOf(
    target.subjectTemplates as string[],
    source.subjectTemplates as string[],
  );
  target.topicAliases = setOf(
    target.topicAliases as string[],
    source.topicAliases as string[],
    // The source's title is itself an alias on the target now —
    // anyone navigating from the merged page's URL or searching the
    // old phrasing should still find the target.
    [source.title.toLowerCase()],
  ).slice(0, 20);
  target.synthesisOf = setOf(
    target.synthesisOf as Types.ObjectId[],
    source.synthesisOf as Types.ObjectId[],
  );
  target.groupingMode = 'topic';
  target.generationMode = 'incremental';
  // Force the next generation pass to see ALL emails as "new"
  // relative to the prior snapshot — that way the consolidate
  // prompt actually folds the source's contributions into the
  // target's prose instead of skipping them as already-seen.
  target.lastGeneratedFromEmailIds = (target.lastGeneratedFromEmailIds ?? []) as Types.ObjectId[];
  // Drop any merge-suggestion entry that pointed at the source
  // (it's about to disappear).
  const existingSuggestions = (target.mergeSuggestions ?? []) as Array<{
    pageId: Types.ObjectId;
  }>;
  target.set(
    'mergeSuggestions',
    existingSuggestions.filter((s) => String(s.pageId) !== sourceId),
  );
  target.markModified('mergeSuggestions');
  await target.save();

  // Repoint emails. After this update the next email-driven
  // generate-page job that references one of these emails will
  // route to the target via its threadKey/sender/topic match.
  await Email.updateMany(
    { _id: { $in: source.sourceEmailIds }, userId },
    { $set: { pageId: target._id } },
  );

  // Find the most recent email on the target so we can enqueue a
  // regeneration anchored on something real. If there's nothing,
  // we skip the enqueue — the merge is still durable, the next
  // organic update on the topic will pick it up.
  const newest = await Email.findOne({ pageId: target._id, userId })
    .sort({ date: -1, createdAt: -1 })
    .select('_id')
    .lean();
  if (newest) {
    await generatePageQueue.add(
      'generate',
      { emailId: String(newest._id), userId: String(userId) },
      {
        removeOnComplete: 200,
        removeOnFail: 200,
        attempts: 3,
        // Custom jobIds use `__` as the delimiter (BullMQ rejects `:`).
        jobId: `merge-rewrite__${String(target._id)}__${Date.now()}`,
      },
    );
  }

  // Delete the source page and its revision history. The target
  // owns everything substantive now.
  await Page.deleteOne({ _id: source._id, userId });
  await PageRevision.deleteMany({ pageId: source._id });

  res.json({
    ok: true,
    targetId: String(target._id),
    targetSlug: target.slug,
  });
});

/**
 * Dismiss a single merge suggestion so it doesn't keep appearing
 * after each regeneration. Stored as a `dismissedAt` timestamp on
 * the suggestion entry so the worker's detection step can avoid
 * re-suggesting the same pair.
 */
pagesRouter.delete('/:id/merge-suggestions/:targetId', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const id = req.params.id ?? '';
  const targetId = req.params.targetId ?? '';
  if (!Types.ObjectId.isValid(id) || !Types.ObjectId.isValid(targetId)) {
    res.status(400).json({ error: 'invalid_request', message: 'Invalid id' });
    return;
  }
  const page = await Page.findOne({ _id: id, userId });
  if (!page) {
    res.status(404).json({ error: 'not_found', message: 'Page not found' });
    return;
  }
  const suggestions = (page.mergeSuggestions ?? []) as Array<{
    pageId: Types.ObjectId;
    score: number;
    reason: string;
    suggestedAt: Date | null;
    dismissedAt: Date | null;
  }>;
  const next = suggestions.map((s) =>
    String(s.pageId) === targetId ? { ...s, dismissedAt: s.dismissedAt ?? new Date() } : s,
  );
  page.set('mergeSuggestions', next);
  page.markModified('mergeSuggestions');
  await page.save();
  res.json({ ok: true });
});

/** Cosine similarity between two equal-length vectors. Inlined here
 *  to keep the hot path one Mongo round-trip + an in-process scan;
 *  copying the helper from chat.ts is the same five lines. */
function cosineSim(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/**
 * Up to 5 wiki pages most semantically similar to the target page.
 * Exact cosine over `Page.embedding`, scoped to the same user, with
 * the same `embeddingModel` (so we never compare incompatible
 * vector spaces). Excludes the page itself, spam-flagged pages,
 * and notification-stream pages so a page about deploys doesn't
 * recommend a wall of CI noise.
 *
 * Cheap-O: pulls every embedding for the user. The full-corpus
 * scan is fine up to ~10k pages; if/when it stops being fine,
 * pre-compute neighbors during embedPage instead.
 */
pagesRouter.get('/:id/related', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  if (!Types.ObjectId.isValid(req.params.id)) {
    res.status(400).json({ error: 'invalid_request', message: 'Invalid id' });
    return;
  }
  const page = await Page.findOne({ _id: req.params.id, userId })
    .select('+embedding embeddingModel')
    .lean();
  if (!page) {
    res.status(404).json({ error: 'not_found', message: 'Page not found' });
    return;
  }
  const vec = (page as { embedding?: number[] | null }).embedding;
  if (!vec || vec.length === 0) {
    // Page hasn't been embedded yet (worker hasn't gotten to it,
    // user disabled the embedding role, etc.). Don't fail the
    // page render — just return an empty list.
    res.json({ related: [] });
    return;
  }

  const candidates = await Page.find({
    userId,
    _id: { $ne: page._id },
    embedding: { $ne: null },
    embeddingModel: page.embeddingModel,
    'flags.userMarkedSpam': { $ne: true },
    'flags.hasLikelySpam': { $ne: true },
    'flags.autoQuarantined': { $ne: true },
    'flags.isNotificationStream': { $ne: true },
  })
    .select('+embedding slug title summary heroImageUrl tags updatedAt')
    .lean();

  const scored = (
    candidates as unknown as Array<{
      _id: Types.ObjectId;
      slug: string;
      title: string;
      summary: string;
      heroImageUrl: string | null;
      tags: string[];
      updatedAt: Date;
      embedding: number[] | null;
    }>
  )
    .map((c) => ({
      _id: String(c._id),
      slug: c.slug,
      title: c.title,
      summary: c.summary,
      heroImageUrl: c.heroImageUrl ?? null,
      tags: c.tags ?? [],
      updatedAt: c.updatedAt,
      score: c.embedding ? cosineSim(vec, c.embedding) : 0,
    }))
    // Threshold guards against "the closest page in the corpus is
    // still wildly unrelated" — happens with tiny corpora. 0.55 is
    // empirical; a Q4-quantized nomic-embed-text gets sibling pages
    // around 0.7+ and thematically-adjacent ones around 0.55–0.7.
    .filter((c) => c.score >= 0.55)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  res.json({
    related: scored.map((s) => ({
      _id: s._id,
      slug: s.slug,
      title: s.title,
      summary: s.summary,
      heroImageUrl: s.heroImageUrl,
      tags: s.tags,
      updatedAt: s.updatedAt,
      score: Number(s.score.toFixed(3)),
    })),
  });
});

pagesRouter.get('/:id/revisions', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const page = await Page.findOne({ _id: req.params.id, userId }).select('_id').lean();
  if (!page) {
    res.status(404).json({ error: 'not_found', message: 'Page not found' });
    return;
  }
  const revisions = await PageRevision.find({ pageId: page._id }).sort({ version: -1 }).lean();
  res.json({ revisions });
});

pagesRouter.post('/:id/revisions/:version/restore', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const page = await Page.findOne({ _id: req.params.id, userId });
  if (!page) {
    res.status(404).json({ error: 'not_found', message: 'Page not found' });
    return;
  }
  const rev = await PageRevision.findOne({
    pageId: page._id,
    version: Number(req.params.version),
  });
  if (!rev) {
    res.status(404).json({ error: 'not_found', message: 'Revision not found' });
    return;
  }
  page.title = rev.title ?? page.title;
  page.summary = rev.summary ?? page.summary;
  page.contentMd = rev.contentMd ?? page.contentMd;
  page.version += 1;
  page.generatedBy = 'human';
  page.generatedAt = new Date();
  await page.save();
  await recordRevision(
    {
      _id: page._id,
      version: page.version,
      title: page.title,
      summary: page.summary,
      contentMd: page.contentMd,
    },
    'user',
  );
  await embedPageQueue.add(
    'embed',
    { pageId: page._id.toString() },
    { removeOnComplete: 200, removeOnFail: 200, attempts: 3 },
  );
  res.json(page);
});

/**
 * Daydream notes attached to a page. Joined via Page.daydreamSubjects[]
 * — each entry is a (kind, subjectKey) pair the worker has decided
 * this page wants context for. Returns notes regardless of whether
 * they're failed or fresh; the UI distinguishes via the `failed` flag.
 */
pagesRouter.get('/:id/daydream', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const page = await Page.findOne({ _id: req.params.id, userId })
    .select('daydreamSubjects')
    .lean();
  if (!page) {
    res.status(404).json({ error: 'not_found', message: 'Page not found' });
    return;
  }
  const subjects = (page.daydreamSubjects ?? []) as { kind: string; subjectKey: string }[];
  if (subjects.length === 0) {
    res.json({ notes: [] });
    return;
  }
  // One $or branch per (kind, key) — keeps the index on
  // (kind, subjectKey) usable. Plan 14 — notes are global; filter
  // out anything this user has chosen to forget.
  const notes = await DaydreamNote.find({
    forgottenBy: { $ne: userId },
    $or: subjects.map((s) => ({ kind: s.kind, subjectKey: s.subjectKey })),
  }).lean();
  res.json({
    notes: notes.map((n) => ({
      _id: String(n._id),
      kind: n.kind,
      subjectKey: n.subjectKey,
      displayName: n.displayName,
      summary: n.summary,
      bodyMd: n.bodyMd,
      sources: (n.sources ?? []).map((s) => ({
        adapter: s.adapter,
        url: s.url,
        title: s.title ?? '',
        fetchedAt: s.fetchedAt ? new Date(s.fetchedAt).toISOString() : null,
      })),
      confidence: n.confidence,
      model: n.model ?? null,
      generatedAt: n.generatedAt ? new Date(n.generatedAt).toISOString() : null,
      failed: !!n.failed,
      failureReason: n.failureReason ?? null,
    })),
  });
});

/**
 * Force a daydream pass on this page now — bypass the idle sweeper.
 * Rate-limited via the shared Redis-backed `llmForceLimiter` so the
 * 5/min cap holds across multiple API processes.
 */
pagesRouter.post('/:id/daydream', llmForceLimiter, async (req, res) => {
  const userIdStr = String(userIdOf(req));
  const userId = new Types.ObjectId(userIdStr);
  const page = await Page.findOne({ _id: req.params.id, userId }).select('_id').lean();
  if (!page) {
    res.status(404).json({ error: 'not_found', message: 'Page not found' });
    return;
  }
  const job = await daydreamQueue.add(
    'page',
    { kind: 'page', userId: userIdStr, pageId: String(page._id) },
    { attempts: 1, removeOnComplete: 200, removeOnFail: 200, priority: 0 },
  );
  res.status(202).json({ jobId: job.id });
});

const RecategorizeRequest = z.object({
  pageIds: z.array(z.string()).min(1).max(50),
});

/**
 * Build the categorization prompt. Mirrors the CATEGORY rules in the
 * page-generation seed prompt so a recategorize and a fresh generate
 * agree on what counts as a good vs bad bucket.
 */
function buildCategorizePrompt(args: {
  pageTitle: string;
  pageSummary: string;
  pageBody: string;
  tags: string[];
  existingCategoriesBlock: string;
  currentCategoryName: string | null;
}): string {
  return `You are reassigning a wiki page to a category. Read every rule before deciding.

EXISTING CATEGORIES (name<TAB>page-count, one per line, may be empty):
${args.existingCategoriesBlock}

PAGE
- Title: ${args.pageTitle}
- Summary: ${args.pageSummary}
- Tags: ${args.tags.join(', ') || '(none)'}
- Currently in category: ${args.currentCategoryName ?? 'Uncategorized'}
- Body (first 4000 chars):
"""
${args.pageBody.slice(0, 4000)}
"""

RULES — STRICT
1. PREFER an existing category. If the page fits one above, return that exact name verbatim.
2. Only invent a NEW category when the page is clearly about a topic NONE of the existing categories cover. New categories must be specific noun phrases (e.g. "Home Improvement", "Personal Finance"), not vague catch-alls.
3. NEVER use these vague catch-alls unless the content is unambiguously about the subject:
   - "Politics" — only when the page names specific politicians, parties, elections, legislation, government policy debates, or political movements. Opinion newsletters, op-eds, satire, tech-industry commentary, business news, marketing emails about social causes, and general newsletters are NOT politics.
   - "News" — never. The whole product is a news engine.
   - "Misc", "Other", "General", "Updates", "Email", "Information" — never. Return null instead.
4. If nothing fits, return null. An uncategorized page is strictly better than a wrongly-categorized one.
5. If the current category is still the right answer, return it unchanged.

Respond with JSON only, exactly:
{"category": "<existing or new category name>" | null, "isNewCategory": <bool>, "reason": "<one short sentence>"}`;
}

const Verdict = z.object({
  category: z.string().nullable(),
  isNewCategory: z.boolean().optional(),
  reason: z.string().optional(),
});

/**
 * Recategorize a batch of pages using the user's current category
 * taxonomy. Sequential per-page LLM calls; capped at 50 pages so the
 * total request stays bounded. Returns per-page outcomes so the UI
 * can show what changed.
 *
 * Rate-limited via `llmForceLimiter` (shared with the daydream/force
 * endpoint) — recategorize can fire up to 50 LLM calls per request.
 */
pagesRouter.post(
  '/recategorize',
  llmForceLimiter,
  validateBody(RecategorizeRequest),
  async (req, res, next) => {
    try {
      const userId = new Types.ObjectId(userIdOf(req));
      const { pageIds } = req.body as z.infer<typeof RecategorizeRequest>;

      const ids = pageIds
        .filter((id) => Types.ObjectId.isValid(id))
        .map((id) => new Types.ObjectId(id));
      if (ids.length === 0) {
        res.status(400).json({ error: 'invalid_request', message: 'No valid page ids' });
        return;
      }

      const pages = await Page.find({ userId, _id: { $in: ids } })
        .select('+contentMd title summary tags categoryId')
        .lean();

      const categories = await Category.find({ userId }).select('_id name normalizedName').lean();
      const counts = await Page.aggregate<{ _id: Types.ObjectId; n: number }>([
        { $match: { userId, categoryId: { $ne: null } } },
        { $group: { _id: '$categoryId', n: { $sum: 1 } } },
      ]);
      const countById = new Map(counts.map((c) => [String(c._id), c.n]));
      const categoryById = new Map(categories.map((c) => [String(c._id), c]));
      const existingCategoriesBlock = categories.length
        ? categories
            .map((c) => `${c.name}\t${countById.get(String(c._id)) ?? 0}`)
            .join('\n')
        : '(none yet — pick null or a specific new category)';

      const { provider, model } = await resolveProviderForUser(userId, 'generation');

      type Outcome = {
        pageId: string;
        title: string;
        oldCategory: string | null;
        newCategory: string | null;
        status: 'changed' | 'unchanged' | 'failed';
        reason?: string;
      };
      const outcomes: Outcome[] = [];

      for (const page of pages) {
        const oldCategory = page.categoryId
          ? categoryById.get(String(page.categoryId))?.name ?? null
          : null;
        const prompt = buildCategorizePrompt({
          pageTitle: page.title ?? '',
          pageSummary: page.summary ?? '',
          pageBody: page.contentMd ?? '',
          tags: (page.tags as string[] | undefined) ?? [],
          existingCategoriesBlock,
          currentCategoryName: oldCategory,
        });
        let raw: string;
        try {
          raw = await provider.generate({
            model,
            prompt,
            system: SYSTEM_PROMPT_BASE,
            format: 'json',
            temperature: 0.1,
            maxTokens: 200,
          });
        } catch (err) {
          logger.warn(
            { err, pageId: String(page._id) },
            'recategorize: provider call failed',
          );
          outcomes.push({
            pageId: String(page._id),
            title: page.title ?? '',
            oldCategory,
            newCategory: oldCategory,
            status: 'failed',
            reason: 'LLM call failed',
          });
          continue;
        }
        let verdict: z.infer<typeof Verdict>;
        try {
          verdict = Verdict.parse(extractJson(raw));
        } catch (err) {
          logger.warn(
            { err, pageId: String(page._id), raw },
            'recategorize: invalid JSON from LLM',
          );
          outcomes.push({
            pageId: String(page._id),
            title: page.title ?? '',
            oldCategory,
            newCategory: oldCategory,
            status: 'failed',
            reason: 'Invalid JSON',
          });
          continue;
        }

        const newName = verdict.category?.trim() || null;
        if (newName === oldCategory) {
          outcomes.push({
            pageId: String(page._id),
            title: page.title ?? '',
            oldCategory,
            newCategory: oldCategory,
            status: 'unchanged',
            reason: verdict.reason,
          });
          continue;
        }

        let newCategoryId: Types.ObjectId | null = null;
        if (newName) {
          const normalized = normalizeCategoryName(newName);
          const existing =
            (await Category.findOne({ userId, normalizedName: normalized })) ??
            (await Category.findOne({ userId, name: newName }));
          if (existing) {
            newCategoryId = existing._id as Types.ObjectId;
          } else {
            const created = await Category.create({
              userId,
              name: newName,
              normalizedName: normalized,
            });
            newCategoryId = created._id as Types.ObjectId;
          }
        }
        await Page.updateOne(
          { _id: page._id, userId },
          { $set: { categoryId: newCategoryId } },
        );
        outcomes.push({
          pageId: String(page._id),
          title: page.title ?? '',
          oldCategory,
          newCategory: newName,
          status: 'changed',
          reason: verdict.reason,
        });
      }

      // Garbage-collect any categories that are no longer referenced.
      // Cheap: skip if nothing actually changed.
      const movedFrom = outcomes
        .filter((o) => o.status === 'changed')
        .map((o) => o.oldCategory)
        .filter((n): n is string => !!n);
      if (movedFrom.length > 0) {
        const orphans = await Category.find({
          userId,
          name: { $in: movedFrom },
        })
          .select('_id name')
          .lean();
        for (const orphan of orphans) {
          const stillUsed = await Page.exists({ userId, categoryId: orphan._id });
          if (!stillUsed) {
            await Category.deleteOne({ _id: orphan._id });
          }
        }
      }

      res.json({ outcomes });
    } catch (err) {
      next(err);
    }
  },
);
