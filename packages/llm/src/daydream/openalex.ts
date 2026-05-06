import { z } from 'zod';
import { webFetchJson } from '../web/index.js';
import type { AdapterContext, DaydreamAdapter, DaydreamSnippet } from './types.js';

const UA = 'Rose/1.0 (+https://rose.local; daydream)';

const OpenAlexAuthor = z.object({
  author: z.object({ display_name: z.string().optional() }).optional(),
});

const OpenAlexWork = z.object({
  id: z.string(),
  doi: z.string().nullable().optional(),
  title: z.string().optional(),
  publication_year: z.number().int().nullable().optional(),
  cited_by_count: z.number().int().optional(),
  relevance_score: z.number().optional(),
  // Inverted-index abstract: { word: [position, ...] }
  abstract_inverted_index: z.record(z.string(), z.array(z.number())).nullable().optional(),
  authorships: z.array(OpenAlexAuthor).optional(),
  primary_location: z
    .object({
      source: z.object({ display_name: z.string().optional() }).optional().nullable(),
      landing_page_url: z.string().optional().nullable(),
    })
    .optional()
    .nullable(),
});

const OpenAlexResponse = z.object({
  results: z.array(OpenAlexWork).optional(),
});

/**
 * OpenAlex stores abstracts as `{word: [position, ...]}` to comply with
 * publisher restrictions on full-text reproduction. Reconstructing the
 * abstract is straightforward: walk every position, place the word at
 * that index, join with spaces. Lossy on punctuation (positions are
 * word-level) but readable enough for an LLM to summarise.
 */
function rebuildAbstract(
  invertedIndex: Record<string, number[]> | null | undefined,
): string {
  if (!invertedIndex) return '';
  const positions: { pos: number; word: string }[] = [];
  for (const [word, posList] of Object.entries(invertedIndex)) {
    for (const pos of posList) positions.push({ pos, word });
  }
  positions.sort((a, b) => a.pos - b.pos);
  return positions.map((p) => p.word).join(' ');
}

/**
 * OpenAlex adapter. Searches the works index — the most useful
 * surface for "find me what's been written about X" queries that
 * fall outside encyclopedic-summary territory. Free, no key, but
 * the polite-pool gives 100K req/day vs ~10/sec without if you
 * include a `mailto=` query param. We pass the user's configured
 * polite-pool email via `ctx.options.openalexMailto` when set.
 *
 * Confidence is derived from OpenAlex's own `relevance_score`,
 * normalized against the top hit so we don't over-claim relative
 * to other adapters. A high citation count is treated as a small
 * extra credibility bump.
 */
export class OpenAlexAdapter implements DaydreamAdapter {
  readonly id = 'openalex';
  readonly label = 'OpenAlex';
  readonly enabledByDefault = false;

  async fetch(query: string, ctx: AdapterContext): Promise<DaydreamSnippet[]> {
    const cache = (ctx.options?.cache as
      | import('../web/index.js').WebFetchCache
      | undefined) ?? undefined;
    const mailto = (ctx.options?.openalexMailto as string | undefined) ?? '';

    const url =
      `https://api.openalex.org/works` +
      `?search=${encodeURIComponent(query)}` +
      `&per-page=3` +
      `&select=id,doi,title,publication_year,cited_by_count,abstract_inverted_index,authorships,primary_location,relevance_score` +
      (mailto ? `&mailto=${encodeURIComponent(mailto)}` : '');

    const json = await webFetchJson(url, {
      userAgent: UA,
      timeoutMs: ctx.timeoutMs,
      cache,
      cacheTtlSec: 60 * 60 * 24 * 30, // 30 days — abstracts are stable
      caller: 'daydream.openalex.works',
      schema: OpenAlexResponse,
    });
    const works = json?.results ?? [];
    if (works.length === 0) return [];

    const topScore = works[0]?.relevance_score ?? 1;
    const out: DaydreamSnippet[] = [];
    for (const w of works.slice(0, 2)) {
      const title = w.title ?? '(untitled work)';
      const abstract = rebuildAbstract(w.abstract_inverted_index);
      const trimmed = abstract.length > 4000 ? `${abstract.slice(0, 4000)}…` : abstract;
      const authors = (w.authorships ?? [])
        .map((a) => a.author?.display_name)
        .filter((n): n is string => !!n)
        .slice(0, 4);
      const venue = w.primary_location?.source?.display_name ?? '';
      const cited = w.cited_by_count ?? 0;
      // Build a content blob the LLM can parse: title, optional
      // abstract, then a metadata footer. Format mirrors how a
      // structured citation reads.
      const lines: string[] = [];
      lines.push(title);
      if (trimmed) {
        lines.push('');
        lines.push(trimmed);
      }
      const footer: string[] = [];
      if (authors.length) footer.push(authors.join(', '));
      if (w.publication_year != null) footer.push(String(w.publication_year));
      if (venue) footer.push(venue);
      if (cited > 0) footer.push(`cited ${cited} times`);
      if (footer.length) {
        lines.push('');
        lines.push(`— ${footer.join(' · ')}`);
      }
      const content = lines.join('\n');
      const link =
        w.primary_location?.landing_page_url ??
        (w.doi ? `https://doi.org/${w.doi.replace(/^https?:\/\/doi\.org\//i, '')}` : null) ??
        w.id;
      // Relevance normalisation: top hit gets a high confidence,
      // subsequent hits scaled by their relative score. Old, much-
      // cited works get a small bump (0.05) so a foundational paper
      // doesn't lose to a noisier recent preprint.
      const rel = topScore > 0 ? (w.relevance_score ?? 0) / topScore : 0.5;
      const citedBump = Math.min(0.05, Math.log10(Math.max(1, cited)) / 100);
      const confidence = Math.min(0.95, Math.max(0.3, rel * 0.85 + citedBump));
      out.push({
        title,
        url: link,
        content,
        confidence,
        fetchedAt: new Date(),
      });
    }
    return out;
  }
}
