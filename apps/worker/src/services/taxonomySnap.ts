import { Types } from 'mongoose';
import { Page, Category } from '@rose/db';
import { resolveProviderForUser } from '../lib/providers.js';
import { dot, meanVec, toUnitFloat32 } from '../lib/vec.js';
import { logger } from '../lib/logger.js';

/**
 * Embedding-driven categorization + tag snapping.
 *
 * Two passes wrap the LLM call in `generatePage`:
 *
 *   1. **Pre-pass** — given the trigger email's embedding, find the
 *      user's most-similar existing tags + categories and pass them
 *      to the LLM as preferred candidates. Biases the model toward
 *      the established vocabulary so it stops minting "crypto" when
 *      the user already has "cryptocurrency".
 *
 *   2. **Post-pass** — for each tag the LLM emits that doesn't
 *      exactly match the existing vocabulary, embed the tag string
 *      and snap to the nearest existing tag if cosine ≥ a high
 *      threshold. Same idea for the LLM's `suggestedCategory`.
 *
 * Centroids are derived on the fly from `Page.tags` + `Page.embedding`
 * (the tag's centroid is the mean of its pages' embeddings) and
 * `Page.categoryId` for categories. No new collection: we already
 * pay to embed pages for hybrid search, this is just a second use
 * of those vectors.
 *
 * Cached per-user with a short TTL so a burst of ingest jobs doesn't
 * re-aggregate the user's pages on every call.
 */

/**
 * In-snapshot centroid: a unit-length Float32Array (so the per-
 * candidate scoring loop is a plain dot product rather than a
 * full cosine), plus the page count that contributed to it. The
 * Float32 form halves memory vs the boxed-double `number[]` shape
 * Mongo handed back, and pre-normalisation removes one Math.sqrt
 * per scoring call.
 */
type Centroid = { vec: Float32Array; count: number };
type Snapshot = {
  tagCentroids: Map<string, Centroid>;
  categoryCentroids: Map<string, Centroid>;
  /** Canonical-display lookup, since the centroid map is keyed on
   *  lowercase form. "AI" lowercases to "ai" but we want the user's
   *  original casing to win when we surface a hint. */
  tagDisplay: Map<string, string>;
  categoryDisplay: Map<string, string>;
  expiresAt: number;
};

const CACHE_TTL_MS = 60_000;
const CACHE = new Map<string, Snapshot>();

async function buildSnapshot(userId: Types.ObjectId): Promise<Snapshot> {
  // Pull every page that has an embedding. Project just the fields we
  // need so a user with thousands of pages doesn't ship megabytes of
  // contentMd into the worker process.
  const pages = (await Page.find({ userId })
    .select('+embedding tags categoryId')
    .lean()) as Array<{
    embedding?: number[] | null;
    tags?: string[];
    categoryId?: Types.ObjectId | null;
  }>;
  const tagBuckets = new Map<string, number[][]>();
  const categoryBuckets = new Map<string, number[][]>();
  const tagDisplay = new Map<string, string>();
  for (const p of pages) {
    const emb = p.embedding;
    if (!emb || !emb.length) continue;
    for (const t of p.tags ?? []) {
      const key = t.toLowerCase().trim();
      if (!key) continue;
      if (!tagDisplay.has(key)) tagDisplay.set(key, t);
      const arr = tagBuckets.get(key) ?? [];
      arr.push(emb);
      tagBuckets.set(key, arr);
    }
    if (p.categoryId) {
      const key = String(p.categoryId);
      const arr = categoryBuckets.get(key) ?? [];
      arr.push(emb);
      categoryBuckets.set(key, arr);
    }
  }

  const tagCentroids = new Map<string, Centroid>();
  for (const [key, vecs] of tagBuckets) {
    const m = meanVec(vecs);
    if (m) tagCentroids.set(key, { vec: toUnitFloat32(m), count: vecs.length });
  }

  // Resolve categoryId → display name in one round trip.
  const categoryIds = [...categoryBuckets.keys()].map((id) => new Types.ObjectId(id));
  const categories = categoryIds.length
    ? await Category.find({ userId, _id: { $in: categoryIds } })
        .select('name')
        .lean()
    : [];
  const categoryDisplay = new Map<string, string>();
  const categoryCentroids = new Map<string, Centroid>();
  for (const cat of categories) {
    const id = String(cat._id);
    const display = (cat.name as string | undefined) ?? '';
    const lower = display.toLowerCase();
    const vecs = categoryBuckets.get(id) ?? [];
    const m = meanVec(vecs);
    if (m && lower) {
      categoryCentroids.set(lower, { vec: toUnitFloat32(m), count: vecs.length });
      categoryDisplay.set(lower, display);
    }
  }

  return {
    tagCentroids,
    categoryCentroids,
    tagDisplay,
    categoryDisplay,
    expiresAt: Date.now() + CACHE_TTL_MS,
  };
}

