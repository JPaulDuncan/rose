import { Organization, EntityRelation } from '@rose/db';
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
 * Fetch every interesting relation for one organization's Q-ID
 * from Wikidata. The query asks for ?prop ?value ?valueLabel across
 * all our mapped properties in a single round trip — the SPARQL
 * service inlines labels via the standard `wikibase:label` service.
 */
async function fetchOrgRelations(qid: string): Promise<
  Array<{
    property: string;
    targetQid: string;
    targetLabel: string;
  }>
> {
  // Build a `VALUES` clause listing every property we care about.
  const propsClause = ORG_PROPERTIES.map((p) => `wdt:${p.property}`).join(' ');
  const query = `
    SELECT ?prop ?value ?valueLabel WHERE {
      VALUES (?prop) { ${propsClause
        .split(' ')
        .map((p) => `(${p})`)
        .join(' ')} }
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

/**
 * Resolve a Q-ID to a local kebab key when an Organization in our
 * own collection already has that wikidataId. Lets the relation row's
 * fromKey/toKey use a familiar value when possible, instead of
 * always falling back to the Q-ID itself.
 */
async function localKeyForQid(qid: string): Promise<string | null> {
  const org = await Organization.findOne({ wikidataId: qid })
    .select('key')
    .lean();
  return org?.key ?? null;
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

/** Whether the relation enricher should re-run for this org now.
 *  Cached lookup; mirrors the resolver's REFRESH_MS throttle. */
export async function isRelationEnrichmentDue(qid: string): Promise<boolean> {
  const cached = await redis.get(cacheKey(qid)).catch(() => null);
  void REFRESH_MS; // referenced for documentation; throttle lives in the cache TTL
  return cached !== 'OK';
}
