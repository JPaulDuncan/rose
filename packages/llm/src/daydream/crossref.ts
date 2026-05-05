import { z } from 'zod';
import { webFetchJson } from '../web/index.js';
import type { AdapterContext, DaydreamAdapter, DaydreamSnippet } from './types.js';

const UA = 'Rose/1.0 (+https://rose.local; daydream)';

const CrossrefAuthor = z.object({
  given: z.string().optional(),
  family: z.string().optional(),
});

const CrossrefItem = z.object({
  DOI: z.string().optional(),
  title: z.array(z.string()).optional(),
  abstract: z.string().optional(),
  author: z.array(CrossrefAuthor).optional(),
  'container-title': z.array(z.string()).optional(),
  publisher: z.string().optional(),
  issued: z.object({ 'date-parts': z.array(z.array(z.number())).optional() }).optional(),
  'is-referenced-by-count': z.number().optional(),
  URL: z.string().optional(),
  type: z.string().optional(),
  score: z.number().optional(),
});

const CrossrefResp = z.object({
  message: z.object({
    items: z.array(CrossrefItem).optional(),
  }),
});

function stripJatsAbstract(s: string | undefined): string {
  if (!s) return '';
  // Crossref abstracts come wrapped in JATS XML (<jats:p>, <jats:title>,
  // etc). Strip tags and entities to plain text.
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Crossref adapter — DOI metadata across 150M+ scholarly works. The
 * polite-pool mailto bumps the rate limit; without it the call still
 * works but on a slower queue. Best when OpenAlex doesn't have the
 * record (older works, niche conferences).
 *
 * Snippet content includes title, optional abstract, authors, year,
 * venue, citation count — enough for the LLM to assemble a proper
 * citation-grade summary.
 */
export class CrossrefAdapter implements DaydreamAdapter {
  readonly id = 'crossref';
  readonly label = 'Crossref';
  readonly enabledByDefault = false;

  async fetch(query: string, ctx: AdapterContext): Promise<DaydreamSnippet[]> {
    const cache = (ctx.options?.cache as
      | import('../web/index.js').WebFetchCache
      | undefined) ?? undefined;
    const mailto = (ctx.options?.crossrefMailto as string | undefined) ?? '';
    const url =
      `https://api.crossref.org/works` +
      `?query.bibliographic=${encodeURIComponent(query)}` +
      `&rows=3` +
      (mailto ? `&mailto=${encodeURIComponent(mailto)}` : '');

    const json = await webFetchJson(url, {
      userAgent: UA,
      timeoutMs: ctx.timeoutMs,
      cache,
      cacheTtlSec: 60 * 60 * 24 * 30,
      caller: 'daydream.crossref',
      schema: CrossrefResp,
    });
    const items = json?.message.items ?? [];
    if (items.length === 0) return [];

    const topScore = items[0]?.score ?? 1;
    return items.slice(0, 2).map((it) => {
      const title = (it.title ?? [])[0] ?? '(untitled)';
      const abstract = stripJatsAbstract(it.abstract);
      const authors = (it.author ?? [])
        .map((a) => [a.given, a.family].filter(Boolean).join(' '))
        .filter(Boolean)
        .slice(0, 4)
        .join(', ');
      const year = it.issued?.['date-parts']?.[0]?.[0];
      const venue = (it['container-title'] ?? [])[0] ?? '';
      const cited = it['is-referenced-by-count'] ?? 0;

      const lines: string[] = [title];
      if (abstract) {
        lines.push('');
        lines.push(abstract.length > 4000 ? `${abstract.slice(0, 4000)}…` : abstract);
      }
      const meta: string[] = [];
      if (authors) meta.push(authors);
      if (year != null) meta.push(String(year));
      if (venue) meta.push(venue);
      if (cited > 0) meta.push(`cited ${cited} times`);
      if (meta.length) {
        lines.push('');
        lines.push(`— ${meta.join(' · ')}`);
      }

      const link =
        it.URL ||
        (it.DOI ? `https://doi.org/${it.DOI}` : '') ||
        '';
      const rel = topScore > 0 ? (it.score ?? 0) / topScore : 0.5;
      const confidence = Math.min(0.9, Math.max(0.3, rel * 0.85));

      return {
        title,
        url: link || `https://search.crossref.org/?q=${encodeURIComponent(query)}`,
        content: lines.join('\n'),
        confidence,
        fetchedAt: new Date(),
      };
    });
  }
}
