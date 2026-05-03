import { Types } from 'mongoose';
import { Email, Page, type EmailDoc, type PageDoc } from '@rose/db';
import { resolveProviderForUser } from '../lib/providers.js';
import { logger } from '../lib/logger.js';

export type AssignmentMode =
  | 'thread'
  | 'source-template'
  | 'source-topic'
  | 'topic'
  | 'new';
export type Assignment =
  | { mode: 'thread'; page: PageDoc }
  | { mode: 'source-template'; page: PageDoc }
  | { mode: 'source-topic'; page: PageDoc; similarity: number }
  | { mode: 'topic'; page: PageDoc }
  | { mode: 'new'; page: null };

/** Default cosine threshold for source+topic clustering. */
const SOURCE_TOPIC_THRESHOLD = 0.78;
/** Lower threshold for "automated" senders whose templated content
 *  has lower variance and benefits from looser matching. */
const AUTOMATED_TOPIC_THRESHOLD = 0.65;

/**
 * Senders that are clearly automated notification streams. We match against
 * the local part of the address — `noreply@`, `notifications@`, `ci@`,
 * `actions@`, `alerts@`, etc.
 */
const AUTOMATED_LOCAL_RE =
  /^(no[-]?reply|noreply|notifications?|alerts?|reports?|ci|actions?|builds?|status|info|updates?|digest|newsletter|receipts?|billing|invoice|monitor|notify|mailer|hello|team)/i;

export function isAutomatedSender(addr: string | undefined | null): boolean {
  if (!addr) return false;
  const local = addr.split('@')[0] ?? '';
  return AUTOMATED_LOCAL_RE.test(local);
}

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
 * provider configured.
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
    logger.warn(
      { err, emailId: String(email._id) },
      'email embed failed (assignment will fall back to thread/template/sender)',
    );
    return null;
  }
}

/**
 * Decide which Page a freshly-arrived email belongs to. Tried in order:
 *   1. **Thread match** — any existing page lists this email's threadKey.
 *      Fast, exact, no LLM/embedding cost.
 *   2. **Subject template + sender** — a page from the same sender already
 *      has the same `subjectTemplate` (e.g. all GH Actions failures collapse
 *      here). Also fast, exact, no embedding cost. This is the path that
 *      catches the "I keep getting CI failure emails" case.
 *   3. **Sender + topic centroid** — same sender, embedding cosine ≥
 *      threshold (lower for automated senders).
 *   4. Otherwise: a new page is spawned.
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

  const fromAddr = email.from?.address?.toLowerCase();
  if (!fromAddr) return { mode: 'new', page: null };

  // 2. Subject template + sender match — exact, no embedding required.
  if (email.subjectTemplate) {
    const templateHit = await Page.findOne({
      userId,
      senderAddresses: fromAddr,
      subjectTemplates: email.subjectTemplate,
    });
    if (templateHit) return { mode: 'source-template', page: templateHit };
  }

  // 3. Sender + topic centroid similarity.
  const candidates = await Page.find({
    userId,
    senderAddresses: fromAddr,
  })
    .select('+topicCentroid')
    .limit(50);
  if (candidates.length === 0) return { mode: 'new', page: null };

  const automated = isAutomatedSender(fromAddr);
  const threshold = automated ? AUTOMATED_TOPIC_THRESHOLD : SOURCE_TOPIC_THRESHOLD;

  const emb = await ensureEmailEmbedding(email);
  // Without an embedding fall back to "single candidate from this sender" — but
  // *only* for non-automated senders. For automated senders the prior subject-
  // template path already had its chance; if we got here, the templates didn't
  // match and we shouldn't blindly merge into the wrong existing page.
  if (!emb) {
    if (!automated && candidates.length === 1)
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
  if (best && best.sim >= threshold) {
    return { mode: 'source-topic', page: best.page, similarity: best.sim };
  }
  return { mode: 'new', page: null };
}

/** Average embeddings of every email currently on the page, ignoring missing vectors. */
export async function recomputeCentroid(page: PageDoc): Promise<number[] | null> {
  const ids = (page.sourceEmailIds ?? []) as Types.ObjectId[];
  if (!ids.length) return null;
  const emails = await Email.find({ _id: { $in: ids } })
    .select('+embedding')
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

/**
 * Topic-mode assignment for items where sender/thread grouping doesn't
 * fit (currently RSS feeds — every item is from the "feed" identity, so
 * grouping by sender would just collapse the whole feed into one page).
 *
 * Strategy:
 *   1. Pick the highest-weighted topic on the email (`topics[0]`) as the
 *      primary topic.
 *   2. Look up an existing page with `groupingMode: 'topic'` and that
 *      `primaryTopic`. Hit → assign there.
 *   3. Otherwise look for any topic-mode page whose `tags` or `topics`
 *      already contain the primary topic — handles the case where the
 *      user (or a previous LLM run) renamed the page.
 *   4. Otherwise return `new` so the generator creates a fresh topic page.
 */
export async function findTopicPageForItem(email: EmailDoc): Promise<Assignment> {
  const userId = email.userId as Types.ObjectId;
  const topics = (email.topics as string[] | undefined) ?? [];
  if (!topics.length) return { mode: 'new', page: null };
  const primary = topics[0]!.toLowerCase();

  const direct = await Page.findOne({ userId, groupingMode: 'topic', primaryTopic: primary });
  if (direct) return { mode: 'topic', page: direct };

  const fuzzy = await Page.findOne({
    userId,
    groupingMode: 'topic',
    $or: [{ tags: primary }, { topics: primary }],
  });
  if (fuzzy) return { mode: 'topic', page: fuzzy };

  return { mode: 'new', page: null };
}

export {
  SOURCE_TOPIC_THRESHOLD as ASSIGNMENT_THRESHOLD,
  AUTOMATED_TOPIC_THRESHOLD,
};
