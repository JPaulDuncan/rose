import { Types } from 'mongoose';
import { Email, Page, type EmailDoc, type PageDoc } from '@rose/db';
import { resolveProviderForUser } from '../lib/providers.js';
import { logger } from '../lib/logger.js';

export type AssignmentMode = 'thread' | 'source-topic' | 'new';
export type Assignment =
  | { mode: 'thread'; page: PageDoc }
  | { mode: 'source-topic'; page: PageDoc; similarity: number }
  | { mode: 'new'; page: null };

const SOURCE_TOPIC_THRESHOLD = 0.78;

function cosine(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/**
 * Cache an embedding on the email document so retries don't re-pay for it.
 * Returns the vector + model tag, or null if the user has no embedding
 * provider configured (in which case we can still group by thread+sender).
 */
export async function ensureEmailEmbedding(
  email: EmailDoc,
): Promise<{ vec: number[]; model: string } | null> {
  if (email.embedding && email.embeddingModel) {
    return { vec: email.embedding as number[], model: email.embeddingModel };
  }
  try {
    const { provider, model } = await resolveProviderForUser(email.userId, 'embedding');
    if (!provider.supportsEmbeddings) return null;
    const text = `${email.subject ?? ''}\n${(email.text || email.rawText || '').slice(0, 8000)}`;
    const vec = await provider.embed(model, text);
    email.embedding = vec;
    email.embeddingModel = `${provider.id}:${model}`;
    await email.save();
    return { vec, model: email.embeddingModel };
  } catch (err) {
    logger.warn({ err, emailId: String(email._id) }, 'email embed failed (assignment will fall back to thread+sender)');
    return null;
  }
}

/**
 * Decide which Page a freshly-arrived email belongs to. The order is:
 *   1. Same threadKey as any existing page → that page (no LLM call needed).
 *   2. Same sender as an existing page AND topic centroid similarity ≥
 *      threshold → that page.
 *   3. Otherwise: returns { mode: 'new' } so the worker creates a new page.
 *
 * Picking is read-only — the caller is responsible for mutating the page.
 */
export async function findPageForEmail(email: EmailDoc): Promise<Assignment> {
  const userId = email.userId as Types.ObjectId;

  // 1. Thread match.
  if (email.threadKey) {
    const threadHit = await Page.findOne({
      userId,
      $or: [{ threadKeys: email.threadKey }, { threadKey: email.threadKey }],
    });
    if (threadHit) return { mode: 'thread', page: threadHit };
  }

  // 2. Source + topic similarity.
  const fromAddr = email.from?.address?.toLowerCase();
  if (!fromAddr) return { mode: 'new', page: null };

  const candidates = await Page.find({
    userId,
    senderAddresses: fromAddr,
  })
    .select('+topicCentroid')
    .limit(50);
  if (candidates.length === 0) return { mode: 'new', page: null };

  const emb = await ensureEmailEmbedding(email);
  // Without an embedding we can't decide topic similarity. Fall back: if
  // there's exactly one candidate page from this sender, use it; otherwise
  // start a new page rather than guess wrong.
  if (!emb) {
    if (candidates.length === 1)
      return { mode: 'source-topic', page: candidates[0]!, similarity: 0 };
    return { mode: 'new', page: null };
  }

  let best: { page: PageDoc; sim: number } | null = null;
  for (const c of candidates) {
    const centroid = c.topicCentroid as number[] | null | undefined;
    if (!centroid || centroid.length !== emb.vec.length) continue;
    const sim = cosine(centroid, emb.vec);
    if (!best || sim > best.sim) best = { page: c, sim };
  }
  if (best && best.sim >= SOURCE_TOPIC_THRESHOLD) {
    return { mode: 'source-topic', page: best.page, similarity: best.sim };
  }
  return { mode: 'new', page: null };
}

/** Average embeddings of every email currently on the page, ignoring missing vectors. */
export async function recomputeCentroid(page: PageDoc): Promise<number[] | null> {
  const ids = (page.sourceEmailIds ?? []) as Types.ObjectId[];
  if (!ids.length) return null;
  const emails = await Email.find({ _id: { $in: ids } })
    .select('+embedding embeddingModel')
    .lean();
  const vecs = emails
    .map((e) => e.embedding as number[] | null)
    .filter((v): v is number[] => Array.isArray(v) && v.length > 0);
  if (!vecs.length) return null;
  const dim = vecs[0]!.length;
  const out = new Array<number>(dim).fill(0);
  for (const v of vecs) {
    if (v.length !== dim) continue;
    for (let i = 0; i < dim; i++) out[i]! += v[i]!;
  }
  for (let i = 0; i < dim; i++) out[i] = (out[i] ?? 0) / vecs.length;
  return out;
}

export const ASSIGNMENT_THRESHOLD = SOURCE_TOPIC_THRESHOLD;
