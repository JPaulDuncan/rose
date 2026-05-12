import type { Types } from 'mongoose';
import { Entity, Organization, EntityRelation } from '@rose/db';
import { redis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';

/**
 * Wikidata SPARQL relation fetcher. For an Organization with a
 * resolved Q-ID we can pull canonical relations (founder, HQ,
 * parent org, predecessor) straight from Wikidata — fully sourced,
 * zero LLM cost. The output upserts into EntityRelation with
 * `wikidataConfirmed: true`, making the rows visible to every
 * user (it's public knowledge) without an archive evidence entry.
 *
 * Property map (org-centric, since orgs are what we resolve today):
 *   P112  founder        → predicate `founder-of` (subj = founder, obj = org)
 *   P159  HQ location    → `headquartered-in` (subj = org, obj = place)
 *   P749  parent org     → `subsidiary-of` (subj = org, obj = parent)
 *   P127  owned by       → `subsidiary-of` (same shape as P749 when org-typed)
 *   P155  follows        → `successor-of` (subj = org, obj = predecessor)
 *   P156  followed by    → `successor-of` (subj = successor, obj = org)
 *
 * Persons / places are resolvable later when entity-level
 * Wikidata enrichment lands; the SPARQL machinery generalises.
 */

const SPARQL_ENDPOINT = 'https://query.wikidata.org/sparql';
const UA =
  'Rose/1.0 (+https://github.com/anthropics/rose; ontology/wikidata-relations)';
const HTTP_TIMEOUT_MS = 12_000;
/** 90-day cache. Same window as the Q-ID resolver — these facts
 *  drift slowly and rate-limit-wise we want one fetch per org per
 *  quarter at most. */
const CACHE_TTL_SEC = 90 * 24 * 3600;
const REFRESH_MS = 90 * 24 * 3600 * 1000;

/**
 * Outgoing properties on the org's Q-ID that we care about, with
 * the mapping logic that decides which predicate + direction the
 * resulting triple takes.
 */
type OrgPropertyMapping = {
  /** Wikidata property ID, no `wdt:` prefix. */
  property: string;
  /** What our predicate vocabulary calls it. */
  predicate: string;
  /** When true, the org is the OBJECT of the triple and the
   *  Wikidata value is the SUBJECT (e.g. founder: the person is
   *  the subject of "founder-of", the org is the object). */
  orgIsObject: boolean;
};

const ORG_PROPERTIES: readonly OrgPropertyMapping[] = [
  { property: 'P112', predicate: 'founder-of', orgIsObject: true },
  { property: 'P159', predicate: 'headquartered-in', orgIsObject: false },
  { property: 'P749', predicate: 'subsidiary-of', orgIsObject: false },
  { property: 'P127', predicate: 'subsidiary-of', orgIsObject: false },
  { property: 'P155', predicate: 'successor-of', orgIsObject: false },
  { property: 'P156', predicate: 'successor-of', orgIsObject: true },
];

/**
 * Person + place property maps. Same shape as `ORG_PROPERTIES` but
 * `entityIsObject` reads as "is the local entity the OBJECT side of
 * the resulting triple?" (e.g. P19 birth place: the person is the
 * SUBJECT, the place is the OBJECT, so `entityIsObject: false`).
 */
type EntityPropertyMapping = {
  property: string;
  predicate: string;
  entityIsObject: boolean;
};

const PERSON_PROPERTIES: readonly EntityPropertyMapping[] = [
  // P108 — employer.
  { property: 'P108', predicate: 'employer', entityIsObject: false },
  // P26 — spouse. Symmetric predicate; direction here is arbitrary.
  { property: 'P26', predicate: 'spouse', entityIsObject: false },
  // P19 — place of birth.
  { property: 'P19', predicate: 'born-in', entityIsObject: false },
  // P22 / P25 — parents. The local person is the CHILD; the
  // Wikidata value is the parent ⇒ value is SUBJECT of "parent-of".
  { property: 'P22', predicate: 'parent-of', entityIsObject: true },
  { property: 'P25', predicate: 'parent-of', entityIsObject: true },
  // P40 — child. The local person is the PARENT; value is child ⇒
  // local IS the subject of "parent-of".
  { property: 'P40', predicate: 'parent-of', entityIsObject: false },
  // P3373 — sibling. Symmetric.
  { property: 'P3373', predicate: 'sibling-of', entityIsObject: false },
];

const PLACE_PROPERTIES: readonly EntityPropertyMapping[] = [
  // P17 — country. Place is contained within a country.
  { property: 'P17', predicate: 'located-in', entityIsObject: false },
  // P131 — located in the administrative entity. Granular containment
  // (city → state, state → country). Useful for breadcrumbs.
  { property: 'P131', predicate: 'located-in', entityIsObject: false },
];

type SparqlBinding = {
  prop: { value: string };
  value: { value: string };
  valueLabel: { value: string };
};

type SparqlResponse = {
  results?: {
    bindings?: SparqlBinding[];
  };
};

function cacheKey(orgQid: string): string {
  return `wikidata:relations:v1:${orgQid}`;
}

function extractQid(uri: string): string | null {
  const m = /\/(Q\d+)$/.exec(uri);
  return m?.[1] ?? null;
}

function extractProperty(uri: string): string | null {
  const m = /\/(P\d+)$/.exec(uri);
  return m?.[1] ?? null;
}

/**
 * Run one SPARQL query against Wikidata's endpoint. Returns the
 * raw bindings array; the caller maps. Best-effort: HTTP failures
 * log and return [].
 */
async function runSparql(query: string): Promise<SparqlBinding[]> {
  const params = new URLSearchParams({ query, format: 'json' });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(`${SPARQL_ENDPOINT}?${params.toString()}`, {
      headers: { 'User-Agent': UA, Accept: 'application/sparql-results+json' },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      logger.debug({ status: res.status }, 'wikidata-relations: non-OK');
      return [];
    }
    const body = (await res.json()) as SparqlResponse;
    return body.results?.bindings ?? [];
  } catch (err) {
    logger.debug({ err }, 'wikidata-relations: fetch failed');
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch every interesting relation for one Q-ID from Wikidata,
 * restricted to `properties`. The query asks for ?prop ?value
 * ?valueLabel across all listed properties in a single round trip —
 * the SPARQL service inlines labels via the standard
 * `wikibase:label` service.
 */
async function fetchRelationsForQid(
  qid: string,
  properties: readonly string[],
): Promise<
  Array<{
    property: string;
    targetQid: string;
    targetLabel: string;
  }>
> {
  // Build a `VALUES` clause listing every property we care about.
  const propsClause = properties.map((p) => `(wdt:${p})`).join(' ');
  const query = `
    SELECT ?prop ?value ?valueLabel WHERE {
      VALUES (?prop) { ${propsClause} }
      wd:${qid} ?prop ?value .
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    }
    LIMIT 100
  `;
  const bindings = await runSparql(query);
  const out: Array<{ property: string; targetQid: string; targetLabel: string }> =
    [];
  for (const b of bindings) {
    const property = extractProperty(b.prop?.value ?? '');
    const targetQid = extractQid(b.value?.value ?? '');
    const targetLabel = (b.valueLabel?.value ?? '').trim();
    if (!property || !targetQid) continue;
    out.push({ property, targetQid, targetLabel });
  }
  return out;
}

/** Back-compat alias retained for callers that imported the
 *  previous name. New code calls `fetchRelationsForQid` directly. */
async function fetchOrgRelations(qid: string) {
  return fetchRelationsForQid(
    qid,
    ORG_PROPERTIES.map((p) => p.property),
  );
}

/**
 * Resolve a Q-ID to a local kebab key when an Organization or a
 * per-user Entity in our own collections already carries that
 * wikidataId. Lets the relation row's fromKey/toKey use a familiar
 * value when possible, instead of always falling back to the Q-ID
 * itself.
 *
 * `userId` is optional — Entity rows are per-user. When provided,
 * we prefer a matching Entity row in the same user's scope (so a
 * relation between two of their entities resolves to local kebabs
 * on both ends). When absent we still check Organization (global).
 */
async function localKeyForQid(
  qid: string,
  userId?: Types.ObjectId,
): Promise<string | null> {
  const org = await Organization.findOne({ wikidataId: qid })
    .select('key')
    .lean();
  if (org?.key) return org.key as string;
  if (userId) {
    const ent = await Entity.findOne({ userId, wikidataId: qid })
      .select('key')
      .lean();
    if (ent?.key) return ent.key as string;
  }
  return null;
}

/**
 * Run the relation extractor against one Organization with a Q-ID.
 * Upserts into EntityRelation with `wikidataConfirmed: true`.
 * Idempotent — re-running on the same org with the same property
 * + value bumps `updatedAt` but doesn't duplicate.
 */
export async function enrichOrganizationRelations(orgKey: string): Promise<void> {
  const org = await Organization.findOne({ key: orgKey })
    .select('key displayName wikidataId wikidataConfidence')
    .lean();
  if (!org?.wikidataId) return;
  // Skip very-low-confidence Q-IDs — we don't want to attribute
  // public facts to the wrong entity. Threshold matches the
  // resolver's "high confidence" tier.
  if ((org.wikidataConfidence as number | undefined) ?? 0 < 0.7) return;

  const qid = org.wikidataId as string;

  // Throttle: 90-day refresh. The cache key doubles as a "ran on"
  // marker — if we have a cached fact set, skip the SPARQL fetch.
  const cached = await redis.get(cacheKey(qid)).catch(() => null);
  if (cached === 'OK') return;

  let relations;
  try {
    relations = await fetchOrgRelations(qid);
  } catch (err) {
    logger.debug({ err, orgKey, qid }, 'wikidata-relations: fetch failed');
    return;
  }
  if (relations.length === 0) {
    // Nothing to upsert, but cache the empty result so the next
    // pass doesn't re-fetch for the full refresh window.
    await redis
      .set(cacheKey(qid), 'OK', 'EX', CACHE_TTL_SEC)
      .catch(() => null);
    return;
  }

  const orgDisplayName =
    (org.displayName as string | undefined)?.trim() || orgKey;

  let upserted = 0;
  for (const r of relations) {
    const mapping = ORG_PROPERTIES.find((p) => p.property === r.property);
    if (!mapping) continue;
    // Try to resolve the target Q-ID to a local kebab. If we have
    // an Organization row with this wikidataId, prefer its kebab
    // key so user-archive relations and Wikidata relations can
    // share the same row.
    const targetLocalKey = await localKeyForQid(r.targetQid);
    const targetKey = targetLocalKey ?? r.targetQid;
    const targetDisplayName = r.targetLabel || r.targetQid;

    // Direction: orgIsObject means the org is the OBJECT of the
    // triple, the Wikidata value is the SUBJECT.
    const fromKey = mapping.orgIsObject ? targetKey : orgKey;
    const toKey = mapping.orgIsObject ? orgKey : targetKey;
    const fromDisplayName = mapping.orgIsObject
      ? targetDisplayName
      : orgDisplayName;
    const toDisplayName = mapping.orgIsObject
      ? orgDisplayName
      : targetDisplayName;

    try {
      await EntityRelation.updateOne(
        { fromKey, predicate: mapping.predicate, toKey },
        {
          $setOnInsert: {
            fromKey,
            predicate: mapping.predicate,
            toKey,
          },
          $set: {
            wikidataConfirmed: true,
            fromDisplayName,
            toDisplayName,
          },
          // Wikidata is the source of truth for these — bump
          // confidence to 0.95 so they outrank weaker archive
          // claims in the read-path ranking.
          $max: { confidence: 0.95 },
        },
        { upsert: true },
      );
      upserted += 1;
    } catch (err) {
      logger.warn(
        { err, fromKey, predicate: mapping.predicate, toKey },
        'wikidata-relations: upsert failed (continuing)',
      );
    }
  }

  // Mark this org as freshly fetched so the next pass skips
  // until the refresh window rolls.
  await redis
    .set(cacheKey(qid), 'OK', 'EX', CACHE_TTL_SEC)
    .catch(() => null);
  if (upserted > 0) {
    logger.info(
      { orgKey, qid, upserted },
      'wikidata-relations: enriched',
    );
  }
}

/**
 * Run the relation extractor against one per-user Entity (person /
 * place) with a resolved Q-ID. Same upsert semantics as
 * `enrichOrganizationRelations`: rows land in EntityRelation with
 * `wikidataConfirmed: true`, the relation cache key gates the
 * SPARQL fetch to one per 90 days, and dedup is by triple.
 *
 * Note: EntityRelation is global, but the SOURCE entity here is
 * per-user. We still upsert the Wikidata fact globally because it
 * is public knowledge — multiple users surfacing the same person
 * will all see the same relation row, and `wikidataConfirmed`
 * exempts the row from per-user evidence filtering.
 */
export async function enrichEntityRelations(
  userId: Types.ObjectId,
  entityKey: string,
): Promise<void> {
  const entity = await Entity.findOne({ userId, key: entityKey })
    .select('key displayName type wikidataId wikidataConfidence')
    .lean();
  if (!entity?.wikidataId) return;
  if (((entity.wikidataConfidence as number | undefined) ?? 0) < 0.7) return;
  const type = entity.type as string | undefined;
  const properties =
    type === 'person'
      ? PERSON_PROPERTIES
      : type === 'place'
        ? PLACE_PROPERTIES
        : null;
  if (!properties) return;
  const qid = entity.wikidataId as string;

  const cached = await redis.get(cacheKey(qid)).catch(() => null);
  if (cached === 'OK') return;

  let relations;
  try {
    relations = await fetchRelationsForQid(
      qid,
      properties.map((p) => p.property),
    );
  } catch (err) {
    logger.debug({ err, entityKey, qid }, 'wikidata-relations: entity fetch failed');
    return;
  }
  if (relations.length === 0) {
    await redis
      .set(cacheKey(qid), 'OK', 'EX', CACHE_TTL_SEC)
      .catch(() => null);
    return;
  }

  const entityDisplayName =
    (entity.displayName as string | undefined)?.trim() || entityKey;

  let upserted = 0;
  for (const r of relations) {
    const mapping = properties.find((p) => p.property === r.property);
    if (!mapping) continue;
    const targetLocalKey = await localKeyForQid(r.targetQid, userId);
    const targetKey = targetLocalKey ?? r.targetQid;
    const targetDisplayName = r.targetLabel || r.targetQid;

    const fromKey = mapping.entityIsObject ? targetKey : entityKey;
    const toKey = mapping.entityIsObject ? entityKey : targetKey;
    const fromDisplayName = mapping.entityIsObject
      ? targetDisplayName
      : entityDisplayName;
    const toDisplayName = mapping.entityIsObject
      ? entityDisplayName
      : targetDisplayName;

    try {
      await EntityRelation.updateOne(
        { fromKey, predicate: mapping.predicate, toKey },
        {
          $setOnInsert: { fromKey, predicate: mapping.predicate, toKey },
          $set: {
            wikidataConfirmed: true,
            fromDisplayName,
            toDisplayName,
          },
          $max: { confidence: 0.95 },
        },
        { upsert: true },
      );
      upserted += 1;
    } catch (err) {
      logger.warn(
        { err, fromKey, predicate: mapping.predicate, toKey },
        'wikidata-relations: entity upsert failed (continuing)',
      );
    }
  }

  await redis
    .set(cacheKey(qid), 'OK', 'EX', CACHE_TTL_SEC)
    .catch(() => null);
  if (upserted > 0) {
    logger.info(
      { entityKey, qid, upserted, type },
      'wikidata-relations: entity enriched',
    );
  }
}

/** Whether the relation enricher should re-run for this org now.
 *  Cached lookup; mirrors the resolver's REFRESH_MS throttle. */
export async function isRelationEnrichmentDue(qid: string): Promise<boolean> {
  const cached = await redis.get(cacheKey(qid)).catch(() => null);
  void REFRESH_MS; // referenced for documentation; throttle lives in the cache TTL
  return cached !== 'OK';
}
