import { Types } from 'mongoose';
import { Page } from '@rose/db';
import type { SearchHit, SearchRequest } from '@rose/shared';
import { resolveProviderForUser } from '../lib/providers.js';

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function snippet(content: string, q: string, len = 220): string {
  if (!content) return '';
  const lower = content.toLowerCase();
  const ix = lower.indexOf(q.toLowerCase().split(/\s+/)[0] ?? '');
  const start = Math.max(0, ix - 60);
  return content.slice(start, start + len).replace(/\s+/g, ' ').trim();
}

type Hit = SearchHit & { _textRank?: number; _semRank?: number };

export async function searchPages(
  userId: Types.ObjectId,
  req: SearchRequest,
): Promise<{ hits: SearchHit[]; totalText: number; totalSemantic: number; tookMs: number }> {
  const start = Date.now();
  const filter: Record<string, unknown> = { userId };
  if (req.tags?.length) filter.tags = { $in: req.tags };
  if (req.categoryId) filter.categoryId = new Types.ObjectId(req.categoryId);
  if (req.from || req.to) {
    filter.updatedAt = {
      ...(req.from ? { $gte: new Date(req.from) } : {}),
      ...(req.to ? { $lte: new Date(req.to) } : {}),
    };
  }

  const textHitsP =
    req.mode === 'semantic'
      ? Promise.resolve([] as Array<Hit>)
      : Page.find(
          { ...filter, $text: { $search: req.q } },
          { score: { $meta: 'textScore' }, embedding: 0 },
        )
          .sort({ score: { $meta: 'textScore' } })
          .limit(50)
          .lean()
          .then((docs) =>
            docs.map<Hit>((d, i) => ({
              pageId: String(d._id),
              slug: d.slug as string,
              title: d.title as string,
              summary: (d.summary as string) ?? '',
              snippet: snippet((d.contentMd as string) ?? '', req.q),
              score: 0,
              matchedBy: ['text'],
              tags: (d.tags as string[]) ?? [],
              updatedAt: (d.updatedAt as Date).toISOString(),
              _textRank: i + 1,
            })),
          );

  const semHitsP =
    req.mode === 'text'
      ? Promise.resolve([] as Array<Hit>)
      : (async () => {
          // Resolve the user's embedding provider, then run with a hard
          // timeout so a slow backend doesn't block hybrid search.
          let qVec: number[];
          let embedTag: string;
          try {
            const { provider, model } = await resolveProviderForUser(userId, 'embedding');
            if (!provider.supportsEmbeddings) return [];
            embedTag = `${provider.id}:${model}`;
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 4000);
            try {
              qVec = await provider.embed(model, req.q, ctrl.signal);
            } finally {
              clearTimeout(timer);
            }
          } catch {
            return [];
          }
          // Only compare vectors produced by the same provider:model pair —
          // different embedding spaces are not commensurable.
          const candidates = await Page.find({
            ...filter,
            embedding: { $ne: null },
            embeddingModel: embedTag,
          })
            .select('+embedding')
            .lean();
          const scored = candidates
            .map((d) => ({
              doc: d,
              score: cosine(qVec, (d.embedding as number[] | null) ?? []),
            }))
            .sort((a, b) => b.score - a.score)
            .slice(0, 50);
          return scored.map<Hit>((s, i) => ({
            pageId: String(s.doc._id),
            slug: s.doc.slug as string,
            title: s.doc.title as string,
            summary: (s.doc.summary as string) ?? '',
            snippet: snippet((s.doc.contentMd as string) ?? '', req.q),
            score: s.score,
            matchedBy: ['semantic'],
            tags: (s.doc.tags as string[]) ?? [],
            updatedAt: (s.doc.updatedAt as Date).toISOString(),
            _semRank: i + 1,
          }));
        })();

  const [textHits, semHits] = await Promise.all([textHitsP, semHitsP]);

  // Reciprocal Rank Fusion
  const k = 60;
  const map = new Map<string, Hit>();
  for (const h of textHits) {
    const prior = map.get(h.pageId);
    const rrf = 1 / (k + (h._textRank ?? 1));
    if (prior) {
      prior.score += rrf;
      prior.matchedBy = Array.from(new Set([...prior.matchedBy, ...h.matchedBy]));
    } else {
      map.set(h.pageId, { ...h, score: rrf });
    }
  }
  for (const h of semHits) {
    const prior = map.get(h.pageId);
    const rrf = 1 / (k + (h._semRank ?? 1));
    if (prior) {
      prior.score += rrf;
      prior.matchedBy = Array.from(new Set([...prior.matchedBy, ...h.matchedBy]));
    } else {
      map.set(h.pageId, { ...h, score: rrf });
    }
  }

  const hits = [...map.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, req.limit)
    .map(({ _semRank, _textRank, ...h }) => h);

  return {
    hits,
    totalText: textHits.length,
    totalSemantic: semHits.length,
    tookMs: Date.now() - start,
  };
}
