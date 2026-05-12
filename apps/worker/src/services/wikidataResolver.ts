import { createHash } from 'node:crypto';
import type { Types } from 'mongoose';
import { Entity, Organization, Product } from '@rose/db';
import { redis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import {
  enrichOrganizationRelations,
  enrichEntityRelations,
} from './wikidataRelations.js';

/**
 * Wikidata Q-ID resolver. Maps a free-text name + a hint of
 * "what kind of thing" to a Q-ID via Wikidata's wbsearchentities
 * API. Cached aggressively (Redis, 30 days) so we don't re-hit the
 * upstream for the same name across users — and so a recurring
 * "no match" result is paid for once. Failed lookups land in the
 * cache too as the literal string "NO_MATCH" so repeated misses
 * cost a Redis GET, not an HTTP round trip.
 *
 * Confidence:
 *   1.0   exact case-insensitive label match on the top hit AND
 *         the hit's description matches the expected type
 *   0.7   exact label match on top hit (no type confirmation)
 *   0.5   non-exact label match on top hit
 *   0.0   no match
 *
 * Phase 1 resolved Organizations + Products only. Phase 2 (this
 * file) added Person + Place entities — they still live in the
 * per-user Entity collection but the Q-ID + confidence are stored
 * on the row so /n/<key> can render the Wikidata badge and the
 * relation enricher can fan out person/place SPARQL queries.
 */

const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';
const USER_AGENT = 'rose-wiki/0.1 (+https://github.com/anthropics/rose; ontology)';
const CACHE_TTL_SEC = 30 * 24 * 3600; // 30 days
const HTTP_TIMEOUT_MS = 8000;
/** Minimum interval between two re-resolution attempts for a row
 *  that's already been touched. 90 days; below that we trust the
 *  prior verdict. */
const REFRESH_MS = 90 * 24 * 3600 * 1000;

type WikidataSearchHit = {
  id: string; // "Q103814476"
  label: string;
  description?: string;
};

type WikidataSearchResponse = {
  search?: WikidataSearchHit[];
};

export type ResolverKind = 'organization' | 'product' | 'person' | 'place';

function cacheKey(kind: ResolverKind, name: string): string {
  // Hash because names can contain colons / slashes / punctuation
  // that Redis tolerates but is awkward to escape. The kind is
  // namespaced separately so an org "Apple" and a product "Apple"
  // can resolve to different Q-IDs (Q312 vs Q89 etc.).
  const h = createHash('sha256').update(`${kind}|${name.toLowerCase().trim()}`).digest('hex').slice(0, 32);
  return `wikidata:v1:${kind}:${h}`;
}

type ResolveResult = {
  wikidataId: string | null;
  confidence: number;
};

/**
 * Query the Wikidata search API for `name`, scoring the top result
 * against `kind` to produce a confidence score. Best-effort: any
 * failure returns `{ wikidataId: null, confidence: 0 }` and caches
 * the miss so the next caller doesn't re-pay.
 */
export async function resolveWikidata(
  kind: ResolverKind,
  name: string,
): Promise<ResolveResult> {
  const cleaned = name.trim();
  if (!cleaned) return { wikidataId: null, confidence: 0 };

  const key = cacheKey(kind, cleaned);
  const cached = await redis.get(key).catch(() => null);
  if (cached) {
    if (cached === 'NO_MATCH') return { wikidataId: null, confidence: 0 };
    try {
      const [id, confRaw] = cached.split('|');
      return { wikidataId: id ?? null, confidence: Number(confRaw ?? 0) };
    } catch {
      // Malformed cache entry — fall through and re-resolve.
    }
  }

  const params = new URLSearchParams({
    action: 'wbsearchentities',
    search: cleaned,
    type: 'item',
    language: 'en',
    format: 'json',
    limit: '5',
    origin: '*',
  });
  const url = `${WIKIDATA_API}?${params.toString()}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  let body: WikidataSearchResponse;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      logger.debug({ status: res.status, name }, 'wikidata: non-OK response');
      await redis.set(key, 'NO_MATCH', 'EX', CACHE_TTL_SEC).catch(() => null);
      return { wikidataId: null, confidence: 0 };
    }
    body = (await res.json()) as WikidataSearchResponse;
  } catch (err) {
    logger.debug({ err, name }, 'wikidata: fetch failed');
    return { wikidataId: null, confidence: 0 };
  } finally {
    clearTimeout(timer);
  }

  const hits = body.search ?? [];
  if (hits.length === 0) {
    await redis.set(key, 'NO_MATCH', 'EX', CACHE_TTL_SEC).catch(() => null);
    return { wikidataId: null, confidence: 0 };
  }
  const top = hits[0]!;
  const labelExact =
    (top.label ?? '').trim().toLowerCase() === cleaned.toLowerCase();
  const desc = (top.description ?? '').toLowerCase();
  const kindMatch =
    kind === 'organization'
      ? /(compan|business|corporation|nonprofit|organ[iz]ation|enterprise|firm|agency|institution|brand)/.test(
          desc,
        )
      : kind === 'product'
        ? /(product|appliance|device|software|application|consumer good|brand)/.test(
            desc,
          )
        : kind === 'person'
          ? // Person descriptions tend to be a role/profession ±
            // a nationality adjective. Cast a wide net.
            /(actor|actress|author|writer|musician|singer|composer|director|producer|painter|sculptor|architect|engineer|scientist|physicist|chemist|biologist|mathematician|economist|philosopher|politician|president|prime minister|senator|journalist|broadcaster|athlete|footballer|player|founder|ceo|entrepreneur|activist|historian|poet|novelist|critic|comedian|game developer|programmer|designer)/.test(
              desc,
            )
          : // 'place' — countries, cities, regions, neighbourhoods.
            /(city|town|country|state|province|region|capital|county|municipality|island|district|village|borough|prefecture|territory|metropolitan|neighborhood|neighbourhood|continent|community)/.test(
              desc,
            );

  let confidence = 0.5;
  if (labelExact && kindMatch) confidence = 1;
  else if (labelExact) confidence = 0.7;
  // Below 0.5 we treat as unresolved — the top match's label
  // didn't even agree, so guessing carries more risk than value.
  if (confidence < 0.5) {
    await redis.set(key, 'NO_MATCH', 'EX', CACHE_TTL_SEC).catch(() => null);
    return { wikidataId: null, confidence: 0 };
  }
  await redis
    .set(key, `${top.id}|${confidence}`, 'EX', CACHE_TTL_SEC)
    .catch(() => null);
  return { wikidataId: top.id, confidence };
}

/**
 * Run the resolver against a single Organization row and persist
 * the verdict (or NO_MATCH timestamp). Throttled: a row that's
 * been touched within REFRESH_MS is skipped.
 */
export async function enrichOrganizationWikidata(key: string): Promise<void> {
  const org = await Organization.findOne({ key })
    .select('key displayName wikidataId wikidataResolvedAt')
    .lean();
  if (!org) return;
  // Skip personal-mail brand keys (form `local@domain`) — Wikidata
  // doesn't have entries for individual email addresses.
  if (key.includes('@')) return;
  const last = org.wikidataResolvedAt
    ? new Date(org.wikidataResolvedAt as Date).getTime()
    : 0;
  if (Date.now() - last < REFRESH_MS) return;
  const name = (org.displayName as string | undefined)?.trim() || key;
  try {
    const r = await resolveWikidata('organization', name);
    await Organization.updateOne(
      { key },
      {
        $set: {
          wikidataId: r.wikidataId,
          wikidataConfidence: r.confidence,
          wikidataResolvedAt: new Date(),
        },
      },
    );
    // Chain into the SPARQL relation enricher when we got a usable
    // Q-ID. Fire-and-forget — a slow Wikidata query mustn't block
    // the sender-upsert path. Throttled internally to one fetch
    // per Q-ID per 90 days.
    if (r.wikidataId && r.confidence >= 0.7) {
      void enrichOrganizationRelations(key).catch((err) =>
        logger.debug({ err, key }, 'wikidata: relation enrich failed'),
      );
    }
  } catch (err) {
    logger.debug(
      { err, key },
      'wikidata: organization enrich failed (continuing)',
    );
  }
}

/**
 * Resolve a Q-ID for a person/place Entity row and persist the
 * verdict. Mirrors `enrichOrganizationWikidata` but writes to the
 * per-user Entity collection (Person + place entities aren't
 * shared globally — yet — so the Q-ID lives where the user can
 * see it without leaking another user's archive's existence).
 *
 * Chains into `enrichEntityRelations` on success so the relation
 * panel gets populated in the same idle pass.
 */
export async function enrichEntityWikidata(
  userId: Types.ObjectId,
  key: string,
): Promise<void> {
  if (!key) return;
  const entity = await Entity.findOne({ userId, key })
    .select('key displayName type wikidataId wikidataResolvedAt')
    .lean();
  if (!entity) return;
  const type = entity.type as string | undefined;
  if (type !== 'person' && type !== 'place') return;
  const last = entity.wikidataResolvedAt
    ? new Date(entity.wikidataResolvedAt as Date).getTime()
    : 0;
  if (Date.now() - last < REFRESH_MS) return;
  const name = (entity.displayName as string | undefined)?.trim() || key;
  try {
    const r = await resolveWikidata(type as 'person' | 'place', name);
    await Entity.updateOne(
      { userId, key },
      {
        $set: {
          wikidataId: r.wikidataId,
          wikidataConfidence: r.confidence,
          wikidataResolvedAt: new Date(),
        },
      },
    );
    if (r.wikidataId && r.confidence >= 0.7) {
      void enrichEntityRelations(userId, key).catch((err) =>
        logger.debug({ err, key }, 'wikidata: entity relation enrich failed'),
      );
    }
  } catch (err) {
    logger.debug(
      { err, key },
      'wikidata: entity enrich failed (continuing)',
    );
  }
}

/** Same idea, for the global Product collection. */
export async function enrichProductWikidata(slugKey: string): Promise<void> {
  const prod = await Product.findOne({ slugKey })
    .select('slugKey name manufacturer wikidataId wikidataResolvedAt')
    .lean();
  if (!prod) return;
  const last = prod.wikidataResolvedAt
    ? new Date(prod.wikidataResolvedAt as Date).getTime()
    : 0;
  if (Date.now() - last < REFRESH_MS) return;
  // For products, prefix the manufacturer when known — disambiguates
  // generic names ("iPhone" vs "Apple iPhone").
  const baseName = (prod.name as string | undefined)?.trim() ?? '';
  const mfr = (prod.manufacturer as string | undefined)?.trim();
  const query = mfr && !baseName.toLowerCase().includes(mfr.toLowerCase())
    ? `${mfr} ${baseName}`
    : baseName;
  try {
    const r = await resolveWikidata('product', query);
    await Product.updateOne(
      { slugKey },
      {
        $set: {
          wikidataId: r.wikidataId,
          wikidataConfidence: r.confidence,
          wikidataResolvedAt: new Date(),
        },
      },
    );
  } catch (err) {
    logger.debug(
      { err, slugKey },
      'wikidata: product enrich failed (continuing)',
    );
  }
}
