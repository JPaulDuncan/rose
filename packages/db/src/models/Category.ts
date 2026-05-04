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
