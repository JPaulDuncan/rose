import { z } from 'zod';
import { webFetchJson } from '../web/index.js';
import type { AdapterContext, DaydreamAdapter, DaydreamSnippet } from './types.js';

const UA = 'Rose/1.0 (+https://rose.local; daydream)';

const WbSearchResp = z.object({
  search: z
    .array(
      z.object({
        id: z.string(),
        label: z.string().optional(),
        description: z.string().optional(),
        match: z
          .object({
            type: z.string().optional(),
            text: z.string().optional(),
          })
          .optional(),
        concepturi: z.string().optional(),
      }),
    )
    .optional(),
});

/**
 * Wikidata adapter. Uses `wbsearchentities` to map a label to one or
 * more Q-ids, returning the top two as snippets. The description on
 * a Q-entity ("genus of stem arthropods", "American actor", "type of
 * machine learning model") is short but high-signal — exactly the
 * shape the synthesis prompt wants alongside the longer Wikipedia
 * extract. Where Wikipedia has no article, Wikidata almost always
 * still has an entry, so this is a meaningful upgrade in coverage
 * for niche subjects.
 *
 * Confidence biases: an exact-label match wins over a description-
 * fragment match wins over a "no match metadata at all" hit.
 */
export class WikidataAdapter implements DaydreamAdapter {
  readonly id = 'wikidata';
  readonly label = 'Wikidata';
  readonly enabledByDefault = false;

  async fetch(query: string, ctx: AdapterContext): Promise<DaydreamSnippet[]> {
    const lang = (ctx.lang ?? 'en').replace(/[^a-z-]/gi, '') || 'en';
    const cache = (ctx.options?.cache as
      | import('../web/index.js').WebFetchCache
      | undefined) ?? undefined;

    // wbsearchentities is on the action-API, not the rest_v1 path.
    // It returns label + description directly so a single hop is
    // enough — claims fetching is deferred until a feature actually
    // needs structured fields, which v1 doesn't.
    const searchUrl =
      `https://www.wikidata.org/w/api.php` +
      `?action=wbsearchentities` +
      `&search=${encodeURIComponent(query)}` +
      `&format=json&language=${encodeURIComponent(lang)}` +
      `&type=item&limit=3&origin=*`;

    const json = await webFetchJson(searchUrl, {
      userAgent: UA,
      timeoutMs: ctx.timeoutMs,
      cache,
      cacheTtlSec: 60 * 60 * 24 * 30, // 30 days — Q-id labels rarely change
      caller: 'daydream.wikidata.search',
      schema: WbSearchResp,
    });
    const hits = (json?.search ?? []).slice(0, 2);
    if (hits.length === 0) return [];

    return hits.map((hit) => {
      const label = hit.label ?? hit.id;
      const description = hit.description ?? '';
      // Exact-label match? wbsearchentities tells us so via match.type.
      const exact = hit.match?.type === 'label';
      const aliasOnly = hit.match?.type === 'alias';
      const url = hit.concepturi ?? `https://www.wikidata.org/wiki/${hit.id}`;
      // Compose a short snippet body — adapter content is meant to
      // be context for the LLM, so include the label and description
      // verbatim. Q-id is included so cross-source synthesis can
      // notice when Wikipedia + Wikidata refer to the same entity.
      const content = description
        ? `${label} (${hit.id}): ${description}`
        : `${label} (${hit.id})`;
      return {
        title: label,
        url,
        content,
        confidence: exact ? 0.9 : aliasOnly ? 0.7 : 0.5,
        fetchedAt: new Date(),
      };
    });
  }
}
