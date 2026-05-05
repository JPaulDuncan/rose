import { z } from 'zod';
import { webFetchJson } from '../web/index.js';
import type { AdapterContext, DaydreamAdapter, DaydreamSnippet } from './types.js';

const UA = 'Rose/1.0 (+https://rose.local; daydream)';

const HnHit = z.object({
  objectID: z.string(),
  title: z.string().nullable().optional(),
  story_text: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
  author: z.string().nullable().optional(),
  points: z.number().nullable().optional(),
  num_comments: z.number().nullable().optional(),
  created_at: z.string().nullable().optional(),
});

const HnResponse = z.object({
  hits: z.array(HnHit).optional(),
});

/**
 * Hacker News (Algolia) adapter — discussion + commentary across HN's
 * full archive. Free, no key. Useful for "what did the technical
 * community say about X" queries that don't have encyclopedic
 * answers. Returns top story-tagged hits sorted by relevance.
 */
export class HackerNewsAdapter implements DaydreamAdapter {
  readonly id = 'hackernews';
  readonly label = 'Hacker News';
  readonly enabledByDefault = false;

  async fetch(query: string, ctx: AdapterContext): Promise<DaydreamSnippet[]> {
    const cache = (ctx.options?.cache as
      | import('../web/index.js').WebFetchCache
      | undefined) ?? undefined;
    const url =
      `https://hn.algolia.com/api/v1/search` +
      `?query=${encodeURIComponent(query)}` +
      `&tags=story&hitsPerPage=3`;

    const json = await webFetchJson(url, {
      userAgent: UA,
      timeoutMs: ctx.timeoutMs,
      cache,
      cacheTtlSec: 60 * 60 * 24 * 7,
      caller: 'daydream.hackernews',
      schema: HnResponse,
    });
    const hits = json?.hits ?? [];
    if (hits.length === 0) return [];

    return hits.slice(0, 2).map((h) => {
      const title = h.title ?? '(untitled)';
      const summary = (h.story_text ?? '').trim();
      const lines: string[] = [title];
      if (summary) {
        lines.push('');
        const trimmed = summary.length > 3000 ? `${summary.slice(0, 3000)}…` : summary;
        lines.push(trimmed);
      }
      const meta: string[] = [];
      if (h.author) meta.push(`by ${h.author}`);
      if (h.points != null) meta.push(`${h.points} points`);
      if (h.num_comments != null) meta.push(`${h.num_comments} comments`);
      if (h.created_at) meta.push(h.created_at.slice(0, 10));
      if (meta.length) {
        lines.push('');
        lines.push(`— ${meta.join(' · ')}`);
      }
      // The HN thread URL is canonical; the linked URL is the actual
      // article. Prefer the linked URL when available so the user
      // jumps straight to the source.
      const link =
        h.url ??
        `https://news.ycombinator.com/item?id=${h.objectID}`;
      // Confidence weights points + comments — a 500-point story is
      // much more signal than a 1-point one.
      const points = h.points ?? 0;
      const confidence = Math.min(0.7, 0.3 + Math.log10(points + 1) * 0.1);
      return {
        title,
        url: link,
        content: lines.join('\n'),
        confidence,
        fetchedAt: new Date(),
      };
    });
  }
}
