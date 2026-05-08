import { Worker, type Job } from 'bullmq';
import { Types } from 'mongoose';
import { z } from 'zod';
import {
  Page,
  Email,
  User,
  Category,
  WebDocument,
  type PageDoc,
  type WebDocumentDoc,
} from '@rose/db';
import { extractJson, renderTemplate, SYSTEM_PROMPT_BASE } from '@rose/llm';
import { Instruction } from '@rose/db';
import { PageGenerationDraft } from '@rose/shared';
import { bullConnection } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { observe, inc, METRIC } from '../lib/metrics.js';
import { resolveProviderForUser } from '../lib/providers.js';
import { extractArticle } from '../services/extractArticle.js';
import { fetchOne, hostKeyOf, urlHashOf } from '../services/fetchPool.js';
import { dot, toUnitFloat32 } from '../lib/vec.js';
import { env } from '../lib/env.js';

/**
 * Topic-research orchestrator (web-integration Phase 1).
 *
 * Job shape: `{ userId, pageId, topicLabel }`. The job is enqueued
 * by the API's POST /api/pages/:id/research handler, which has
 * already gated on user opt-in + page eligibility (no quarantined
 * sender contributors, page is topic-mode etc).
 *
 * Pipeline:
 *   1. Mark Page.researchState = 'running'.
 *   2. Resolve user prefs (budgets, threshold, denylist).
 *   3. Generate query plan (Phase 1 — template-based; LLM-assisted
 *      query generation comes in Phase 2 if topic researchers
 *      consistently underperform).
 *   4. Hit SearXNG → URL frontier.
 *   5. For each URL up to budget: fetchOne → extractArticle →
 *      embed → cosine to topic centroid. Persist as WebDocument
 *      regardless of score so the cache works on next run.
 *   6. Build the synthesis corpus: top-N web docs above threshold,
 *      plus the user's recent emails on this topic, plus any
 *      prior internal pages tagged with the topic.
 *   7. LLM synthesis via the synthesise.topic-page instruction.
 *   8. Update the page (contentMd, summary, title, tags, citations,
 *      externalSources, webDocumentIds, researchState='idle',
 *      lastResearchedAt=now).
 *
 * No recursion in Phase 1. Caller controls trigger; this worker
 * never auto-enqueues itself.
 */

const QUEUE = 'rose.topic-research';

type TopicResearchJobData = {
  userId: string;
  pageId: string;
  topicLabel: string;
};

const SearxResponse = z.object({
  results: z
    .array(
      z.object({
        url: z.string(),
        title: z.string().optional(),
        content: z.string().optional(),
        engine: z.string().optional(),
      }),
    )
    .optional(),
});

/** Per-run hard ceiling on web docs we'll send to the synthesis
 *  prompt. The prompt's context budget is finite; even if 100 docs
 *  pass the threshold we'd never want them all in-context. */
const SYNTHESIS_DOC_CAP = 12;

/** Recursion depth ceiling. depth 0 = direct from search; depth 1
 *  = harvested from inside a depth-0 article; etc. Phase 2 caps at
 *  1, which empirically delivers most of the value (a top news
 *  article links to its own follow-up coverage and to source
 *  material) without runaway. */
const MAX_RECURSION_DEPTH = 1;

/** Score floor for a harvested link to make it onto the frontier.
 *  The pre-fetch score is purely heuristic (anchor-text overlap +
 *  host trust); the actual cosine check happens after fetch. */
const RECURSE_SCORE_THRESHOLD = 0.4;

/**
 * Parse a date string + a fallback into a real Date or null. Used
 * for the recency-weighted ranking — articles tagged 2026-05-09
 * deserve a higher rank than 2014 background pieces with similar
 * topical relevance, but we should never crash a research run on a
 * malformed date string from a CMS.
 */
// Helpers below are exported solely for unit tests in
// __tests__/topicResearch.test.ts. Outside of that suite they're
// implementation detail of startTopicResearchWorker.
export function parsePublishedAt(
  primary: string | Date | null | undefined,
  fallback: Date | null | undefined,
): Date | null {
  if (primary instanceof Date) return Number.isFinite(primary.getTime()) ? primary : null;
  if (typeof primary === 'string' && primary.trim()) {
    const d = new Date(primary);
    if (Number.isFinite(d.getTime())) return d;
  }
  if (fallback instanceof Date && Number.isFinite(fallback.getTime())) return fallback;
  return null;
}

/**
 * Recency factor in [0.6, 1.0]. The synthesis-corpus sort uses
 * (relevance × recency) so a fresh-but-mediocre article doesn't
 * elbow out a strong-relevance background piece, but among
 * docs with similar topical scores the newer one wins.
 *
 * Curve: today = 1.0, week-old = 0.9, month-old = 0.78,
 * year-old = 0.6. Continuous and monotone; clamps at 0.6 so
 * historical context isn't deweighted into uselessness.
 */
