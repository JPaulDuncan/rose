import { Schema, model, type InferSchemaType, type HydratedDocument, Types } from 'mongoose';

/**
 * One crawled item from a LibrarySource. Stored per-user so search +
 * embeddings stay scoped; the same RSS post crawled by two users
 * produces two documents (with two embeddings — see plan 10's
 * "shared library" out-of-scope note).
 *
 * Body text is capped at 50KB; summary at 280 chars; embedding
 * lives in the same vector space as Page.embedding so a future
 * unified-search surface can rank Pages and LibraryDocuments
 * together with no re-embed.
 */
const docSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    sourceId: {
      type: Schema.Types.ObjectId,
      ref: 'LibrarySource',
      required: true,
      index: true,
    },
    url: { type: String, required: true },
    /** SHA-256(url), unique per user, dedup-on-crawl. */
    urlHash: { type: String, required: true },
    title: { type: String, default: '' },
    author: { type: String, default: '' },
    publishedAt: { type: Date, default: null, index: true },
    summary: { type: String, default: '' },
    /** Plain-text body, capped at ~50KB. */
    bodyText: { type: String, default: '' },
    /** LLM-extracted topics (defer until library-extract job runs). */
    topics: { type: [String], default: [] },
    /** Inherited from the source + LLM augmentation. */
    tags: { type: [String], default: [], index: true },
    /** Same vector space as Page.embedding. select: false to keep
     *  document-list responses small. */
    embedding: { type: [Number], default: null, select: false },
    embeddingModel: { type: String, default: null },
    crawledAt: { type: Date, default: () => new Date() },
    /** Re-crawl is allowed after this date. Library-sync sweeper
     *  can refresh stale URL-kind documents on schedule. */
    staleAfter: { type: Date, default: null, index: true },
  },
  { timestamps: true },
);

docSchema.index({ userId: 1, urlHash: 1 }, { unique: true });
docSchema.index({ userId: 1, sourceId: 1, publishedAt: -1 });
docSchema.index(
  { title: 'text', summary: 'text', bodyText: 'text', topics: 'text', tags: 'text' },
  { weights: { title: 10, summary: 5, topics: 3, tags: 3, bodyText: 1 }, name: 'LibraryDocText' },
);

export type LibraryDocumentDoc = HydratedDocument<InferSchemaType<typeof docSchema>> & {
  _id: Types.ObjectId;
};
export const LibraryDocument = model('LibraryDocument', docSchema);
