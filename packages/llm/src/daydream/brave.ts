import { z } from 'zod';
import { webFetchJson } from '../web/index.js';
import type { AdapterContext, DaydreamAdapter, DaydreamSnippet } from './types.js';

const UA = 'Rose/1.0 (+https://rose.local; daydream)';

const BraveResult = z.object({
  url: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  age: z.string().optional(),
  page_age: z.string().optional(),
});

const BraveResponse = z.object({
  web: z
    .object({
      results: z.array(BraveResult).optional(),
    })
    .optional(),
});

/**
 * Brave Search API. Free tier is 2K queries/month; paid tiers are
 * available for higher volume. The user supplies their own
 * subscription token from Settings → Daydream → External search;
 * we never aggregate or proxy keys.
 *
 * Brave's index is independent of Google/Bing and explicitly
 * AI-friendly — the attribution policy permits programmatic use
 * with citation, which fits the synthesis-with-citations shape
 * Daydream already enforces.
 */
export class BraveSearchAdapter implements DaydreamAdapter {
  readonly id = 'brave';
  readonly label = 'Brave Search';
  readonly enabledByDefault = false;

  async fetch(query: string, ctx: AdapterContext): Promise<DaydreamSnippet[]> {
    const cache = (ctx.options?.cache as
      | import('../web/index.js').WebFetchCache
      | undefined) ?? undefined;
    const apiKey = (ctx.options?.braveApiKey as string | undefined) ?? '';
    if (!apiKey) return [];

    const url =
      `https://api.search.brave.com/res/v1/web/search` +
      `?q=${encodeURIComponent(query)}&count=3`;
    const json = await webFetchJson(url, {
      userAgent: UA,
      timeoutMs: ctx.timeoutMs,
      cache,
      cacheTtlSec: 60 * 60 * 24 * 7,
      caller: 'daydream.brave',
      headers: {
        accept: 'application/json',
        'x-subscription-token': apiKey,
      },
      schema: BraveResponse,
    });
    const results = json?.web?.results ?? [];
    if (results.length === 0) return [];

    return results.slice(0, 2).map((r, idx) => {
      const title = r.title ?? r.url;
      const description = (r.description ?? '').trim();
      const lines: string[] = [title];
      if (description) {
        lines.push('');
        lines.push(
          description.length > 4000 ? `${description.slice(0, 4000)}…` : description,
        );
      }
      const meta: string[] = [];
      if (r.age) meta.push(r.age);
      if (meta.length) {
        lines.push('');
        lines.push(`— ${meta.join(' · ')}`);
      }
      return {
        title,
        url: r.url,
        content: lines.join('\n'),
        // Brave hits are ranked relevance; top 0.65, second 0.5.
        // Below structured knowledge but above the open-web crawls.
        confidence: idx === 0 ? 0.65 : 0.5,
        fetchedAt: new Date(),
      };
    });
  }
}
