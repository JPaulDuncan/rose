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
 * Per-user tag synonym registry. Pages keep their tags in the kebab
 * `canonical` form so URLs (`/t/job-listings`) and existing $in
 * queries still work, but the display layer can substitute
 * `displayName` ("Job Listings") and the canonicaliser knows that
 * "job-postings", "remote-work" and "fully-remote" all roll up here.
 *
 * Created lazily by the canonicalisation step in generatePage. The
 * LLM proposes mappings against a list of existing canonicals plus
 * the current page's emitted tags; new canonicals get inserted with
 * a title-cased displayName. Subsequent appearances of the same
 * alias pass through O(1) without touching the LLM.
 */
const tagCanonicalSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    /** Stable lookup key, kebab-case. Used as the value persisted
     *  on Page.tags so search and URL routes don't have to know
     *  about display names. */
    canonical: { type: String, required: true },
    /** Human-readable form rendered as the pill label. Defaults to
     *  `titleCaseTag(canonical)` when the LLM doesn't suggest
     *  something nicer. */
    displayName: { type: String, default: '' },
    /**
     * Other surface forms that map to this canonical. Persisted in
     * normalised kebab form so a quick `aliases: { $in: [...] }`
     * lookup resolves "remote-work" / "fully-remote" /
     * "wfh" → the same canonical.
     */
    aliases: { type: [String], default: [], index: true },
    /** Rolling count of pages that currently carry this canonical.
     *  Maintained lazily — best-effort signal for the settings UI to
     *  surface heavy tags first when offering manual merges. */
    pageCount: { type: Number, default: 0 },
    /**
     * Optional embedding of the canonical (for future use by a
     * settings-side merge tool that wants to surface
     * "tags-that-look-similar"). Not consulted on the hot path —
     * canonicalisation is LLM-driven, not embedding-driven, because
     * the LLM is the only thing that reliably distinguishes
     * "remote-work" from "remote-controlled-toys".
     */
    embedding: { type: [Number], default: null, select: false },
    embeddingModel: { type: String, default: null },
  },
  { timestamps: true },
);

tagCanonicalSchema.index({ userId: 1, canonical: 1 }, { unique: true });
tagCanonicalSchema.index({ userId: 1, aliases: 1 });

export type TagCanonicalDoc = HydratedDocument<InferSchemaType<typeof tagCanonicalSchema>>;
export const TagCanonical = model('TagCanonical', tagCanonicalSchema);
