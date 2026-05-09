import { Types } from 'mongoose';
import { LibraryDocument, LibraryDocumentRef } from '@rose/db';
import type { AdapterContext, DaydreamAdapter, DaydreamSnippet } from '@rose/llm';
import { resolveProviderForUser } from '../providers.js';
import { logger } from '../logger.js';

/**
 * Cosine similarity between two equal-length numeric vectors. Same
 * shape as the existing search-page hybrid retriever uses for the
 * non-Atlas fallback.
 */
function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * RRF (Reciprocal Rank Fusion) — same algorithm the wiki search uses
 * to fuse text and vector hits. k=60 is the standard constant.
 */
function rrfFuse<T extends { _id: Types.ObjectId | string }>(
  textRanked: T[],
  vecRanked: T[],
  k = 60,
): T[] {
  const score = new Map<string, { item: T; score: number }>();
  const bump = (arr: T[], _w: number) => {
    arr.forEach((item, idx) => {
      const id = String(item._id);
      const s = 1 / (k + idx + 1);
      const cur = score.get(id);
      if (cur) cur.score += s;
      else score.set(id, { item, score: s });
    });
  };
  bump(textRanked, 1);
  bump(vecRanked, 1);
  return [...score.values()]
    .sort((a, b) => b.score - a.score)
    .map((s) => s.item);
}

/**
 * LibraryAdapter — hybrid search over the user's curated corpus.
 * Text-search (Mongo $text) + cosine over the embedding (computed
 * app-side; we don't depend on Atlas $vectorSearch). Top hits are
 * fused with RRF and returned as snippets. The body text is trimmed
 * to 4 KB per snippet so the synthesis prompt stays bounded.
 *
 * Per-call constructed because it needs the user's ObjectId AND
 * the user's embedding provider — both are per-user runtime state.
 */
export class LibraryAdapter implements DaydreamAdapter {
  readonly id = 'library';
  readonly label = 'Your library';
  readonly enabledByDefault = false;

  constructor(private readonly userId: Types.ObjectId) {}

  async fetch(query: string, ctx: AdapterContext): Promise<DaydreamSnippet[]> {
    void ctx;
    // Library is global; this adapter must only surface docs the
    // user has a Ref for. Fetch the user's visible doc IDs once
    // and gate both branches on that set.
    const refs = await LibraryDocumentRef.find({
      userId: this.userId,
      archivedAt: null,
    })
      .select('documentId')
      .limit(5_000)
      .lean();
    const visibleIds = refs.map((r) => r.documentId as Types.ObjectId);
    if (visibleIds.length === 0) return [];

    // Text branch.
    const textHits = await LibraryDocument.find({
      _id: { $in: visibleIds },
      $text: { $search: query },
    })
      .sort({ score: { $meta: 'textScore' } })
      .limit(10)
      .select('_id title summary bodyText url tags topics publishedAt')
      .lean();

    // Vector branch — embed the query, fetch up to 200 candidate
    // docs (with embeddings), cosine-rank top 10. App-side is the
    // self-hosted-Mongo fallback path documented in plan 04.
    let vecHits: typeof textHits = [];
    try {
      const r = await resolveProviderForUser(this.userId, 'embedding');
      if (r.provider.supportsEmbeddings) {
        const qVec = await r.provider.embed(r.model, query);
        const candidates = await LibraryDocument.find({
          _id: { $in: visibleIds },
          embedding: { $ne: null },
        })
          .select('+embedding _id title summary bodyText url tags topics publishedAt')
          .limit(200)
          .lean();
        const ranked = candidates
          .map((d) => ({
            doc: d as typeof candidates[number] & { embedding?: number[] },
            score: cosine(qVec, (d as { embedding?: number[] }).embedding ?? []),
          }))
          .sort((a, b) => b.score - a.score)
          .slice(0, 10);
        vecHits = ranked.map((r) => {
          const { embedding: _e, ...rest } = r.doc as typeof r.doc & {
            embedding?: number[];
          };
          return rest as typeof textHits[number];
        });
      }
    } catch (err) {
      logger.debug(
        { err: (err as Error).message },
        'library-adapter: vector branch failed (text-only)',
      );
    }

    const fused = rrfFuse(textHits, vecHits).slice(0, 3);
    return fused.map((doc) => {
      const body = (doc.bodyText ?? '').trim();
      const trimmed = body.length > 4000 ? `${body.slice(0, 4000)}…` : body;
      const lines: string[] = [];
      if (doc.title) lines.push(doc.title);
      if (doc.summary && doc.summary !== doc.title) {
        lines.push('');
        lines.push(doc.summary);
      }
      if (trimmed) {
        lines.push('');
        lines.push(trimmed);
      }
      return {
        title: doc.title || doc.url,
        url: doc.url,
        content: lines.join('\n'),
        // Library snippets are weighted lower than authoritative
        // sources by default — they're high-relevance to the user
        // but lower-authority for "encyclopedic" claims. Cap at 0.65
        // so a Wikipedia/Wikidata snippet outranks them on the same
        // subject.
        confidence: 0.55,
        fetchedAt: new Date(),
      };
    });
  }
}
