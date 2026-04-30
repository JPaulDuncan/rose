import { Schema, model, type InferSchemaType, type HydratedDocument, Types } from 'mongoose';

const citationSchema = new Schema(
  {
    emailId: { type: Schema.Types.ObjectId, ref: 'Email', required: true },
    subject: { type: String, default: '' },
    from: { type: String, default: null },
    date: { type: Date, default: null },
  },
  { _id: false },
);

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
    /** Thread identifier copied from source emails so multiple messages can
     *  consolidate into one wiki entry. */
    threadKey: { type: String, default: null, index: true },
    /** Inline citation map: { e1: { emailId, subject, from, date }, e2: ... } */
    citations: {
      type: Schema.Types.Mixed,
      default: () => ({}),
    },
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