export function recencyFactor(publishedAt: Date | null): number {
  if (!publishedAt) return 0.85;
  const ageDays = (Date.now() - publishedAt.getTime()) / 86_400_000;
  if (ageDays <= 1) return 1.0;
  // exp decay with half-life ~ 90 days, clamped to floor 0.6.
  const factor = Math.exp(-ageDays / 90);
  return Math.max(0.6, factor);
}

/** Hard cap on how many links per source article we'll consider
 *  pushing onto the frontier. Big news articles can have 50+
 *  in-body anchors; we don't want one source to eat the whole
 *  remaining budget. */
const MAX_LINKS_HARVESTED_PER_DOC = 12;

/** Max characters of each web doc fed into the synthesis prompt.
 *  Real article body can be much longer; the synthesis only needs
 *  enough prose to extract claims + quotes. */
const SYNTHESIS_DOC_SLICE = 4_000;

/**
 * Tokenise a topic label or anchor text into lowercase word-shaped
 * chunks. Strips punctuation, drops one-character words. Used by
 * the link-harvest scorer; not exported.
 */
function tokenize(s: string): string[] {
  return (s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

/**
 * Hosts that get a small +0.1 score boost during link-harvest
 * because they typically yield substantive coverage we can extract.
 * Mirrors the fetchPool's HIGH_TRAFFIC_HOSTS — those rate-limit
 * harder, but if a link points there, we want it. The list is
 * deliberately tiny; expanding it is a per-deploy decision.
 */
const TRUSTED_RECURSION_HOSTS = new Set([
  'apnews.com',
  'bbc.com',
  'bbc.co.uk',
  'reuters.com',
  'nytimes.com',
  'washingtonpost.com',
  'wikipedia.org',
  'theguardian.com',
  'npr.org',
]);

/**
 * Score a candidate link for promotion to the frontier. Cheap
 * heuristic only — the embed-cosine check happens after fetch, so
 * this scorer just needs to filter the obvious junk.
 *
 * Inputs:
 *   • topicTokens: lowercase word tokens from the topic label.
 *   • parentHost: hostKey of the source article. Same-host links
 *     get a small penalty so the recursion explores other voices
 *     instead of recursing into the same site's "related stories".
 *
 * Returns 0–1. The threshold is `RECURSE_SCORE_THRESHOLD`.
 */
export function scoreLink(
  href: string,
  anchorText: string,
  topicTokens: Set<string>,
  parentHost: string,
): number {
  // Non-http schemes / fragments / absurdly short hrefs.
  let hostKey = '';
  try {
    const u = new URL(href);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return 0;
    hostKey = hostKeyOf(href);
  } catch {
    return 0;
  }
  if (!hostKey) return 0;

  // Anchor-text overlap with topic tokens — primary signal.
  const anchorTokens = tokenize(anchorText);
  if (anchorTokens.length === 0) return 0;
  let hits = 0;
  for (const t of anchorTokens) if (topicTokens.has(t)) hits += 1;
  const overlap = hits / Math.max(1, Math.min(anchorTokens.length, topicTokens.size));

  let score = overlap;

  // Trusted host nudge.
  if (TRUSTED_RECURSION_HOSTS.has(hostKey)) score += 0.1;

  // Same-host as parent — small penalty to encourage source
  // diversity in the recursed corpus.
  if (hostKey === parentHost) score -= 0.05;

  // Junk URLs (login, register, share-on-social, paywall landing)
  // suppress harshly. These tend to dominate page chrome.
  if (/(login|signin|sign-in|register|subscribe|paywall|share[?/])/i.test(href)) {
    score -= 0.3;
  }

  // Anchor texts that are pure click-bait or navigational chrome.
  if (anchorText.length < 8 && anchorTokens.length === 1) score -= 0.1;
  if (/^(home|menu|next|prev|back|click here)$/i.test(anchorText.trim())) {
    return 0;
  }

  return Math.max(0, Math.min(1, score));
}

/**
 * Harvest in-body anchors from an article HTML string. Returns
 * scored, deduped, top-K candidate links above the recursion
 * threshold. Uses a regex sweep rather than a full DOM parse —
 * `extractArticle` already paid for one DOM parse; doing a second
 * just to enumerate `<a href>` is wasteful when the regex catches
 * the steady-state shape.
 *
 * The regex deliberately doesn't try to handle every edge case —
 * the worst it can do is drop a link, which the next research run
 * will probably surface via SearXNG anyway.
 */
export function harvestLinks(
  bodyHtml: string,
  parentUrl: string,
  topicLabel: string,
  parentHost: string,
  visitedUrls: Set<string>,
): { url: string; anchorText: string; score: number }[] {
  const topicTokens = new Set(tokenize(topicLabel));
  if (topicTokens.size === 0) return [];

  // <a href="..." ...>text</a> — text is everything up to the
  // closing tag, including stripped HTML. We do a second pass to
  // strip inner tags from the captured anchor text.
  const anchorRe = /<a\b[^>]*\shref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const stripTagsRe = /<[^>]*>/g;
  const candidates = new Map<string, { url: string; anchorText: string; score: number }>();
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(bodyHtml))) {
    const rawHref = m[1] ?? '';
    const anchorRaw = (m[2] ?? '').replace(stripTagsRe, ' ').trim();
    let abs: string;
    try {
      abs = new URL(rawHref, parentUrl).toString();
    } catch {
      continue;
    }
    if (visitedUrls.has(abs)) continue;
    const score = scoreLink(abs, anchorRaw, topicTokens, parentHost);
    if (score < RECURSE_SCORE_THRESHOLD) continue;
    // Dedup — keep the highest-scoring instance of each URL.
    const prev = candidates.get(abs);
    if (!prev || score > prev.score) {
      candidates.set(abs, { url: abs, anchorText: anchorRaw, score });
    }
  }
  return [...candidates.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_LINKS_HARVESTED_PER_DOC);
}

