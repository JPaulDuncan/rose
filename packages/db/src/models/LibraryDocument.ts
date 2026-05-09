import { Schema, model, type InferSchemaType, type HydratedDocument, Types } from 'mongoose';

/**
 * One crawled item — stored GLOBALLY, deduplicated by URL hash.
 * Whoever first crawls the URL persists the row; subsequent users
 * whose sources surface the same URL don't re-fetch or re-embed.
 * They get visibility through a per-user `LibraryDocumentRef` row
 * that points at this global document.
 *
 * Mirrors the SenderBrand / Sender split: facts that don't change
 * per user (URL, title, body, topics, embedding) live here; per-user
 * state (which source surfaced it, archived/read flags, private
 * tags) lives on `LibraryDocumentRef`.
 *
 * Body text is capped at 50KB; summary at 280 chars; embedding
 * lives in the same vector space as Page.embedding so a future
 * unified-search surface can rank Pages and LibraryDocuments
 * together with no re-embed.
 */
const docSchema = new Schema(
  {
    /** Audit-only — first user whose source surfaced this URL.
     *  Kept so we can attribute the canonical name on the brand
     *  chip later. Not used for access control; per-user visibility
     *  comes from LibraryDocumentRef. */
    firstSeenBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    /** Source that originally created the row. Refs carry the
     *  source per-user separately, so this is just for audit. */
    firstSourceId: {
      type: Schema.Types.ObjectId,
      ref: 'LibrarySource',
      default: null,
    },
    url: { type: String, required: true },
    /** SHA-256(url). Globally unique — the dedup key. */
    urlHash: { type: String, required: true, unique: true, index: true },
    title: { type: String, default: '' },
    author: { type: String, default: '' },
    publishedAt: { type: Date, default: null, index: true },
    summary: { type: String, default: '' },
    /** Plain-text body, capped at ~50KB. */
    bodyText: { type: String, default: '' },
    /** LLM-extracted topics (defer until library-extract job runs). */
    topics: { type: [String], default: [] },
    /** Inherited from the source + LLM augmentation. Global tags;
     *  per-user tags live on the Ref. */
    tags: { type: [String], default: [], index: true },
    /** Same vector space as Page.embedding. select: false to keep
     *  document-list responses small. Computed once globally. */
    embedding: { type: [Number], default: null, select: false },
    embeddingModel: { type: String, default: null },
    crawledAt: { type: Date, default: () => new Date() },
    /** Re-crawl is allowed after this date. Library-sync sweeper
     *  can refresh stale URL-kind documents on schedule. */
    staleAfter: { type: Date, default: null, index: true },
  },
  { timestamps: true },
);

// publishedAt is the typical sort key for the recent-feed view.
docSchema.index({ publishedAt: -1 });
docSchema.index(
  { title: 'text', summary: 'text', bodyText: 'text', topics: 'text', tags: 'text' },
  { weights: { title: 10, summary: 5, topics: 3, tags: 3, bodyText: 1 }, name: 'LibraryDocText' },
);

export type LibraryDocumentDoc = HydratedDocument<InferSchemaType<typeof docSchema>> & {
  _id: Types.ObjectId;
};
export const LibraryDocument = model('LibraryDocument', docSchema);
