import { z } from 'zod';
import { webFetchJson } from '../web/index.js';
import type { AdapterContext, DaydreamAdapter, DaydreamSnippet } from './types.js';

const UA = 'Rose/1.0 (+https://rose.local; daydream)';

const SearxResult = z.object({
  url: z.string(),
  title: z.string().optional(),
  content: z.string().optional(),
  engine: z.string().optional(),
  score: z.number().optional(),
});

const SearxResponse = z.object({
  query: z.string().optional(),
  results: z.array(SearxResult).optional(),
});

/**
 * SearXNG shim — calls a self-hosted SearXNG instance the user has
 * already deployed and configured. Plan 10's recommendation is "we
 * don't ship this," but the option exists for users who already run
 * SearXNG. They supply the instance URL; we route through it like
 * any other adapter.
 *
 * No authentication assumed — most SearXNG instances are open. If
 * yours is gated, configure a reverse proxy with auth and point the
 * adapter there.
 *
 * Different SearXNG instances have different config (categories,
 * bot detection, formats). The shim asks for `format=json` which
 * needs to be enabled in `settings.yml` on the target instance.
 */
export class SearXNGAdapter implements DaydreamAdapter {
  readonly id = 'searxng';
  readonly label = 'SearXNG';
  readonly enabledByDefault = false;

  async fetch(query: string, ctx: AdapterContext): Promise<DaydreamSnippet[]> {
    const cache = (ctx.options?.cache as
      | import('../web/index.js').WebFetchCache
      | undefined) ?? undefined;
    const instance = (ctx.options?.searxngInstanceUrl as string | undefined) ?? '';
    if (!instance) return [];
    // Trim trailing slash and append /search.
    const base = instance.replace(/\/+$/, '');
    const url = `${base}/search?q=${encodeURIComponent(query)}&format=json`;

    const json = await webFetchJson(url, {
      userAgent: UA,
      timeoutMs: ctx.timeoutMs,
      cache,
      cacheTtlSec: 60 * 60 * 24,
      caller: 'daydream.searxng',
      schema: SearxResponse,
    });
    const results = json?.results ?? [];
    if (results.length === 0) return [];

    return results.slice(0, 2).map((r, idx) => {
      const title = r.title ?? r.url;
      const content = (r.content ?? '').trim();
      const lines: string[] = [title];
      if (content) {
        lines.push('');
        lines.push(content.length > 4000 ? `${content.slice(0, 4000)}…` : content);
      }
      if (r.engine) {
        lines.push('');
        lines.push(`— via ${r.engine}`);
      }
      return {
        title,
        url: r.url,
        content: lines.join('\n'),
        confidence: idx === 0 ? 0.55 : 0.4,
        fetchedAt: new Date(),
      };
    });
  }
}