async function searchUrls(query: string, signal?: AbortSignal): Promise<
  { url: string; title: string; snippet: string }[]
> {
  const base = env.SEARXNG_URL.replace(/\/+$/, '');
  const url = `${base}/search?q=${encodeURIComponent(query)}&format=json`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Rose/1.0 (+https://rose.local; topic-research)',
        Accept: 'application/json',
      },
      signal: signal ?? ctrl.signal,
    });
    if (!resp.ok) {
      logger.warn({ status: resp.status, query }, 'topic-research: searxng non-200');
      return [];
    }
    const json = SearxResponse.safeParse(await resp.json());
    if (!json.success) {
      logger.warn({ query }, 'topic-research: searxng response did not match schema');
      return [];
    }
    return (json.data.results ?? []).map((r) => ({
      url: r.url,
      title: r.title ?? '',
      snippet: r.content ?? '',
    }));
  } finally {
    clearTimeout(timer);
  }
}

/** Phase 1 query plan — three predictable templates per topic.
 *  Future commits can replace this with an LLM-generated plan. */
export function buildQueries(topicLabel: string): string[] {
  const t = topicLabel.trim();
  if (!t) return [];
  return [
    `${t} latest news`,
    `${t} ${new Date().getFullYear()}`,
    `${t} background context`,
  ];
}

/**
 * Topic centroid for relevance scoring. Mean of: the user's recent
 * email embeddings on the topic, the topic-label string's own
 * embedding (cold-start fallback), and any tag-tagged page
 * centroids. Always returns a unit vector (or null if we couldn't
 * embed anything at all).
 */
async function buildTopicCentroid(
  userId: Types.ObjectId,
  topicLabel: string,
  triggeringPage: PageDoc | null,
): Promise<{ vec: Float32Array; sources: number } | null> {
  let resolved;
  try {
    resolved = await resolveProviderForUser(userId, 'embedding');
  } catch {
    return null;
  }
  if (!resolved.provider.supportsEmbeddings) return null;

  const labelVec = await resolved.provider.embed(resolved.model, topicLabel);
  const components: number[][] = [labelVec];

  // Trigger page's own embedding, if it has one.
  if (triggeringPage?.embedding && (triggeringPage.embedding as number[]).length) {
    components.push(triggeringPage.embedding as number[]);
  }

  // Pages tagged with the topic — mean their embeddings (capped to
  // avoid pulling thousands).
  const tagLower = topicLabel.toLowerCase();
  const peers = await Page.find({
    userId,
    tags: tagLower,
  })
    .select('+embedding')
    .limit(20)
    .lean();
  for (const p of peers) {
    const emb = (p as { embedding?: number[] | null }).embedding;
    if (emb && emb.length === labelVec.length) components.push(emb);
  }

  if (components.length === 0) return null;
  const dim = components[0]!.length;
  const sum = new Array<number>(dim).fill(0);
  let n = 0;
  for (const c of components) {
    if (c.length !== dim) continue;
    for (let i = 0; i < dim; i += 1) sum[i]! += c[i]!;
    n += 1;
  }
  if (n === 0) return null;
  for (let i = 0; i < dim; i += 1) sum[i]! /= n;
  return { vec: toUnitFloat32(sum), sources: n };
}

