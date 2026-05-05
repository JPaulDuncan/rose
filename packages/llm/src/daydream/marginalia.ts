import { z } from 'zod';
import { webFetchJson } from '../web/index.js';
import type { AdapterContext, DaydreamAdapter, DaydreamSnippet } from './types.js';

const UA = 'Rose/1.0 (+https://rose.local; daydream)';

const MarginaliaResult = z.object({
  url: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  format: z.string().optional(),
});

const MarginaliaResponse = z.object({
  query: z.string().optional(),
  results: z.array(MarginaliaResult).optional(),
});

/**
 * Marginalia (search.marginalia.nu) — independent crawler focused on
 * the small/independent web. The operator explicitly welcomes
 * programmatic use via the public API endpoint and a documented
 * "public" key. No subscription required.
 *
 * The closest thing to a principled, free, federated web-search
 * adapter that exists today, which is why it ships on by default
 * once the user enables the master external-search toggle.
 */
export class MarginaliaAdapter implements DaydreamAdapter {
  readonly id = 'marginalia';
  readonly label = 'Marginalia';
  readonly enabledByDefault = true;

  async fetch(query: string, ctx: AdapterContext): Promise<DaydreamSnippet[]> {
    const cache = (ctx.options?.cache as
      | import('../web/index.js').WebFetchCache
      | undefined) ?? undefined;
    // Public API — `key=public` is the documented anonymous slot.
    const url =
      `https://api.marginalia.nu/public/search/` +
      encodeURIComponent(query) +
      `?count=3&index=0`;

    const json = await webFetchJson(url, {
      userAgent: UA,
      timeoutMs: ctx.timeoutMs,
      cache,
      cacheTtlSec: 60 * 60 * 24 * 7,
      caller: 'daydream.marginalia',
      schema: MarginaliaResponse,
    });
    const results = (json?.results ?? []).slice(0, 2);
    if (results.length === 0) return [];

    return results.map((r, idx) => {
      const title = r.title ?? r.url;
      const description = (r.description ?? '').trim();
      const lines: string[] = [title];
      if (description) {
        lines.push('');
        const trimmed =
          description.length > 4000 ? `${description.slice(0, 4000)}…` : description;
        lines.push(trimmed);
      }
      return {
        title,
        url: r.url,
        content: lines.join('\n'),
        // Marginalia's relevance varies; weight modestly so it
        // contributes context without dominating high-confidence
        // structured-knowledge hits.
        confidence: idx === 0 ? 0.55 : 0.4,
        fetchedAt: new Date(),
      };
    });
  }
}
