/**
 * Ontology — versioned predicate vocabulary for typed relationships
 * between entities. Lives in @rose/shared so the worker (extractor),
 * the API (validation + read), and the web (rendering) all agree on
 * one source of truth.
 *
 * Why a config rather than a TS enum: predicates age. schema.org has
 * had to deprecate and rename properties; we want to evolve safely
 * without breaking existing audit rows. Each predicate carries an
 * `introducedAt` date and an optional `deprecatedAt`. Old rows
 * referencing a deprecated predicate still validate but are filtered
 * out of new-extraction prompts.
 *
 * Subject/object type hints are advisory, not enforced. The LLM is
 * instructed to obey them, but a row referencing the "wrong" type
 * (e.g. `employer` linking org→org) still persists with reduced
 * confidence — manual review can correct.
 *
 * Inverse relations (`employs` ↔ `employer`) are NOT auto-mirrored
 * at write time. The read API can synthesize the inverse view on
 * demand from the same row; storing twice would double the audit
 * burden and complicate dedup.
 */

import { z } from 'zod';

/** Entity types we admit as relation endpoints. Matches
 *  `Entity.type` enum in @rose/db plus a permissive 'any'. */
export const RELATION_ENDPOINT_TYPES = [
  'person',
  'organization',
  'work',
  'place',
  'any',
] as const;
export type RelationEndpointType = (typeof RELATION_ENDPOINT_TYPES)[number];

export type PredicateDef = {
  /** Stable kebab key persisted on EntityRelation.predicate. */
  key: string;
  /** Verb-phrase rendered on the entity page ("Employer", "Spouse"). */
  label: string;
  /** Inverse phrase rendered when the page is the OBJECT
   *  (page A's Anthropic shows "Employer: Anthropic"; Anthropic's
   *  page shows "Employs: A"). Optional — drops back to the predicate
   *  key when absent. */
  inverseLabel?: string;
  /** Types the subject is expected to be. Advisory. */
  subjectTypes: readonly RelationEndpointType[];
  /** Types the object is expected to be. Advisory. */
  objectTypes: readonly RelationEndpointType[];
  /** Optional schema.org URI for downstream interop / export. */
  schemaOrg?: string;
  /** Optional Wikidata property URI for downstream interop. */
  wikidata?: string;
  /** ISO date this predicate joined the vocabulary. Stable; never
   *  edit on an existing entry — append a new one if a predicate
   *  needs to change shape. */
  introducedAt: string;
  /** Optional ISO date when this predicate was deprecated.
   *  Deprecated predicates still validate (so old EntityRelation
   *  rows resolve) but are excluded from new-extraction prompts. */
  deprecatedAt?: string;
  /** One-line human description shown in admin / docs UIs. */
  description: string;
};

/**
 * The starter vocabulary. Intentionally small — every predicate in
 * here should pay rent in the UI today. Add a new one when a real
 * use case lands, not preemptively.
 */
