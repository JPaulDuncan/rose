import { z } from 'zod';
import { webFetchJson } from '../web/index.js';
import type { AdapterContext, DaydreamAdapter, DaydreamSnippet } from './types.js';

const UA = 'Rose/1.0 (+https://rose.local; daydream)';

const RelatedTopic = z.object({
  Text: z.string().optional(),
  FirstURL: z.string().optional(),
});

const DdgResp = z.object({
  Heading: z.string().optional(),
  Abstract: z.string().optional(),
  AbstractText: z.string().optional(),
  AbstractURL: z.string().optional(),
  AbstractSource: z.string().optional(),
  RelatedTopics: z.array(z.union([RelatedTopic, z.record(z.string(), z.unknown())])).optional(),
});

/**
 * DuckDuckGo Instant Answer adapter. Free, no key. Limited to
 * curated "instant answer" hits — DDG IA only covers a few million
 * topics, so most queries will return nothing. When it does have an
 * answer it's high-quality (often pulled from Wikipedia / dedicated
 * data partners), so the few hits it produces are worth surfacing.
 *
 * Returns at most one snippet (the AbstractText) — RelatedTopics is
 * skipped because it's typically a long list of disambiguation
 * fragments that confuse the synthesis prompt.
 */
export class DuckDuckGoAdapter implements DaydreamAdapter {
  readonly id = 'duckduckgo';
  readonly label = 'DuckDuckGo Instant Answer';
  readonly enabledByDefault = true;

  async fetch(query: string, ctx: AdapterContext): Promise<DaydreamSnippet[]> {
    const cache = (ctx.options?.cache as
      | import('../web/index.js').WebFetchCache
      | undefined) ?? undefined;
    const url =
      `https://api.duckduckgo.com/` +
      `?q=${encodeURIComponent(query)}` +
      `&format=json&no_html=1&skip_disambig=1&t=rose`;

    const json = await webFetchJson(url, {
      userAgent: UA,
      timeoutMs: ctx.timeoutMs,
      cache,
      cacheTtlSec: 60 * 60 * 24 * 7,
      caller: 'daydream.duckduckgo',
      schema: DdgResp,
    });
    const text = (json?.AbstractText ?? '').trim();
    if (!text) return [];
    const heading = json?.Heading ?? query;
    const lines: string[] = [heading];
    lines.push('');
    lines.push(text.length > 4000 ? `${text.slice(0, 4000)}…` : text);
    if (json?.AbstractSource) {
      lines.push('');
      lines.push(`— via ${json.AbstractSource}`);
    }
    return [
      {
        title: heading,
        url: json?.AbstractURL ?? `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
        content: lines.join('\n'),
        // DDG IA when present is high-quality — usually drawn from a
        // dedicated data source — so it gets a higher confidence
        // than open web crawls.
        confidence: 0.75,
        fetchedAt: new Date(),
      },
    ];
  }
}
