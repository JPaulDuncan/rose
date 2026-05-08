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

/** Max characters of each web doc fed into the synthesis prompt.
 *  Real article body can be much longer; the synthesis only needs
 *  enough prose to extract claims + quotes. */
const SYNTHESIS_DOC_SLICE = 4_000;

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
function buildQueries(topicLabel: string): string[] {
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
    scope: 'synthesise',
    isDefault: true,
  })
    .select('template')
    .lean();
  if (userOverride?.template) return userOverride.template;
  const system = await Instruction.findOne({
    userId,
    scope: 'synthesise',
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
        // 4. Query plan + SearXNG harvest. Dedup URLs across queries.
        // -------------------------------------------------------------
        const deadline = t0 + timeoutMs;
        const queries = buildQueries(topicLabel);
        const seen = new Set<string>();
        const frontier: { url: string; title: string; query: string }[] = [];
        for (const q of queries) {
          if (Date.now() >= deadline) break;
          const results = await searchUrls(q);
          for (const r of results) {
            if (frontier.length >= fetchBudget) break;
            if (!r.url || seen.has(r.url)) continue;
            const host = hostKeyOf(r.url);
            if (host && denyHosts.has(host)) continue;
            seen.add(r.url);
            frontier.push({ url: r.url, title: r.title, query: q });
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
        // 5. Fetch + extract + embed + score. Persist a WebDocument
        //    row regardless of relevance so the cache works on the
        //    next run.
        // -------------------------------------------------------------
        const provider = await resolveProviderForUser(userId, 'embedding');
        const fetched: {
          url: string;
          title: string;
          contentMd: string;
          hostKey: string;
          relevanceScore: number;
          docId: Types.ObjectId;
        }[] = [];
        for (const item of frontier) {
          if (Date.now() >= deadline) break;
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
                docId: cached._id,
              });
            }
            continue;
          }

          const result = await fetchOne(item.url, {
            etag: cached?.etag ?? null,
            lastModified: cached?.lastModified ?? null,
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
                docId: cached._id,
              });
            }
            continue;
          }

          if (result.kind === 'robots-disallowed') {
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
                  discoveredVia: 'searxng',
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
                  discoveredVia: 'searxng',
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
            embedding = await provider.provider.embed(provider.model, text);
          } catch (err) {
            logger.warn({ err, url: result.finalUrl }, 'topic-research: embed failed');
            continue;
          }
          const score = embedding.length === centroid.vec.length
            ? dot(toUnitFloat32(embedding), centroid.vec)
            : 0;
          const offTopic = score < topicThreshold;

          const upsert = await WebDocument.findOneAndUpdate(
            { userId, urlHash },
            {
              $setOnInsert: {
                userId,
                url: result.finalUrl,
                urlHash,
                triggeringPageId: pageId,
                discoveredVia: 'searxng',
                searchQuery: item.query,
                topicLabel,
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
              docId: upsert!._id as Types.ObjectId,
            });
          }
        }

        if (fetched.length === 0) {
          await setResearchState(pageId, 'failed', {
            lastResearchError: 'no-on-topic-results',
          });
          return { skipped: 'no-on-topic-results' };
        }

        // Sort by relevance, cap to synthesis budget.
        fetched.sort((a, b) => b.relevanceScore - a.relevanceScore);
        const synthesisDocs = fetched.slice(0, SYNTHESIS_DOC_CAP);

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
