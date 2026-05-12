import { Schema, model, type InferSchemaType, type HydratedDocument, Types } from 'mongoose';

/**
 * One typed relationship between two entities. Stored GLOBALLY
 * (one canonical "Anthropic employs Dario") but the `evidence`
 * array is multi-user — each entry names the user whose archive
 * surfaced the relation, the page that minted it, and a snippet
 * grounding the claim. Users only see relations their own archive
 * has evidence for; admins can opt into the global view.
 *
 * Dedup key: `(fromKey, predicate, toKey)` triple. Re-extractions
 * append additional evidence rather than duplicating the relation.
 * Inverse relations (employs ↔ employer) are NOT stored as
 * separate rows — the read API renders the inverse from the same
 * triple. See @rose/shared `predicateByKey` for the metadata.
 *
 * Endpoint identity: today `fromKey` / `toKey` are kebab-cased
 * Entity.key strings. Once Wikidata enrichment lands they MAY
 * be Q-IDs ("Q103814476") instead; the resolver migration will
 * walk existing rows. Mixed forms are tolerated during the
 * transition window — the read API normalises both.
 */
const evidenceSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    pageId: { type: Schema.Types.ObjectId, ref: 'Page', required: true },
    /** ≤240 char body excerpt that justifies the claim. */
    snippet: { type: String, default: '', maxlength: 240 },
    /** Hash of the contentMd at extraction time — lets a regen
     *  detect "the body changed; re-extract" without duplicating. */
    contentHash: { type: String, default: '' },
    extractedAt: { type: Date, default: () => new Date() },
  },
  { _id: false },
);

const relationSchema = new Schema(
  {
    /** Audit — first user whose extraction minted this row. */
    firstSeenBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    /** Kebab-key or Wikidata Q-ID of the subject. */
    fromKey: { type: String, required: true, index: true },
    /** Closed-vocabulary predicate. See @rose/shared `PREDICATES`. */
    predicate: { type: String, required: true, index: true },
    /** Kebab-key or Q-ID of the object. */
    toKey: { type: String, required: true, index: true },
    /** Optional date qualifiers: when the relation began / ended.
     *  Useful for "Dario was at OpenAI from X to Y, now founder of
     *  Anthropic." Null = unknown / ongoing. */
    since: { type: Date, default: null },
    until: { type: Date, default: null },
    /** Aggregate confidence — max across all evidence entries.
     *  Lets the UI rank weaker hearsay below high-confidence claims. */
    confidence: { type: Number, default: 0.5, min: 0, max: 1 },
    /** Per-user evidence trail. Capped at 50 entries (FIFO) so a
     *  popular relation doesn't bloat the row indefinitely. */
    evidence: { type: [evidenceSchema], default: [] },
    /**
     * When true, this relation was sourced from Wikidata (public
     * knowledge), so it's visible to every user regardless of
     * whether their archive has surfaced it. Archive-sourced
     * relations stay user-scoped via the `evidence.userId` filter.
     * A relation can be confirmed by BOTH sources — the field
     * stays true once Wikidata has spoken, and an archive evidence
     * entry can still accumulate.
     */
    wikidataConfirmed: { type: Boolean, default: false, index: true },
    /** Display name for the subject endpoint when the kebab key
     *  doesn't resolve to a local Entity (e.g. when the toKey is
     *  a Q-ID). Stored on the row so the read API doesn't need a
     *  follow-up Wikidata fetch per request. */
    fromDisplayName: { type: String, default: null, maxlength: 200 },
    /** Same as `fromDisplayName`, for the object endpoint. */
    toDisplayName: { type: String, default: null, maxlength: 200 },
  },
  { timestamps: true },
);

// Unique on the triple — repeated extractions push evidence,
// they don't insert a new row.
relationSchema.index(
  { fromKey: 1, predicate: 1, toKey: 1 },
  { unique: true },
);
// Per-endpoint lookups for the UI panel.
relationSchema.index({ fromKey: 1, predicate: 1 });
relationSchema.index({ toKey: 1, predicate: 1 });
// Per-user evidence lookup so a "show me relations evidenced by
// my archive" query stays cheap.
relationSchema.index({ 'evidence.userId': 1 });

export type EntityRelationDoc = HydratedDocument<InferSchemaType<typeof relationSchema>> & {
  _id: Types.ObjectId;
};
export const EntityRelation = model('EntityRelation', relationSchema);