export const PREDICATES: readonly PredicateDef[] = [
  // ── People → organizations ─────────────────────────────────
  {
    key: 'employer',
    label: 'Employer',
    inverseLabel: 'Employs',
    subjectTypes: ['person'],
    objectTypes: ['organization'],
    schemaOrg: 'https://schema.org/worksFor',
    wikidata: 'https://www.wikidata.org/wiki/Property:P108',
    introducedAt: '2026-05-09',
    description: 'The organization the subject works for.',
  },
  {
    key: 'founder-of',
    label: 'Founder of',
    inverseLabel: 'Founded by',
    subjectTypes: ['person'],
    objectTypes: ['organization'],
    wikidata: 'https://www.wikidata.org/wiki/Property:P112',
    introducedAt: '2026-05-09',
    description: 'The subject founded or co-founded the organization.',
  },
  {
    key: 'member-of',
    label: 'Member of',
    inverseLabel: 'Has member',
    subjectTypes: ['person'],
    objectTypes: ['organization'],
    schemaOrg: 'https://schema.org/memberOf',
    introducedAt: '2026-05-09',
    description: 'The subject belongs to the organization.',
  },

  // ── People → people ───────────────────────────────────────
  {
    key: 'spouse',
    label: 'Spouse',
    inverseLabel: 'Spouse',
    subjectTypes: ['person'],
    objectTypes: ['person'],
    schemaOrg: 'https://schema.org/spouse',
    wikidata: 'https://www.wikidata.org/wiki/Property:P26',
    introducedAt: '2026-05-09',
    description: 'The subject is married to the object.',
  },
  {
    key: 'parent-of',
    label: 'Parent of',
    inverseLabel: 'Child of',
    subjectTypes: ['person'],
    objectTypes: ['person'],
    schemaOrg: 'https://schema.org/parent',
    introducedAt: '2026-05-09',
    description: 'The subject is the parent of the object.',
  },
  {
    key: 'sibling-of',
    label: 'Sibling of',
    inverseLabel: 'Sibling of',
    subjectTypes: ['person'],
    objectTypes: ['person'],
    schemaOrg: 'https://schema.org/sibling',
    introducedAt: '2026-05-09',
    description: 'The subject and object share a parent.',
  },
  {
    key: 'colleague-of',
    label: 'Colleague',
    inverseLabel: 'Colleague',
    subjectTypes: ['person'],
    objectTypes: ['person'],
    schemaOrg: 'https://schema.org/colleague',
    introducedAt: '2026-05-09',
    description:
      'The subject and object work together. Symmetric: emitted once, displayed both ways.',
  },

  // ── Creative attribution ──────────────────────────────────
  {
    key: 'creator-of',
    label: 'Creator of',
    inverseLabel: 'Created by',
    subjectTypes: ['person', 'organization'],
    objectTypes: ['work'],
    schemaOrg: 'https://schema.org/creator',
    wikidata: 'https://www.wikidata.org/wiki/Property:P170',
    introducedAt: '2026-05-09',
    description: 'The subject authored, directed, composed, or produced the work.',
  },

  // ── Organizations → organizations ─────────────────────────
  {
    key: 'subsidiary-of',
    label: 'Subsidiary of',
    inverseLabel: 'Subsidiaries',
    subjectTypes: ['organization'],
    objectTypes: ['organization'],
    schemaOrg: 'https://schema.org/parentOrganization',
    introducedAt: '2026-05-09',
    description: 'The subject is owned or controlled by the object.',
  },
  {
    key: 'partner-of',
    label: 'Partner',
    inverseLabel: 'Partner',
    subjectTypes: ['organization'],
    objectTypes: ['organization'],
    introducedAt: '2026-05-09',
    description:
      'A non-ownership business partnership. Symmetric (both sides see the same row).',
  },
  {
    key: 'competitor-of',
    label: 'Competitor of',
    inverseLabel: 'Competitor of',
    subjectTypes: ['organization'],
    objectTypes: ['organization'],
    introducedAt: '2026-05-09',
    description:
      'The object operates in the same market as the subject. Symmetric.',
  },

  // ── Locations ────────────────────────────────────────────
  {
    key: 'headquartered-in',
    label: 'Headquartered in',
    inverseLabel: 'HQs based here',
    subjectTypes: ['organization'],
    objectTypes: ['place'],
    schemaOrg: 'https://schema.org/location',
    wikidata: 'https://www.wikidata.org/wiki/Property:P159',
    introducedAt: '2026-05-09',
    description: "The organization's primary office is at the location.",
  },
  {
    key: 'born-in',
    label: 'Born in',
    inverseLabel: 'Birthplace of',
    subjectTypes: ['person'],
    objectTypes: ['place'],
    schemaOrg: 'https://schema.org/birthPlace',
    introducedAt: '2026-05-09',
    description: 'The subject was born at the location.',
  },
  {
    key: 'located-in',
    label: 'Located in',
    inverseLabel: 'Contains',
    subjectTypes: ['any'],
    objectTypes: ['place'],
    schemaOrg: 'https://schema.org/containedInPlace',
    introducedAt: '2026-05-09',
    description: 'The subject sits within a larger geographic place.',
  },

  // ── Lineage / succession ─────────────────────────────────
  {
    key: 'successor-of',
    label: 'Successor of',
    inverseLabel: 'Predecessor of',
    subjectTypes: ['any'],
    objectTypes: ['any'],
    introducedAt: '2026-05-09',
    description: 'The subject took over from the object in the same role.',
  },
];

/** Lookup helpers used by the API + worker. */
const PREDICATE_BY_KEY = new Map(PREDICATES.map((p) => [p.key, p]));

export function predicateByKey(key: string): PredicateDef | null {
  return PREDICATE_BY_KEY.get(key) ?? null;
}

/** Predicates eligible for new extractions (excludes deprecated). */
export function activePredicates(): PredicateDef[] {
  return PREDICATES.filter((p) => !p.deprecatedAt);
}

/** Predicates whose subject + object are both 'person' / 'person',
 *  or where one of the inverseLabel + label texts match — used by the
 *  read API to render the relation from EITHER endpoint without
 *  storing a separate inverse row. */
export function isSymmetric(p: PredicateDef): boolean {
  return p.label === (p.inverseLabel ?? p.label);
}

/** Zod-style predicate-key validator. */
export const PredicateKey = z
  .string()
  .min(1)
  .max(60)
  .refine((s) => PREDICATE_BY_KEY.has(s), {
    message: 'unknown predicate',
  });

/** Vocabulary version — bumped any time the array changes shape. */
export const ONTOLOGY_VERSION = '2026-05-09';
