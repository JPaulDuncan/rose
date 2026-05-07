import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

/**
 * Normalize a free-text category name into a stable lookup key:
 * lowercase, collapse any run of non-alphanumerics into a single
 * space, trim. So "EMail Marketing", "email-marketing", and
 * "  email   marketing  " all map to "email marketing" — and the
 * Codex shows them as one chapter.
 */
export function normalizeCategoryName(raw: string): string {
  return (raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Words that stay lowercase when not the leading word — keeps
 *  "Tools and Apparel" out of "Tools And Apparel" territory. */
const TITLE_LOWER = new Set([
  'a',
  'an',
  'and',
  'as',
  'at',
  'but',
  'by',
  'for',
  'in',
  'of',
  'on',
  'or',
  'the',
  'to',
  'vs',
  'with',
]);

export const UNCATEGORIZED_NAME = 'Uncategorized';

/**
 * Display-form for a category name. Categories are user-visible and
 * shouldn't read like URL slugs ("email-marketing"). The LLM is
 * inconsistent about capitalisation, so this normalises to Title
 * Case at write time + at render time. Hyphens / underscores fold
 * into spaces; empty input becomes the canonical "Uncategorized"
 * fallback so the UI never has to render a null badge.
 */
export function displayCategoryName(raw: string | null | undefined): string {
  const cleaned = (raw ?? '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return UNCATEGORIZED_NAME;
  return cleaned
    .split(' ')
    .map((word, idx) => {
      const lower = word.toLowerCase();
      if (idx > 0 && TITLE_LOWER.has(lower)) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(' ');
}

const categorySchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    /** Display name — what the user sees. Whatever the LLM emitted
     *  on the first occurrence (e.g. "Email Marketing"). */
    name: { type: String, required: true },
    /** Stable lookup key derived via `normalizeCategoryName`. New
     *  categories index on this so case/punctuation variants don't
     *  produce duplicate Category rows. */
    normalizedName: { type: String, default: '' },
    parentId: { type: Schema.Types.ObjectId, ref: 'Category', default: null },
    color: { type: String, default: null },
    icon: { type: String, default: null },
  },
  { timestamps: true },
);

// Pre-existing installs may not have populated normalizedName yet, so
// the unique-on-name index stays as-is. New code paths upsert by
// `(userId, normalizedName)` and fall back to a name-equality check.
categorySchema.index({ userId: 1, name: 1 }, { unique: true });
categorySchema.index({ userId: 1, normalizedName: 1 });

export type CategoryDoc = HydratedDocument<InferSchemaType<typeof categorySchema>>;
export const Category = model('Category', categorySchema);