/** Pull a small corpus of the user's emails referencing the topic
 *  for the synthesis prompt's "what this means to *you*" frame. */
async function loadUserEmails(
  userId: Types.ObjectId,
  topicLabel: string,
): Promise<{ label: string; from: string; date: string; subject: string; text: string }[]> {
  // Topic stored on Email is lowercase.
  const tag = topicLabel.toLowerCase();
  const emails = await Email.find({
    userId,
    $or: [{ topics: tag }, { 'metadata.topics': tag }],
  })
    .sort({ date: -1 })
    .limit(5)
    .select('from date subject text rawText')
    .lean();
  return emails.map((e, i) => ({
    label: `e${i + 1}`,
    from: e.from?.address ?? 'unknown',
    date: e.date ? new Date(e.date).toISOString().slice(0, 10) : '',
    subject: e.subject ?? '',
    text: ((e.text || e.rawText || '') as string).slice(0, 2_000),
  }));
}

/** Internal pages tagged with the topic — provides background. */
async function loadInternalPages(
  userId: Types.ObjectId,
  topicLabel: string,
  excludePageId: Types.ObjectId,
): Promise<{ label: string; title: string; summary: string; tags: string[] }[]> {
  const peers = await Page.find({
    userId,
    tags: topicLabel.toLowerCase(),
    _id: { $ne: excludePageId },
  })
    .sort({ updatedAt: -1 })
    .limit(5)
    .select('title summary tags')
    .lean();
  return peers.map((p, i) => ({
    label: `i${i + 1}`,
    title: (p.title as string | undefined) ?? '',
    summary: (p.summary as string | undefined) ?? '',
    tags: ((p.tags as string[] | undefined) ?? []).slice(0, 6),
  }));
}

/** Build the labeled web-documents block for the synthesis prompt. */
function renderWebDocs(
  docs: { url: string; title: string; contentMd: string; hostKey: string; relevanceScore: number }[],
): { text: string; labels: { label: string; url: string; title: string; hostKey: string }[] } {
  const labels: { label: string; url: string; title: string; hostKey: string }[] = [];
  const blocks: string[] = [];
  docs.forEach((d, i) => {
    const label = `w${i + 1}`;
    labels.push({ label, url: d.url, title: d.title, hostKey: d.hostKey });
    const slice = d.contentMd.slice(0, SYNTHESIS_DOC_SLICE);
    blocks.push(
      `[${label}] ${d.title || '(untitled)'} — ${d.hostKey} (relevance ${d.relevanceScore.toFixed(2)})\nURL: ${d.url}\n"""\n${slice}\n"""`,
    );
  });
  return { text: blocks.join('\n\n'), labels };
}

async function getSynthesisInstruction(userId: Types.ObjectId): Promise<string> {
  const userOverride = await Instruction.findOne({
    userId,
    scope: 'synthesis',
    isDefault: true,
  })
    .select('template')
    .lean();
  if (userOverride?.template) return userOverride.template;
  const system = await Instruction.findOne({
    userId,
    scope: 'synthesis',
    isSystem: true,
  })
    .select('template')
    .lean();
  return system?.template ?? '';
}

async function setResearchState(
  pageId: Types.ObjectId,
  state: 'queued' | 'running' | 'idle' | 'failed',
  extra: Partial<{ lastResearchError: string | null; lastResearchedAt: Date }> = {},
) {
  const $set: Record<string, unknown> = { researchState: state };
  if (state === 'idle') $set.lastResearchedAt = new Date();
  if (state === 'failed') $set.lastResearchError = extra.lastResearchError ?? 'unknown';
  if (state !== 'failed') $set.lastResearchError = null;
  await Page.updateOne({ _id: pageId }, { $set });
}

