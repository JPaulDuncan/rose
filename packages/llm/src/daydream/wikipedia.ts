import { z } from 'zod';
import { webFetchJson } from '../web/index.js';
import type { AdapterContext, DaydreamAdapter, DaydreamSnippet } from './types.js';

const UA = 'Rose/1.0 (+https://rose.local; daydream)';

const WikiSearchResp = z.object({
  pages: z
    .array(
      z.object({
        key: z.string().optional(),
        title: z.string().optional(),
      }),
    )
    .optional(),
});

const WikiSummaryResp = z.object({
  title: z.string().optional(),
  extract: z.string().optional(),
  type: z.string().optional(),
  content_urls: z
    .object({
      desktop: z.object({ page: z.string().optional() }).optional(),
    })
    .optional(),
});

/**
 * Wikipedia REST adapter. All HTTP goes through `webFetchJson`, which
 * runs the SSRF guard, applies the standard timeout, and validates
 * each response against a Zod schema — so a hijacked response shape
 * surfaces as a parse failure rather than a downstream undefined.
 */
export class WikipediaAdapter implements DaydreamAdapter {
  readonly id = 'wikipedia';
  readonly label = 'Wikipedia';
  readonly enabledByDefault = true;

  async fetch(query: string, ctx: AdapterContext): Promise<DaydreamSnippet[]> {
    const lang = (ctx.lang ?? 'en').replace(/[^a-z-]/gi, '') || 'en';
    const cache = (ctx.options?.cache as
      | import('../web/index.js').WebFetchCache
      | undefined) ?? undefined;

    // Step 1 — disambiguate via /search/title.
    const searchUrl =
      `https://${lang}.wikipedia.org/w/rest.php/v1/search/title` +
      `?q=${encodeURIComponent(query)}&limit=1`;
    const search = await webFetchJson(searchUrl, {
      userAgent: UA,
      timeoutMs: ctx.timeoutMs,
      cache,
      cacheTtlSec: 60 * 60 * 24, // 1 day for the search→key mapping
      caller: 'daydream.wikipedia.search',
      schema: WikiSearchResp,
    });
    const top = search?.pages?.[0];
    if (!top?.key) return [];

    // Step 2 — summary for the chosen page.
    const summaryUrl =
      `https://${lang}.wikipedia.org/api/rest_v1/page/summary/` +
      encodeURIComponent(top.key);
    const summary = await webFetchJson(summaryUrl, {
      userAgent: UA,
      timeoutMs: ctx.timeoutMs,
      cache,
      cacheTtlSec: 60 * 60 * 24 * 7, // 7 days for the summary text
      caller: 'daydream.wikipedia.summary',
      schema: WikiSummaryResp,
    });
    const extract = (summary?.extract ?? '').trim();
    if (!extract) return [];

    // Trim to ~4 KB so the LLM prompt stays small and to limit the
    // surface for prompt-injection payloads in fetched content.
    const trimmed = extract.length > 4000 ? `${extract.slice(0, 4000)}…` : extract;
    const url =
      summary?.content_urls?.desktop?.page ??
      `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(top.key)}`;
    // Disambiguation pages are technically "summaries" but rarely
    // useful as standalone context; let the LLM filter by lowering
    // confidence rather than dropping outright.
    const confidence = summary?.type === 'disambiguation' ? 0.3 : 0.85;
    return [
      {
        title: summary?.title ?? top.title ?? top.key,
        url,
        content: trimmed,
        confidence,
        fetchedAt: new Date(),
      },
    ];
  }
}
