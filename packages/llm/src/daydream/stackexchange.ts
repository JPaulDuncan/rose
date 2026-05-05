import { z } from 'zod';
import { webFetchJson } from '../web/index.js';
import type { AdapterContext, DaydreamAdapter, DaydreamSnippet } from './types.js';

const UA = 'Rose/1.0 (+https://rose.local; daydream)';

const SEItem = z.object({
  question_id: z.number(),
  title: z.string(),
  link: z.string(),
  score: z.number().optional(),
  view_count: z.number().optional(),
  answer_count: z.number().optional(),
  is_answered: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
  creation_date: z.number().optional(),
});

const SEResponse = z.object({
  items: z.array(SEItem).optional(),
});

/**
 * Stack Exchange adapter — programming/technical Q&A, but the
 * Stack Exchange network has dozens of sites. The user picks which
 * sites to query via `options.stackexchangeSites` (e.g. ["stackoverflow",
 * "superuser", "askubuntu"]). Each enabled site is queried in parallel
 * and results are merged.
 *
 * Free tier: 300 req/day per IP without a key. Optional `key` in
 * options bumps to 10K/day.
 */
export class StackExchangeAdapter implements DaydreamAdapter {
  readonly id = 'stackexchange';
  readonly label = 'Stack Exchange';
  readonly enabledByDefault = false;

  async fetch(query: string, ctx: AdapterContext): Promise<DaydreamSnippet[]> {
    const cache = (ctx.options?.cache as
      | import('../web/index.js').WebFetchCache
      | undefined) ?? undefined;
    const sites = ((ctx.options?.stackexchangeSites as string[] | undefined) ?? [
      'stackoverflow',
    ]).slice(0, 4);
    const apiKey = (ctx.options?.stackexchangeKey as string | undefined) ?? '';

    // Per-site fan-out. Take top 1 from each so the prompt stays
    // bounded — better breadth than depth across a small set of
    // sites.
    const perSite = await Promise.all(
      sites.map(async (rawSite) => {
        // SE's `site` parameter wants the bare hostname keyword
        // (e.g. "stackoverflow"); strip a trailing ".com" if the
        // user typed it.
        const site = rawSite.replace(/\.com$/i, '').replace(/[^a-z]/g, '');
        if (!site) return [] as DaydreamSnippet[];
        const url =
          `https://api.stackexchange.com/2.3/search/advanced` +
          `?order=desc&sort=relevance` +
          `&q=${encodeURIComponent(query)}` +
          `&site=${site}&pagesize=2&filter=default` +
          (apiKey ? `&key=${encodeURIComponent(apiKey)}` : '');
        const json = await webFetchJson(url, {
          userAgent: UA,
          timeoutMs: ctx.timeoutMs,
          cache,
          cacheTtlSec: 60 * 60 * 24 * 7,
          caller: `daydream.stackexchange.${site}`,
          schema: SEResponse,
        });
        const items = json?.items ?? [];
        return items.slice(0, 1).map((it): DaydreamSnippet => {
          const lines: string[] = [it.title];
          const meta: string[] = [];
          if (it.score != null) meta.push(`${it.score} votes`);
          if (it.answer_count != null)
            meta.push(`${it.answer_count} answer${it.answer_count === 1 ? '' : 's'}`);
          if (it.is_answered) meta.push('answered');
          if ((it.tags ?? []).length)
            meta.push((it.tags ?? []).slice(0, 4).join(', '));
          meta.push(`on ${site}`);
          lines.push('');
          lines.push(`— ${meta.join(' · ')}`);
          // Confidence: well-voted answered questions are stronger
          // signals than recent unanswered ones.
          const score = it.score ?? 0;
          const answered = it.is_answered ? 0.1 : 0;
          const confidence = Math.min(
            0.7,
            0.3 + Math.log10(Math.max(1, score + 1)) * 0.15 + answered,
          );
          return {
            title: it.title,
            url: it.link,
            content: lines.join('\n'),
            confidence,
            fetchedAt: new Date(),
          };
        });
      }),
    );
    return perSite.flat().slice(0, 2);
  }
}
