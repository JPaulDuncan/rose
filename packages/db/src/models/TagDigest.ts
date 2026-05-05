import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

/**
 * One LLM-written daily digest for a tag, keyed by UTC day. The
 * featured-tags newsletter section on the home edition reads this
 * for its lede; the tag page renders it above the page list. We
 * keep one row per (userId, tag, dayKey) so the morning regen and
 * any same-day on-demand regens collapse to a single row, but a
 * future archive surface can list past days.
 */
const digestSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    /** Lowercased tag — matches Page.tags / Page.topics entries. */
    tag: { type: String, required: true },
    /** UTC YYYY-MM-DD. One digest per tag per day. */
    dayKey: { type: String, required: true },
    /** Newspaper-style headline, ≤ 90 chars. The lede the home
     *  feature section displays above the carousel. */
    headline: { type: String, default: '' },
    /** "Dek" — the secondary headline / standfirst, ≤ 200 chars. */
    dek: { type: String, default: '' },
    /** Body paragraph, ≤ 800 chars markdown. Inverted-pyramid prose,
     *  newest developments first; cited inline using [pX] tokens
     *  that map back to topPageIds. */
    bodyMd: { type: String, default: '' },
    /** Page IDs in the order the LLM cited them (p1, p2, …). */
    topPageIds: { type: [Schema.Types.ObjectId], default: [] },
    /** Provenance — provider:model that wrote this digest. */
    model: { type: String, default: null },
    generatedAt: { type: Date, default: () => new Date() },
    /** Diagnostic: how many pages this digest's view of the world covered. */
    pageCount: { type: Number, default: 0 },
    /** True if the LLM call failed; UI degrades to the page list with no lede. */
    failed: { type: Boolean, default: false },
    failureReason: { type: String, default: null },
  },
  { timestamps: true },
);

digestSchema.index({ userId: 1, tag: 1, dayKey: 1 }, { unique: true });
digestSchema.index({ userId: 1, tag: 1, generatedAt: -1 });

export type TagDigestDoc = HydratedDocument<InferSchemaType<typeof digestSchema>>;
export const TagDigest = model('TagDigest', digestSchema);
