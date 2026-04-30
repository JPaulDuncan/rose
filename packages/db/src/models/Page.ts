import { Schema, model, type InferSchemaType, type HydratedDocument, Types } from 'mongoose';

const pageSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    slug: { type: String, required: true },
    title: { type: String, required: true },
    summary: { type: String, default: '' },
    contentMd: { type: String, default: '' },
    tags: { type: [String], default: [], index: true },
    categoryId: { type: Schema.Types.ObjectId, ref: 'Category', default: null, index: true },
    sourceEmailIds: { type: [Schema.Types.ObjectId], default: [] },
    backlinks: { type: [Schema.Types.ObjectId], default: [] },
    /**
     * Multiple thread identifiers can roll up into one page when the topic
     * spans threads (e.g. weekly digests with different Message-IDs).
     * Indexed for fast lookup during email→page assignment.
     */
    threadKeys: { type: [String], default: [], index: true },
    /** Canonical sender addresses contributing to this page (lowercased). */
    senderAddresses: { type: [String], default: [], index: true },
    /**
     * Why this email landed on this page, recorded for transparency in the UI.
     * `thread` = matched an existing threadKey
     * `source-topic` = matched on sender + cosine similarity above threshold
     * `manual` = user-edited
     */
    groupingMode: {
      type: String,
      enum: ['thread', 'source-topic', 'manual'],
      default: 'thread',
    },
    /**
     * Average of source-email embeddings — used to decide whether a new
     * email is on-topic enough to merge here. Deselect by default; cosine
     * comparison happens at assignment time.
     */
    topicCentroid: { type: [Number], default: null, select: false },
    /** Inline citation map: { e1: { emailId, subject, from, date }, e2: ... } */
    citations: {
      type: Schema.Types.Mixed,
      default: () => ({}),
    },
    /** Legacy single-thread field — kept for migration. New code uses threadKeys. */
    threadKey: { type: String, default: null },
    version: { type: Number, default: 1 },
    embedding: { type: [Number], default: null, select: false },
    embeddingModel: { type: String, default: null },
  },
  { timestamps: true },
);

pageSchema.index({ userId: 1, slug: 1 }, { unique: true });
pageSchema.index({ userId: 1, threadKey: 1 });
pageSchema.index(
  { title: 'text', summary: 'text', contentMd: 'text', tags: 'text' },
  { weights: { title: 10, summary: 5, tags: 3, contentMd: 1 }, name: 'PageTextIndex' },
);

export type PageDoc = HydratedDocument<InferSchemaType<typeof pageSchema>> & {
  _id: Types.ObjectId;
};
export const Page = model('Page', pageSchema);
