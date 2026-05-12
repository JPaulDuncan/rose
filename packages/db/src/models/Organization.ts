import { Schema, model, type InferSchemaType, type HydratedDocument, Types } from 'mongoose';

/**
 * Global organization registry. Mirrors the SenderBrand pattern —
 * facts that don't change per user (canonical name, aliases,
 * websites, logo, the LLM-written brief) live here and are shared;
 * per-user state (page count, last-seen-on-this-user's-pages,
 * future per-user notes/overrides) stays on the per-user `Entity`
 * row of type='organization' and joins on the kebab `key`.
 *
 * Reads merge: when the SPA fetches `/api/entities/:key` and the
 * entity is an organization, the API combines the user's Entity
 * row with the global Organization row, giving the user the
 * shared facts without re-deriving them (and without one user's
 * displayName edits clobbering another user's).
 *
 * Writes split:
 *   • LLM-extracted entity ingest path → upserts BOTH (per-user
 *     Entity for state, global Organization for facts).
 *   • Manual `POST /api/entities` → same.
 *   • Sender → entity upsert (the brand-as-org bridge) → same.
 *   • Future "edit this org" UI writes to Organization for global
 *     fields (name, aliases, summary), Entity for per-user
 *     overrides.
 *
 * `forgottenBriefBy[]` is the per-user mute for the LLM brief —
 * mirroring SenderBrand. A user who clicks "forget background note
 * for ACME" gets their userId appended; the brief stays around for
 * everyone else.
 */
const organizationSchema = new Schema(
  {
    /** Stable kebab-case lookup key. Same shape Entity.key has,
     *  same value for an org-typed entity. Unique globally — every
     *  user sees the same row when they look up `acme-corp`. */
    key: { type: String, required: true, unique: true, index: true },
    /** Canonical surface form. Whoever first emitted the org wins
     *  the casing; subsequent extractions don't overwrite. The
     *  future "edit this org" surface can promote a user's
     *  override onto this field. */
    displayName: { type: String, required: true },
    /** Other surface forms that should fold into this organization.
     *  Stored kebab-form, deduplicated. Aliases are global; if user
     *  A discovers "ACME, Inc." aliases to `acme-corp`, user B
     *  benefits. */
    aliases: { type: [String], default: [], index: true },
    /** Hostnames + brand sites learned from any user's mail. Useful
     *  for the codex / address-book view and for resolving an
     *  org's web presence. Capped at 10 to keep the row size
     *  bounded. */
    websites: { type: [String], default: [] },
    /** Best logo URL we've inferred. Same source-of-truth shape as
     *  SenderBrand.logoUrl so the page-rail brand chip can render
     *  it whether the page references a sender or an org-typed
     *  entity. */
    logoUrl: { type: String, default: null },
    logoConfidence: { type: Number, default: 0 },
    /** LLM-written 1-paragraph "who is this" brief. Generated once
     *  globally; refresh queues from any user's UI hit the same
     *  row, like SenderBrand.summary. */
    summary: { type: String, default: '' },
    summaryGeneratedAt: { type: Date, default: null },
    summaryModel: { type: String, default: null },
    /** Users who've explicitly forgotten the brief. Per-user mute
     *  rather than a global delete, so anyone else's refresh
     *  resurfaces. */
    forgottenBriefBy: { type: [Schema.Types.ObjectId], default: [], index: true },
    /** Audit-only: first user whose pages surfaced this org. */
    firstSeenBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    /**
     * Wikidata Q-ID, when the ontology resolver has pinned this
     * org to a canonical external entry. Lets cross-user
     * "Anthropic" / "Anthropic, PBC" / "anthropic-ai" collapse
     * onto one knowledge-graph node, lets Daydream hydrate from
     * Wikidata's structured data, and gives federated page-beam
     * a verifiable identity to ship with. Null = unresolved.
     */
    wikidataId: { type: String, default: null, index: true, maxlength: 16 },
    /** Resolver's confidence (0..1). Below ~0.6 means the resolver
     *  found a candidate but couldn't disambiguate strongly. */
    wikidataConfidence: { type: Number, default: 0 },
    /** When the resolver last touched this row. Throttles
     *  re-resolution; resolved rows re-check every 90 days. */
    wikidataResolvedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

export type OrganizationDoc = HydratedDocument<InferSchemaType<typeof organizationSchema>> & {
  _id: Types.ObjectId;
};
export const Organization = model('Organization', organizationSchema);
