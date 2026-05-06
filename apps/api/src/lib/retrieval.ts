import { Types } from 'mongoose';
import { Page, type PageDoc } from '@rose/db';
import { resolveProviderForUser } from './providers.js';
import { logger } from './logger.js';

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

const STOP = new Set(['the', 'and', 'for', 'are', 'but', 'you', 'with', 'this', 'that', 'how', 'what', 'when', 'where']);

export function queryTokens(q: string): string[] {
  return [
    ...new Set(
      q
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 3 && !STOP.has(t)),
    ),
  ];
}

/** Pick a contentLen-character window centered on the most relevant
 *  paragraph. The paragraph with the most query-token hits wins; we
 *  expand outward from there until we hit the budget. */
export function bestWindow(content: string, tokens: string[], targetLen = 1500): string {
  if (!content) return '';
  if (content.length <= targetLen) return content;
  const paras = content.split(/\n{2,}/);
  let bestIdx = 0;
  let bestScore = 0;
  paras.forEach((p, i) => {
    const lower = p.toLowerCase();
    let s = 0;
    for (const t of tokens) {
      if (lower.includes(t)) s += 1;
    }
    if (s > bestScore) {
      bestScore = s;
      bestIdx = i;
    }
  });
  let start = bestIdx;
  let end = bestIdx;
  let len = paras[bestIdx]?.length ?? 0;
  while (len < targetLen && (start > 0 || end < paras.length - 1)) {
    if (start > 0) {
      start -= 1;
      len += (paras[start]?.length ?? 0) + 2;
      if (len >= targetLen) break;
    }
    if (end < paras.length - 1) {
      end += 1;
      len += (paras[end]?.length ?? 0) + 2;
    }
  }
  return paras.slice(start, end + 1).join('\n\n').slice(0, targetLen + 200);
}

export type Hit = {
  doc: PageDoc;
  score: number;
  matchedBy: string[];
  textRank?: number;
  semRank?: number;
};

/**
 * Hybrid retrieval — Mongo $text + per-user embedding kNN, fused with
 * Reciprocal Rank Fusion (k=60). Excludes spam / quarantined pages by
 * default; pass `{ includeAll: true }` to include them.
 */
export async function retrievePages(
  userId: Types.ObjectId,
  query: string,
  opts: { limit?: number; excludePageId?: Types.ObjectId; includeAll?: boolean } = {},
): Promise<Hit[]> {
  const limit = opts.limit ?? 12;
  const filter: Record<string, unknown> = { userId };
  if (!opts.includeAll) {
    filter['flags.userMarkedSpam'] = { $ne: true };
    filter['flags.autoQuarantined'] = { $ne: true };
  }
  if (opts.excludePageId) filter._id = { $ne: opts.excludePageId };

  const textHits = (await Page.find({ ...filter, $text: { $search: query } })
    .select('+contentMd')
    .limit(40)
    .lean()) as unknown as PageDoc[];

  let semHits: { doc: PageDoc; score: number }[] = [];
  try {
    const { provider, model } = await resolveProviderForUser(userId, 'embedding');
    if (provider.supportsEmbeddings) {
      const tag = `${provider.id}:${model}`;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 4000);
      let qVec: number[];
      try {
        qVec = await provider.embed(model, query, ctrl.signal);
      } finally {
        clearTimeout(timer);
      }
      const candidates = (await Page.find({
        ...filter,
        embedding: { $ne: null },
        embeddingModel: tag,
      })
        .select('+embedding +contentMd')
        .lean()) as unknown as (PageDoc & { embedding: number[] })[];
      semHits = candidates
        .map((doc) => ({ doc, score: cosine(qVec, doc.embedding as number[]) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 40);
    }
  } catch (err) {
    logger.warn({ err }, 'retrieval: embedding leg failed; text-only fallback');
  }

  const k = 60;
  const fused = new Map<string, Hit>();
  textHits.forEach((doc, i) => {
    fused.set(String(doc._id), {
      doc,
      score: 1 / (k + (i + 1)),
      matchedBy: ['text'],
      textRank: i + 1,
    });
  });
  semHits.forEach(({ doc }, i) => {
    const id = String(doc._id);
    const prev = fused.get(id);
    const rrf = 1 / (k + (i + 1));
    if (prev) {
      prev.score += rrf;
      prev.matchedBy.push('semantic');
      prev.semRank = i + 1;
    } else {
      fused.set(id, { doc, score: rrf, matchedBy: ['semantic'], semRank: i + 1 });
    }
  });
  return [...fused.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Render the retrieved windows as a labeled prompt block + the
 *  citation map ({pN: …}). */
export function renderContextBlock(
  hits: Hit[],
  q: string,
): {
  text: string;
  citations: Record<string, { pageId: string; slug: string; title: string; score: number }>;
} {
  const tokens = queryTokens(q);
  const blocks: string[] = [];
  const citations: Record<string, { pageId: string; slug: string; title: string; score: number }> = {};
  hits.forEach((h, i) => {
    const label = `p${i + 1}`;
    const window = bestWindow((h.doc.contentMd as string) ?? '', tokens);
    citations[label] = {
      pageId: String(h.doc._id),
      slug: h.doc.slug,
      title: h.doc.title,
      score: Number(h.score.toFixed(4)),
    };
    blocks.push(
      `[${label}] "${h.doc.title}"\n` +
        (h.doc.summary ? `Summary: ${h.doc.summary}\n` : '') +
        `"""\n${window.trim()}\n"""`,
    );
  });
  return { text: blocks.join('\n\n'), citations };
}
