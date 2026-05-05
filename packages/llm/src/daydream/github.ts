import { z } from 'zod';
import { webFetchJson } from '../web/index.js';
import type { AdapterContext, DaydreamAdapter, DaydreamSnippet } from './types.js';

const UA = 'Rose/1.0 (+https://rose.local; daydream)';

const Repo = z.object({
  id: z.number(),
  full_name: z.string(),
  html_url: z.string(),
  description: z.string().nullable().optional(),
  stargazers_count: z.number().optional(),
  forks_count: z.number().optional(),
  language: z.string().nullable().optional(),
  topics: z.array(z.string()).optional(),
  pushed_at: z.string().optional(),
});

const SearchResponse = z.object({
  items: z.array(Repo).optional(),
});

/**
 * GitHub adapter — searches the public repo index. Description +
 * stars + topics is plenty of context for a "what is X" snippet
 * without fetching the README, which keeps us under the unauth
 * 60 req/h limit. Optional PAT (`options.githubToken`) bumps that
 * to 5K/h and the user supplies it from Settings.
 */
export class GitHubAdapter implements DaydreamAdapter {
  readonly id = 'github';
  readonly label = 'GitHub';
  readonly enabledByDefault = false;

  async fetch(query: string, ctx: AdapterContext): Promise<DaydreamSnippet[]> {
    const cache = (ctx.options?.cache as
      | import('../web/index.js').WebFetchCache
      | undefined) ?? undefined;
    const token = (ctx.options?.githubToken as string | undefined) ?? '';

    const url =
      `https://api.github.com/search/repositories` +
      `?q=${encodeURIComponent(query)}` +
      `&per_page=3&sort=stars&order=desc`;
    const headers: Record<string, string> = { accept: 'application/vnd.github+json' };
    if (token) headers.authorization = `Bearer ${token}`;

    const json = await webFetchJson(url, {
      userAgent: UA,
      timeoutMs: ctx.timeoutMs,
      cache,
      cacheTtlSec: 60 * 60 * 24 * 7,
      caller: 'daydream.github',
      headers,
      schema: SearchResponse,
    });
    const items = json?.items ?? [];
    if (items.length === 0) return [];

    return items.slice(0, 2).map((r) => {
      const lines: string[] = [r.full_name];
      if (r.description) {
        lines.push('');
        lines.push(r.description);
      }
      const meta: string[] = [];
      if (r.language) meta.push(r.language);
      if (r.stargazers_count != null) meta.push(`★ ${r.stargazers_count}`);
      if (r.forks_count != null) meta.push(`forks ${r.forks_count}`);
      if ((r.topics ?? []).length) meta.push((r.topics ?? []).slice(0, 5).join(', '));
      if (r.pushed_at) meta.push(`updated ${r.pushed_at.slice(0, 10)}`);
      if (meta.length) {
        lines.push('');
        lines.push(`— ${meta.join(' · ')}`);
      }
      // Confidence: log-scaled by stars. A 50K-star repo is high-
      // signal; an obscure 5-star one is barely an indicator.
      const stars = r.stargazers_count ?? 0;
      const confidence = Math.min(0.85, 0.35 + Math.log10(stars + 1) * 0.12);
      return {
        title: r.full_name,
        url: r.html_url,
        content: lines.join('\n'),
        confidence,
        fetchedAt: new Date(),
      };
    });
  }
}
