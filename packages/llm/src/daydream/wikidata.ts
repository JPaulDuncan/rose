import { z } from 'zod';
import { webFetchJson } from '../web/index.js';
import type {
  AdapterContext,
  DaydreamAdapter,
  DaydreamContext,
  DaydreamSnippet,
} from './types.js';

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
    const hits = (json?.search ?? []).slice(0, 3);
    if (hits.length === 0) return [];

    // Disambiguation pass. When `wbsearchentities` returns several
    // exact-label matches ("The Drama" → the noun, the 2017 film, a
    // 2010 indie album, …) we need a signal beyond label-match to
    // rank them. Two cheap heuristics:
    //   • entityType: 'work' → boost results whose description
    //     looks like a creative work (film, novel, album, video
    //     game, etc).
    //   • senderName + pageTags: prose match against the description
    //     — if the description contains a token from the surrounding
    //     context, that's almost certainly the right Q-ID.
    // The boost is capped at +0.15 so a high-confidence exact match
    // without context still outranks a no-context partial match,
    // but ties between equally-good label hits break on context.
    const ctxBoost = (description: string): number => {
      if (!ctx.subjectContext) return 0;
      const desc = description.toLowerCase();
      let boost = 0;
      const t = ctx.subjectContext.entityType;
      if (t && TYPE_KEYWORDS[t].some((kw) => desc.includes(kw))) boost += 0.1;
      const tokens = contextTokens(ctx.subjectContext);
      if (tokens.some((tk) => desc.includes(tk))) boost += 0.05;
      return boost;
    };

    const ranked = hits
      .map((hit) => {
        const label = hit.label ?? hit.id;
        const description = hit.description ?? '';
        const exact = hit.match?.type === 'label';
        const aliasOnly = hit.match?.type === 'alias';
        const base = exact ? 0.9 : aliasOnly ? 0.7 : 0.5;
        const confidence = Math.min(0.99, base + ctxBoost(description));
        const url = hit.concepturi ?? `https://www.wikidata.org/wiki/${hit.id}`;
        const content = description
          ? `${label} (${hit.id}): ${description}`
          : `${label} (${hit.id})`;
        return {
          title: label,
          url,
          content,
          confidence,
          fetchedAt: new Date(),
        };
      })
      .sort((a, b) => b.confidence - a.confidence)
      // Top two after re-ranking. Bounded prompt size.
      .slice(0, 2);
    return ranked;
  }
}

/**
 * Per-entity-type keyword list. Wikidata descriptions are short and
 * follow a predictable pattern ("2017 film by …", "American novelist",
 * "company headquartered in …") so substring containment is a robust
 * enough disambiguator without pulling in stemming or full NLP. List
 * stays conservative: only terms that almost certainly indicate the
 * correct type, no clever inferences.
 */
const TYPE_KEYWORDS: Record<NonNullable<DaydreamContext['entityType']>, readonly string[]> = {
  person: ['actor', 'actress', 'singer', 'novelist', 'author', 'politician', 'scientist', 'artist', 'musician', 'director', 'filmmaker', 'born ', 'died ', 'american ', 'british ', 'composer', 'journalist', 'engineer', 'philosopher'],
  organization: ['company', 'corporation', 'organization', 'organisation', 'nonprofit', 'agency', 'studio', 'publisher', 'label', 'foundation', 'team', 'club', 'institution', 'firm', 'startup', 'headquartered'],
  place: ['city', 'town', 'village', 'country', 'region', 'state', 'province', 'island', 'mountain', 'river', 'lake', 'park', 'district', 'neighborhood', 'capital', 'municipality'],
  work: ['film', 'movie', 'novel', 'book', 'album', 'song', 'video game', 'television series', 'tv series', 'play', 'short story', 'comic', 'painting', 'opera', 'musical', 'episode'],
};

function contextTokens(ctx: DaydreamContext): string[] {
  const out: string[] = [];
  const push = (s: string | null | undefined, minLen = 4) => {
    if (!s) return;
    const t = s.toLowerCase().trim();
    if (t.length >= minLen) out.push(t);
  };
  push(ctx.senderName);
  if (ctx.senderDomain) {
    // Use the brand portion of the domain, not the full hostname —
    // "a24films.com" has "a24films" as the meaningful token.
    const brand = ctx.senderDomain.split('.').slice(0, -1).join('.');
    push(brand);
  }
  for (const tag of ctx.pageTags ?? []) push(tag, 3);
  return out;
}
