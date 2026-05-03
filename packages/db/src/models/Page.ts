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
     * Subject templates (output of `extractSubjectTemplate`) of the
     * messages on this page. Templated notifications from the same sender
     * (CI failures, receipts, daily digests) collapse onto one page via
     * an exact subjectTemplate hit before any embedding-based path runs.
     */
    subjectTemplates: { type: [String], default: [], index: true },
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
    /** Highest priority across contributing emails. */
    priority: {
      type: String,
      enum: ['high', 'normal', 'low'],
      default: 'normal',
      index: true,
    },
    /** Union of email topics (capitalized phrases / hashtags), deduped. */
    topics: { type: [String], default: [], index: true },
    /** Aggregated links across emails. */
    pageLinks: {
      type: [
        new Schema(
          {
            url: { type: String, required: true },
            text: { type: String, default: null },
            count: { type: Number, default: 1 },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    /** Rolled-up image URLs across the page's source emails. */
    pageImages: {
      type: [
        new Schema(
          {
            url: { type: String, required: true },
            alt: { type: String, default: null },
            count: { type: Number, default: 1 },
            fromEmailId: { type: Schema.Types.ObjectId, ref: 'Email' },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    /** A representative image surfaced as a hero banner on the wiki page. */
    heroImageUrl: { type: String, default: null },
    /** Rolled-up attachments with the email each came from for back-reference. */
    pageAttachments: {
      type: [
        new Schema(
          {
            filename: { type: String, default: '' },
            contentType: { type: String, default: '' },
            size: { type: Number, default: 0 },
            fromEmailId: { type: Schema.Types.ObjectId, ref: 'Email' },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    /** Max spamScore across contributing emails (0..1). */
    spamScore: { type: Number, default: 0, index: true },
    /** Page-level flags surfaced in the UI. */
    flags: {
      hasLikelySpam: { type: Boolean, default: false },
      hasMassMailing: { type: Boolean, default: false },
      isSparse: { type: Boolean, default: false },
      /** Set when the user (not the heuristic) flags a page as spam. */
      userMarkedSpam: { type: Boolean, default: false },
      /** Set when ≥70% of contributing emails share one subject template. */
      isNotificationStream: { type: Boolean, default: false, index: true },
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
