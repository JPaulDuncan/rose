import { Schema, model, type InferSchemaType, type HydratedDocument, Types } from 'mongoose';

/**
 * Per-user reference into the global LibraryDocument collection.
 * Splits the old per-user library row into:
 *
 *   • LibraryDocument  — global facts (URL, title, body, embedding).
 *                        One row per URL, shared across users.
 *   • LibraryDocumentRef (this) — per-user state (which source
 *                        surfaced it, when this user added it,
 *                        per-user tags / archive / read state /
 *                        private notes).
 *
 * Mirrors the SenderBrand / Sender split. The dedup goal is that
 * if user A's RSS pulls an article and user B's source later
 * surfaces the same URL, we don't re-fetch, re-store, or re-embed
 * — user B just gets a Ref pointing at the existing global doc.
 */
const refSchema = new Schema(
  {
    /** Owner of this slice. */
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    /** Global document this ref points at. */
    documentId: {
      type: Schema.Types.ObjectId,
      ref: 'LibraryDocument',
      required: true,
      index: true,
    },
    /** Which of the user's LibrarySource rows surfaced the URL.
     *  Used so a delete-source cascade can trim a user's refs
     *  without touching the shared doc. */
    sourceId: {
      type: Schema.Types.ObjectId,
      ref: 'LibrarySource',
      required: true,
      index: true,
    },
    /** When this user first acquired the doc — usually the crawl
     *  time but stays stable on later refreshes of the global doc. */
    addedAt: { type: Date, default: () => new Date(), index: true },
    /** Per-user soft-archive marker. Hidden from the recent feed
     *  and the daydream adapter when set, but the global doc
     *  remains intact for everyone else. */
    archivedAt: { type: Date, default: null, index: true },
    /** When the user opened the doc. Drives unread badges and
     *  future "what have I read?" surfaces. Null = unread. */
    readAt: { type: Date, default: null },
    /** User-added tags layered on top of the global doc's tags
     *  without polluting other users' views. Lower-case kebab. */
    userTags: { type: [String], default: [], index: true },
    /** Private note the user attached to this entry. Not visible
     *  to anyone else. Capped at ~2KB. */
    userNote: { type: String, default: '', maxlength: 2000 },
  },
  { timestamps: true },
);

// One ref per (user, doc) — a user can't double-add the same doc.
refSchema.index({ userId: 1, documentId: 1 }, { unique: true });
// Recent-feed scan path.
refSchema.index({ userId: 1, addedAt: -1 });

export type LibraryDocumentRefDoc = HydratedDocument<InferSchemaType<typeof refSchema>> & {
  _id: Types.ObjectId;
};
export const LibraryDocumentRef = model('LibraryDocumentRef', refSchema);