export function startTopicResearchWorker(): void {
  const worker = new Worker<TopicResearchJobData>(
    QUEUE,
    async (job: Job<TopicResearchJobData>) => {
      const userId = new Types.ObjectId(job.data.userId);
      const pageId = new Types.ObjectId(job.data.pageId);
      const topicLabel = (job.data.topicLabel ?? '').trim();
      if (!topicLabel) return { skipped: 'empty-topic' };

      const t0 = Date.now();
      await setResearchState(pageId, 'running');

      try {
        // -------------------------------------------------------------
        // 1. User prefs + opt-in gate. The API also gates on this but
        //    a stale enqueue could land after the user disabled the
        //    feature, so check again here.
        // -------------------------------------------------------------
        const user = (await User.findById(userId)
          .select('settings.daydream.webResearch')
          .lean()) as
          | {
              settings?: {
                daydream?: {
                  webResearch?: {
                    enabled?: boolean;
                    perRunFetchBudget?: number;
                    perRunTimeoutMs?: number;
                    topicThreshold?: number;
                    denyHosts?: string[];
                  };
                };
              };
            }
          | null;
        const prefs = user?.settings?.daydream?.webResearch ?? {};
        if (prefs.enabled !== true) {
          await setResearchState(pageId, 'idle');
          return { skipped: 'web-research-disabled' };
        }
        const fetchBudget = Math.max(1, Math.min(50, prefs.perRunFetchBudget ?? 25));
        const timeoutMs = Math.max(30_000, prefs.perRunTimeoutMs ?? 5 * 60_000);
        const topicThreshold = Math.min(0.95, Math.max(0.2, prefs.topicThreshold ?? 0.55));
        const denyHosts = new Set((prefs.denyHosts ?? []).map((h) => h.toLowerCase()));

        // -------------------------------------------------------------
        // 2. Load the triggering page so we can compute the centroid
        //    and feed its tags into the prompt.
        // -------------------------------------------------------------
        const triggeringPage = (await Page.findOne({ _id: pageId, userId })
          .select('+embedding title summary contentMd tags topics categoryId')
          .lean()) as PageDoc | null;
        if (!triggeringPage) {
          await setResearchState(pageId, 'failed', {
            lastResearchError: 'page-not-found',
          });
          return { skipped: 'page-not-found' };
        }

        // -------------------------------------------------------------
        // 3. Topic centroid for relevance scoring.
        // -------------------------------------------------------------
        const centroid = await buildTopicCentroid(userId, topicLabel, triggeringPage);
        if (!centroid) {
          await setResearchState(pageId, 'failed', {
            lastResearchError: 'embedding-provider-unavailable',
          });
          return { skipped: 'no-embedding-provider' };
        }

        // -------------------------------------------------------------
        // 4. Query plan + SearXNG harvest. Seeds the priority frontier
        //    at depth 0; the loop in step 5 may push depth-1 entries
        //    onto the same frontier as it processes articles and
        //    harvests their in-body links.
        // -------------------------------------------------------------
        const deadline = t0 + timeoutMs;
        const queries = buildQueries(topicLabel);
        const seen = new Set<string>();
        type FrontierItem = {
          url: string;
          title: string;
          query: string | null;
          depth: number;
          parentUrl: string | null;
          /** Heuristic priority for ordering. Search seeds get a flat
           *  high priority (1.0); harvested links carry their
           *  link-time score so the most-promising recursion targets
           *  jump ahead in the queue. */
          priority: number;
          discoveredVia: 'searxng' | 'recursion';
        };
        const frontier: FrontierItem[] = [];
        for (const q of queries) {
          if (Date.now() >= deadline) break;
          const results = await searchUrls(q);
          for (const r of results) {
            if (frontier.length >= fetchBudget) break;
            if (!r.url || seen.has(r.url)) continue;
            const host = hostKeyOf(r.url);
            if (host && denyHosts.has(host)) continue;
            seen.add(r.url);
            frontier.push({
              url: r.url,
              title: r.title,
              query: q,
              depth: 0,
              parentUrl: null,
              priority: 1.0,
              discoveredVia: 'searxng',
            });
          }
          if (frontier.length >= fetchBudget) break;
        }
        if (frontier.length === 0) {
          await setResearchState(pageId, 'failed', {
            lastResearchError: 'no-search-results',
          });
          return { skipped: 'no-search-results' };
        }

        // -------------------------------------------------------------
        // 5. Drain the frontier — fetch, extract, embed, score, and
        //    optionally harvest links to recurse on. Pop highest-
        //    priority each iteration so depth-0 seeds drain first
        //    and high-scoring recursion candidates compete on merit.
        //    Persist every URL (even off-topic) so subsequent runs
        //    short-circuit on the cache.
        // -------------------------------------------------------------
        const provider = await resolveProviderForUser(userId, 'embedding');
        const fetched: {
          url: string;
          title: string;
          contentMd: string;
          hostKey: string;
          relevanceScore: number;
          /** Best-guess publication date — article meta first, HTTP
           *  Last-Modified second, fetchedAt last. Used to weight
           *  recency into the synthesis-corpus ranking so a "Iran"
           *  research run prefers this week's coverage over 2009
           *  background pieces with similar topical relevance. */
          publishedAt: Date | null;
          docId: Types.ObjectId;
        }[] = [];
        let processedCount = 0;
        while (frontier.length > 0) {
          if (Date.now() >= deadline) break;
          if (processedCount >= fetchBudget) break;

          // Pop the highest-priority frontier item. Sort each
          // iteration — frontier sizes stay tiny (≤ fetchBudget).
          frontier.sort((a, b) => b.priority - a.priority);
          const item = frontier.shift()!;
          processedCount += 1;
          const urlHash = urlHashOf(item.url);
          // Skip if we have a fresh cached copy.
          const cached = (await WebDocument.findOne({ userId, urlHash })
            .select('+embedding url title contentMd hostKey relevanceScore expiresAt etag lastModified offTopic')
            .lean()) as WebDocumentDoc | null;
          if (cached && cached.expiresAt && cached.expiresAt > new Date()) {
            // Still fresh; reuse without re-fetching.
            if (
              !cached.offTopic &&
              cached.contentMd &&
              cached.embedding &&
              (cached.embedding as number[]).length === centroid.vec.length
            ) {
              fetched.push({
                url: cached.url,
                title: cached.title,
                contentMd: cached.contentMd,
                hostKey: cached.hostKey,
                relevanceScore: cached.relevanceScore ?? 0,
                publishedAt: parsePublishedAt(cached.lastModified, cached.fetchedAt),
                docId: cached._id,
              });
            }
            continue;
          }

          const fetchT0 = Date.now();
          const result = await fetchOne(item.url, {
            etag: cached?.etag ?? null,
            lastModified: cached?.lastModified ?? null,
          });
          observe(METRIC.TOPIC_RESEARCH_FETCH_MS, Date.now() - fetchT0, {
            outcome: result.kind,
          });

          if (result.kind === 'not-modified' && cached) {
            // Body unchanged; bump the TTL and reuse.
            await WebDocument.updateOne(
              { _id: cached._id },
              {
                $set: {
                  expiresAt: new Date(Date.now() + 14 * 24 * 3600 * 1000),
                  fetchedAt: new Date(),
                },
              },
            );
            if (
              !cached.offTopic &&
              cached.contentMd &&
              cached.embedding &&
              (cached.embedding as number[]).length === centroid.vec.length
            ) {
              fetched.push({
                url: cached.url,
                title: cached.title,
                contentMd: cached.contentMd,
                hostKey: cached.hostKey,
                relevanceScore: cached.relevanceScore ?? 0,
                publishedAt: parsePublishedAt(cached.lastModified, cached.fetchedAt),
                docId: cached._id,
              });
            }
            continue;
          }

          if (result.kind === 'robots-disallowed') {
            inc(METRIC.TOPIC_RESEARCH_ROBOTS_BLOCKED, 1);
            // Persist a placeholder so we don't re-attempt.
            await WebDocument.updateOne(
              { userId, urlHash },
              {
                $setOnInsert: {
                  userId,
                  url: item.url,
                  urlHash,
                  hostKey: result.hostKey,
                  title: item.title,
                  topicLabel,
                  triggeringPageId: pageId,
                  searchQuery: item.query,
                  discoveredVia: item.discoveredVia,
                  fetchDepth: item.depth,
                  parentUrl: item.parentUrl,
                },
                $set: {
                  robotsAllowed: false,
                  fetchedAt: new Date(),
                  expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
                },
              },
              { upsert: true },
            );
            continue;
          }

          if (result.kind !== 'fetched') {
            logger.debug(
              { url: item.url, reason: (result as { reason?: string }).reason ?? result.kind },
              'topic-research: fetch skipped',
            );
            continue;
          }

          // Extract.
          const article = extractArticle(result.bodyHtml);
          if (!article || !article.contentMd) {
            // Persist as off-topic placeholder so we don't keep
            // re-fetching this URL on subsequent runs.
            await WebDocument.updateOne(
              { userId, urlHash },
              {
                $setOnInsert: {
                  userId,
                  url: result.finalUrl,
                  urlHash,
                  hostKey: result.hostKey,
                  topicLabel,
                  triggeringPageId: pageId,
                  searchQuery: item.query,
                  discoveredVia: item.discoveredVia,
                  fetchDepth: item.depth,
                  parentUrl: item.parentUrl,
                },
                $set: {
                  title: item.title,
                  fetchedAt: new Date(),
                  etag: result.etag ?? null,
                  lastModified: result.lastModified ?? null,
                  offTopic: true,
                  expiresAt: new Date(Date.now() + 14 * 24 * 3600 * 1000),
                },
              },
              { upsert: true },
            );
            continue;
          }

          // Embed + score.
          let embedding: number[];
          try {
            const text = `${article.title}\n${article.contentMd.slice(0, 8_000)}`;
            const embT0 = Date.now();
            embedding = await provider.provider.embed(provider.model, text);
            observe(METRIC.OLLAMA_EMBED_MS, Date.now() - embT0, {
              model: provider.model,
            });
          } catch (err) {
            logger.warn({ err, url: result.finalUrl }, 'topic-research: embed failed');
            continue;
          }
          const score = embedding.length === centroid.vec.length
            ? dot(toUnitFloat32(embedding), centroid.vec)
            : 0;
          const offTopic = score < topicThreshold;
          if (offTopic) inc(METRIC.TOPIC_RESEARCH_OFF_TOPIC, 1);

          const upsert = await WebDocument.findOneAndUpdate(
            { userId, urlHash },
            {
              $setOnInsert: {
                userId,
                url: result.finalUrl,
                urlHash,
                triggeringPageId: pageId,
                discoveredVia: item.discoveredVia,
                searchQuery: item.query,
                topicLabel,
                fetchDepth: item.depth,
                parentUrl: item.parentUrl,
              },
              $set: {
                hostKey: result.hostKey,
                title: article.title || item.title,
                contentMd: article.contentMd,
                contentHash: article.contentHash,
                fetchedAt: new Date(),
                expiresAt: new Date(Date.now() + 14 * 24 * 3600 * 1000),
                embedding,
                embeddingModel: `${provider.providerId}:${provider.model}`,
                etag: result.etag ?? null,
                lastModified: result.lastModified ?? null,
                relevanceScore: score,
                offTopic,
                robotsAllowed: true,
              },
            },
            { upsert: true, new: true },
          );

          if (!offTopic) {
            fetched.push({
              url: result.finalUrl,
              title: article.title || item.title,
              contentMd: article.contentMd,
              hostKey: result.hostKey,
              relevanceScore: score,
              publishedAt: parsePublishedAt(
                article.publishedAt ?? result.lastModified,
                result.fetchedAt,
              ),
              docId: upsert!._id as Types.ObjectId,
            });

            // Harvest in-body links and push promising ones onto the
            // frontier at depth+1. Bounded by the budget — if we're
            // already saturated, skip the harvest. The link scorer is
            // heuristic only; the real quality gate is the cosine
            // check after the next-hop fetch.
            if (
              item.depth < MAX_RECURSION_DEPTH &&
              processedCount + frontier.length < fetchBudget
            ) {
              const candidates = harvestLinks(
                result.bodyHtml,
                result.finalUrl,
                topicLabel,
                result.hostKey,
                seen,
              );
              for (const c of candidates) {
                if (processedCount + frontier.length >= fetchBudget) break;
                if (seen.has(c.url)) continue;
                const host = hostKeyOf(c.url);
                if (host && denyHosts.has(host)) continue;
                seen.add(c.url);
                frontier.push({
                  url: c.url,
                  title: c.anchorText.slice(0, 200),
                  query: null,
                  depth: item.depth + 1,
                  parentUrl: result.finalUrl,
                  // Recursed items get their link-time score as
                  // priority, capped under 1.0 so the search-seed
                  // frontier always drains first.
                  priority: Math.min(0.95, c.score),
                  discoveredVia: 'recursion',
                });
              }
            }
          }
        }

        if (fetched.length === 0) {
          await setResearchState(pageId, 'failed', {
            lastResearchError: 'no-on-topic-results',
          });
          return { skipped: 'no-on-topic-results' };
        }

        // Rank by relevance × recency, cap to synthesis budget.
        // Pure cosine relevance is preserved on the WebDocument row
        // (so the cache-display in Codex remains semantically stable);
        // this composite is a per-run ranking-only score.
        const ranked = fetched
          .map((d) => ({ doc: d, score: d.relevanceScore * recencyFactor(d.publishedAt) }))
          .sort((a, b) => b.score - a.score)
          .map((x) => x.doc);
        const synthesisDocs = ranked.slice(0, SYNTHESIS_DOC_CAP);

        // -------------------------------------------------------------
        // 6. Build the synthesis corpus.
        // -------------------------------------------------------------
        const userEmails = await loadUserEmails(userId, topicLabel);
        const internalPages = await loadInternalPages(userId, topicLabel, pageId);
        const { text: webDocsBlock, labels: webLabels } = renderWebDocs(synthesisDocs);

        const labeledEmails =
          userEmails.length > 0
            ? userEmails
                .map(
                  (e) =>
                    `[${e.label}] From: ${e.from} | ${e.date} | ${e.subject}\n"""\n${e.text}\n"""`,
                )
                .join('\n\n')
            : '(no recent mail referencing this topic)';
        const internalPagesBlock =
          internalPages.length > 0
            ? internalPages
                .map(
                  (p) =>
                    `[${p.label}] ${p.title} — ${p.summary} (tags: ${p.tags.join(', ') || 'none'})`,
                )
                .join('\n')
            : '(no prior internal pages on this topic)';
        const topicContext = userEmails[0]
          ? `Most recent email: from ${userEmails[0].from} on ${userEmails[0].date} — "${userEmails[0].subject}"`
          : `Topic surfaced from page "${triggeringPage.title ?? topicLabel}" (no triggering email).`;

        const categories = await Category.find({ userId }).select('name').lean();
        const counts = await Page.aggregate<{ _id: Types.ObjectId; n: number }>([
          { $match: { userId, categoryId: { $ne: null } } },
          { $group: { _id: '$categoryId', n: { $sum: 1 } } },
        ]);
        const countById = new Map(counts.map((c) => [String(c._id), c.n]));
        const categoriesBlock = categories.length
          ? categories
              .map(
                (c) =>
                  `${c.name as string}\t${countById.get(String(c._id)) ?? 0}`,
              )
              .join('\n')
          : '(none)';

        // -------------------------------------------------------------
        // 7. LLM synthesis.
        // -------------------------------------------------------------
        const template = await getSynthesisInstruction(userId);
        if (!template) {
          await setResearchState(pageId, 'failed', {
            lastResearchError: 'no-synthesis-instruction',
          });
          return { skipped: 'no-synthesis-instruction' };
        }
        const prompt = renderTemplate(template, {
          topic_label: topicLabel,
          topic_context: topicContext,
          labeled_emails: labeledEmails,
          internal_pages: internalPagesBlock,
          web_documents: webDocsBlock,
          existing_categories: categoriesBlock,
        });

        const gen = await resolveProviderForUser(userId, 'generation');
        let raw: string;
        try {
          raw = await gen.provider.generate({
            model: gen.model,
            prompt,
            system: SYSTEM_PROMPT_BASE,
            format: 'json',
            temperature: 0.3,
          });
        } catch (err) {
          await setResearchState(pageId, 'failed', {
            lastResearchError: `synthesis-failed: ${(err as Error).message}`,
          });
          throw err;
        }

        let draft;
        try {
          draft = PageGenerationDraft.parse(extractJson(raw));
        } catch (err) {
          logger.error({ err, raw }, 'topic-research: synthesis JSON invalid');
          await setResearchState(pageId, 'failed', {
            lastResearchError: 'synthesis-json-invalid',
          });
          throw new Error('synthesis returned invalid JSON');
        }

        // -------------------------------------------------------------
        // 8. Persist updated page. We rebuild externalSources from
        //    scratch each run — Phase 1 doesn't try to merge with
        //    prior research. Tags get the topic-label appended.
        // -------------------------------------------------------------
        const externalSources = webLabels.map((w) => ({
          label: w.label,
          title: w.title,
          url: w.url,
          adapter: 'web-research',
          fetchedAt: new Date(),
        }));
        const newTags = Array.from(
          new Set([...(draft.tags ?? []), topicLabel.toLowerCase()]),
        );

        await Page.updateOne(
          { _id: pageId, userId },
          {
            $set: {
              title: draft.title,
              summary: draft.summary,
              contentMd: draft.contentMd,
              tags: newTags,
              externalSources,
              webDocumentIds: synthesisDocs.map((d) => d.docId),
              researchState: 'idle',
              lastResearchedAt: new Date(),
              lastResearchError: null,
            },
          },
        );

        const elapsedMs = Date.now() - t0;
        logger.info(
          {
            userId: String(userId),
            pageId: String(pageId),
            topicLabel,
            fetched: fetched.length,
            kept: synthesisDocs.length,
            queries: queries.length,
            elapsedMs,
          },
          'topic-research: complete',
        );
        observe(METRIC.TOPIC_RESEARCH_DURATION_MS, elapsedMs);
        inc(METRIC.TOPIC_RESEARCH_FETCHES, fetched.length);
        inc(METRIC.TOPIC_RESEARCH_KEPT, synthesisDocs.length);

        return {
          ok: true,
          fetched: fetched.length,
          kept: synthesisDocs.length,
          elapsedMs,
        };
      } catch (err) {
        await setResearchState(pageId, 'failed', {
          lastResearchError: (err as Error).message,
        });
        throw err;
      }
    },
    {
      connection: bullConnection(),
      concurrency: 1,
      // Topic research can run minutes when fetching + synthesising.
      lockDuration: 10 * 60_000,
      stalledInterval: 60_000,
      maxStalledCount: 2,
    },
  );

  worker.on('failed', (job, err) =>
    logger.error(
      { err, jobId: job?.id, data: job?.data },
      'topic-research: job failed',
    ),
  );
}

export const TOPIC_RESEARCH_QUEUE = QUEUE;