async function getSnapshot(userId: Types.ObjectId): Promise<Snapshot> {
  const key = String(userId);
  const cached = CACHE.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached;
  const snap = await buildSnapshot(userId);
  CACHE.set(key, snap);
  return snap;
}

export type SnapHint = { display: string; score: number; count: number };

/**
 * Pre-generate pass: pick the top-N nearest tags + categories to the
 * trigger email's embedding. Used to bias the LLM prompt toward the
 * existing vocabulary.
 *
 * Returns empty arrays if the user has no embedded pages yet (cold
 * start) — caller falls back to the LLM emitting fresh suggestions.
 */
export async function suggestTaxonomy(
  userId: Types.ObjectId,
  emailVec: number[],
  opts: {
    maxTags?: number;
    maxCategories?: number;
    tagThreshold?: number;
    categoryThreshold?: number;
  } = {},
): Promise<{ tags: SnapHint[]; categories: SnapHint[] }> {
  if (!emailVec.length) return { tags: [], categories: [] };
  const snap = await getSnapshot(userId);
  const { maxTags = 30, maxCategories = 3, tagThreshold = 0.55, categoryThreshold = 0.55 } = opts;

  // Pre-normalise the query once. Centroids are already unit-length
  // Float32Arrays from `buildSnapshot`, so per-candidate scoring is
  // a plain dot product — no Math.sqrt per call.
  const q = toUnitFloat32(emailVec);

  const tagScored: SnapHint[] = [];
  for (const [key, centroid] of snap.tagCentroids) {
    if (centroid.vec.length !== q.length) continue;
    const score = dot(q, centroid.vec);
    if (score >= tagThreshold) {
      tagScored.push({
        display: snap.tagDisplay.get(key) ?? key,
        score,
        count: centroid.count,
      });
    }
  }
  tagScored.sort((a, b) => b.score - a.score);

  const catScored: SnapHint[] = [];
  for (const [key, centroid] of snap.categoryCentroids) {
    if (centroid.vec.length !== q.length) continue;
    const score = dot(q, centroid.vec);
    if (score >= categoryThreshold) {
      catScored.push({
        display: snap.categoryDisplay.get(key) ?? key,
        score,
        count: centroid.count,
      });
    }
  }
  catScored.sort((a, b) => b.score - a.score);

  return {
    tags: tagScored.slice(0, maxTags),
    categories: catScored.slice(0, maxCategories),
  };
}

/**
 * Post-generate pass: snap each LLM-emitted tag onto an existing
 * vocabulary entry when the embedding is close enough. Tags that
 * already exist (case-insensitive) are returned as their canonical
 * display form. Unknown tags are embedded once and compared to every
 * existing tag centroid; if the best match clears `threshold`,
 * the tag is rewritten. Otherwise it stays as-is and seeds a new
 * vocabulary entry once the page commits.
 */
