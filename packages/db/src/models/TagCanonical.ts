import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

/**
 * Normalize a free-text tag into the stable storage key used as
 * `canonical`. Lowercase, collapse non-alphanumerics into hyphens,
 * trim leading/trailing hyphens. So "Job Listings", "job_listings",
 * and "Job-Listings" all collapse to "job-listings".
 */
export function normalizeTagKey(raw: string): string {
  return (raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Title-case a kebab-style tag for display. "job-listings" →
 * "Job Listings". Used as the default `displayName` when a brand
 * new canonical is created and the LLM didn't suggest one.
 */
export function titleCaseTag(canonical: string): string {
  return canonical
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Global tag synonym registry. Pages keep their tags in the kebab
 * `canonical` form so URLs (`/t/job-listings`) and existing $in
 * queries still work, but the display layer can substitute
 * `displayName` ("Job Listings") and the canonicaliser knows that
 * "job-postings", "remote-work" and "fully-remote" all roll up here.
 *
 * Tags are global across users — the source of truth lives in this
 * collection. Each user "sees" the canonicals that appear on their
 * own Page.tags, but the displayName + aliases for those canonicals
 * are sourced from the shared row. New canonicals discovered by any
 * user's canonicalisation step land here once; subsequent users with
 * the same emitted tag pass through the cheap path.
 *
 * Created lazily by the canonicalisation step in generatePage. The
 * LLM proposes mappings against a list of existing canonicals plus
 * the current page's emitted tags; new canonicals get inserted with
 * a title-cased displayName. Subsequent appearances of the same
 * alias pass through O(1) without touching the LLM.
 */
const tagCanonicalSchema = new Schema(
  {
    /** Audit-only — first user whose canonicalisation step minted
     *  the row. Kept so we can attribute the canonical name on the
     *  settings UI later. Not used for access control; visibility
     *  comes from joining against a user's Page.tags. */
    firstSeenBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    /** Stable lookup key, kebab-case. Globally unique. Used as the
     *  value persisted on Page.tags so search and URL routes don't
     *  have to know about display names. */
    canonical: { type: String, required: true, unique: true, index: true },
    /** Human-readable form rendered as the pill label. Defaults to
     *  `titleCaseTag(canonical)` when the LLM doesn't suggest
     *  something nicer. First write wins via $setOnInsert; later
     *  edits via the API mutate this directly. */
    displayName: { type: String, default: '' },
    /**
     * Other surface forms that map to this canonical. Persisted in
     * normalized kebab form so a quick `aliases: { $in: [...] }`
     * lookup resolves "remote-work" / "fully-remote" /
     * "wfh" → the same canonical. Aliases are global; any user's
     * discovery contributes via $addToSet.
     */
    aliases: { type: [String], default: [], index: true },
    /** Rolling count of pages (across ALL users) that currently
     *  carry this canonical. Maintained lazily — best-effort signal
     *  for the settings UI when offering manual merges. The per-user
     *  count surfaced on the user's Tags settings page is computed
     *  from Page.tags aggregation, not from this field. */
    pageCount: { type: Number, default: 0 },
    /**
     * Embedding of the canonical's display name + a few aliases.
     * Used by the canonicaliser's embedding rung — between edit-
     * distance and the LLM — to fold near-synonyms ("auth" /
     * "authentication", "ml" / "machine-learning") without paying
     * an LLM call. Threshold is intentionally tight (cosine ≥
     * 0.92) so distinct concepts ("python" / "ruby") stay distinct.
     * Lazily computed on first canonicalisation pass that touches
     * the row; `embeddingModel` records which provider/model the
     * vector was minted with so a provider switch invalidates the
     * cache automatically.
     */
    embedding: { type: [Number], default: null, select: false },
    embeddingModel: { type: String, default: null },
  },
  { timestamps: true },
);

tagCanonicalSchema.index({ aliases: 1 });

export type TagCanonicalDoc = HydratedDocument<InferSchemaType<typeof tagCanonicalSchema>>;
export const TagCanonical = model('TagCanonical', tagCanonicalSchema);
