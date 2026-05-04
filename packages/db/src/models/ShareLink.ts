import { Schema, model, type InferSchemaType, type HydratedDocument, Types } from 'mongoose';

/**
 * Read-only public link to a single page (or, in the future, a
 * category / tag). The `slug` is a short random token; password is
 * argon2-hashed when set; revoked / expired links 410.
 *
 * `targetType='page'` keys on `targetId`; `tag` keys on `targetTag`.
 * Only `page` is wired in v1.
 */
const shareLinkSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    targetType: { type: String, enum: ['page', 'tag', 'category'], required: true },
    targetId: { type: Schema.Types.ObjectId, default: null },
    targetTag: { type: String, default: null },
    /** Random URL-safe slug used in /share/:slug. */
    slug: { type: String, required: true, unique: true, index: true },
    /** argon2 hash; stored only when set. */
    passwordHash: { type: String, default: null, select: false },
    expiresAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    viewCount: { type: Number, default: 0 },
    /** Display label set by the user, e.g. "Q2 review" — surfaced on
     *  the share dashboard. */
    label: { type: String, default: '' },
    /** Whether the rendered HTML opts into search-engine indexing
     *  (default: noindex). */
    indexable: { type: Boolean, default: false },
  },
  { timestamps: true },
);

shareLinkSchema.index({ userId: 1, createdAt: -1 });

export type ShareLinkDoc = HydratedDocument<InferSchemaType<typeof shareLinkSchema>> & {
  _id: Types.ObjectId;
};
export const ShareLink = model('ShareLink', shareLinkSchema);