export async function snapTagsByEmbedding(
  userId: Types.ObjectId,
  rawTags: string[],
  threshold = 0.85,
): Promise<string[]> {
  if (rawTags.length === 0) return rawTags;
  const snap = await getSnapshot(userId);
  if (snap.tagCentroids.size === 0) return rawTags;

  // Tags that already round-trip are returned as their canonical
  // display form so casing/punctuation stays consistent across pages.
  const out: string[] = [];
  const novel: string[] = [];
  for (const t of rawTags) {
    const key = t.toLowerCase().trim();
    if (!key) continue;
    if (snap.tagCentroids.has(key)) {
      out.push(snap.tagDisplay.get(key) ?? t);
    } else {
      novel.push(t);
    }
  }
  if (novel.length === 0) return dedup(out);

  // Embed novel tags in one batch — Ollama's embeddings endpoint is
  // single-input, so we still loop, but we share one provider handle.
  let provider: Awaited<ReturnType<typeof resolveProviderForUser>> | null = null;
  try {
    provider = await resolveProviderForUser(userId, 'embedding');
  } catch (err) {
    logger.warn({ err }, 'taxonomy-snap: no embedding provider; passing tags through');
    return dedup([...out, ...novel]);
  }
  if (!provider.provider.supportsEmbeddings) {
    return dedup([...out, ...novel]);
  }
  for (const t of novel) {
    let raw: number[];
    try {
      raw = await provider.provider.embed(provider.model, t);
    } catch (err) {
      logger.warn({ err, tag: t }, 'taxonomy-snap: tag embed failed; keeping novel');
      out.push(t);
      continue;
    }
    const q = toUnitFloat32(raw);
    let best: { key: string; score: number } | null = null;
    for (const [key, centroid] of snap.tagCentroids) {
      if (centroid.vec.length !== q.length) continue;
      const score = dot(q, centroid.vec);
      if (!best || score > best.score) best = { key, score };
    }
    if (best && best.score >= threshold) {
      out.push(snap.tagDisplay.get(best.key) ?? best.key);
    } else {
      out.push(t);
    }
  }
  return dedup(out);
}

/**
 * Post-generate pass for the category. If the LLM invented a name
 * that's semantically near an existing category, prefer the existing
 * one — same intent as `canonicalizeTags`. Returns the input
 * unchanged when no good match exists or when the user has no
 * embedded pages yet.
 */
export async function snapCategoryByEmbedding(
  userId: Types.ObjectId,
  raw: string | null | undefined,
  threshold = 0.85,
): Promise<string | null> {
  const name = (raw ?? '').trim();
  if (!name) return null;
  const snap = await getSnapshot(userId);
  const lower = name.toLowerCase();
  if (snap.categoryCentroids.has(lower)) {
    return snap.categoryDisplay.get(lower) ?? name;
  }
  if (snap.categoryCentroids.size === 0) return name;
  let provider: Awaited<ReturnType<typeof resolveProviderForUser>> | null = null;
  try {
    provider = await resolveProviderForUser(userId, 'embedding');
  } catch {
    return name;
  }
  if (!provider.provider.supportsEmbeddings) return name;
  let embedded: number[];
  try {
    embedded = await provider.provider.embed(provider.model, name);
  } catch {
    return name;
  }
  const q = toUnitFloat32(embedded);
  let best: { key: string; score: number } | null = null;
  for (const [key, centroid] of snap.categoryCentroids) {
    if (centroid.vec.length !== q.length) continue;
    const score = dot(q, centroid.vec);
    if (!best || score > best.score) best = { key, score };
  }
  if (best && best.score >= threshold) {
    return snap.categoryDisplay.get(best.key) ?? best.key;
  }
  return name;
}

function dedup(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tags) {
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/** Test-only / hot-reload escape hatch. The cache is per-process and
 *  TTL-bounded, but unit tests want a clean slate. */
export function clearTaxonomySnapCache(): void {
  CACHE.clear();
}
