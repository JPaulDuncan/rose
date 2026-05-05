import { z } from 'zod';
import { webFetchJson } from '../web/index.js';
import type { AdapterContext, DaydreamAdapter, DaydreamSnippet } from './types.js';

const UA = 'Rose/1.0 (+https://rose.local; daydream)';

/**
 * Wiktionary's `/page/definition/{term}` returns a map of language
 * code → array of part-of-speech entries. Each entry has a list of
 * definitions, each with parsed HTML and example sentences. We
 * surface the first 1–2 senses of the requested language; fall back
 * to "en" when the requested lang has no matches.
 */
const WiktionaryResp = z.record(
  z.string(),
  z.array(
    z.object({
      partOfSpeech: z.string().optional(),
      language: z.string().optional(),
      definitions: z
        .array(
          z.object({
            definition: z.string().optional(),
            examples: z.array(z.string()).optional(),
          }),
        )
        .optional(),
    }),
  ),
);

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Wiktionary adapter. Best for terminology / etymologies — terms that
 * are too narrow for a Wikipedia article but still have a defined
 * meaning. The free REST endpoint returns no-key-needed JSON.
 */
export class WiktionaryAdapter implements DaydreamAdapter {
  readonly id = 'wiktionary';
  readonly label = 'Wiktionary';
  readonly enabledByDefault = false;

  async fetch(query: string, ctx: AdapterContext): Promise<DaydreamSnippet[]> {
    const lang = (ctx.lang ?? 'en').replace(/[^a-z-]/gi, '') || 'en';
    const cache = (ctx.options?.cache as
      | import('../web/index.js').WebFetchCache
      | undefined) ?? undefined;
    // Wiktionary expects a single-token title. Multi-word queries
    // rarely have entries — short-circuit those.
    if (/\s/.test(query.trim())) return [];
    const url =
      `https://${lang}.wiktionary.org/api/rest_v1/page/definition/` +
      encodeURIComponent(query.trim());

    const json = await webFetchJson(url, {
      userAgent: UA,
      timeoutMs: ctx.timeoutMs,
      cache,
      cacheTtlSec: 60 * 60 * 24 * 30, // definitions rarely change
      caller: 'daydream.wiktionary',
      schema: WiktionaryResp,
    });
    if (!json) return [];
    // Prefer entries in the requested language; fall back to first
    // available block when the requested lang is empty.
    const langKey = Object.keys(json).find((k) => k.toLowerCase() === lang);
    const block = (json[langKey ?? Object.keys(json)[0] ?? ''] ?? []) as Array<{
      partOfSpeech?: string;
      definitions?: Array<{ definition?: string; examples?: string[] }>;
    }>;
    if (!block || block.length === 0) return [];

    const lines: string[] = [];
    for (const entry of block.slice(0, 2)) {
      const pos = entry.partOfSpeech ?? '';
      const defs = (entry.definitions ?? []).slice(0, 2);
      for (const d of defs) {
        const text = stripHtml(d.definition ?? '');
        if (!text) continue;
        lines.push(pos ? `(${pos}) ${text}` : text);
      }
    }
    if (lines.length === 0) return [];

    const url2 = `https://${lang}.wiktionary.org/wiki/${encodeURIComponent(query.trim())}`;
    return [
      {
        title: query.trim(),
        url: url2,
        content: lines.join('\n'),
        confidence: 0.7,
        fetchedAt: new Date(),
      },
    ];
  }
}
