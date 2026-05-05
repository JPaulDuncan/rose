import type { AdapterContext, DaydreamAdapter, DaydreamSnippet } from './types.js';

const UA = 'Rose/1.0 (+https://rose.local; daydream)';

/**
 * Wikipedia REST API adapter. Two-step lookup:
 *   1. /search?q=... → pick the top result (handles redirects + spelling)
 *   2. /page/summary/{title} → pull the lead paragraph
 *
 * Both endpoints are public, free, and rate-limited generously (the
 * Wikipedia ToS asks for one sustained req/sec per UA, which the
 * worker-level concurrency=1 already enforces).
 */
export class WikipediaAdapter implements DaydreamAdapter {
  readonly id = 'wikipedia';
  readonly label = 'Wikipedia';
  readonly enabledByDefault = true;

  async fetch(query: string, ctx: AdapterContext): Promise<DaydreamSnippet[]> {
    const lang = (ctx.lang ?? 'en').replace(/[^a-z-]/gi, '') || 'en';
    const fetchFn = ctx.fetch ?? globalThis.fetch.bind(globalThis);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ctx.timeoutMs);
    try {
      // Step 1 — disambiguate via /search.
      const searchUrl =
        `https://${lang}.wikipedia.org/w/rest.php/v1/search/title` +
        `?q=${encodeURIComponent(query)}&limit=1`;
      const sRes = await fetchFn(searchUrl, {
        headers: { 'User-Agent': UA, accept: 'application/json' },
        signal: ctrl.signal,
      });
      if (!sRes.ok) return [];
      const sJson = (await sRes.json()) as { pages?: { key?: string; title?: string }[] };
      const top = sJson.pages?.[0];
      if (!top?.key) return [];

      // Step 2 — summary for the chosen page.
      const summaryUrl =
        `https://${lang}.wikipedia.org/api/rest_v1/page/summary/` +
        encodeURIComponent(top.key);
      const dRes = await fetchFn(summaryUrl, {
        headers: { 'User-Agent': UA, accept: 'application/json' },
        signal: ctrl.signal,
      });
      if (!dRes.ok) return [];
      const dJson = (await dRes.json()) as {
        title?: string;
        extract?: string;
        type?: string;
        content_urls?: { desktop?: { page?: string } };
      };
      const extract = (dJson.extract ?? '').trim();
      if (!extract) return [];
      // Trim to ~4 KB so the LLM prompt stays small and to limit the
      // surface for prompt-injection payloads in fetched content.
      const trimmed = extract.length > 4000 ? `${extract.slice(0, 4000)}…` : extract;
      const url =
        dJson.content_urls?.desktop?.page ??
        `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(top.key)}`;
      // Disambiguation pages are technically "summaries" but rarely
      // useful as standalone context; let the LLM filter by lowering
      // confidence rather than dropping outright.
      const confidence = dJson.type === 'disambiguation' ? 0.3 : 0.85;
      return [
        {
          title: dJson.title ?? top.title ?? top.key,
          url,
          content: trimmed,
          confidence,
          fetchedAt: new Date(),
        },
      ];
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }
}
