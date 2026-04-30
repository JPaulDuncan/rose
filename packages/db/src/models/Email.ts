import { Schema, model, type InferSchemaType, type HydratedDocument, Types } from 'mongoose';

const addressSchema = new Schema(
  { name: String, address: { type: String, required: true } },
  { _id: false },
);

const attachmentSchema = new Schema(
  {
    filename: String,
    contentType: String,
    size: Number,
    contentId: String,
    storageKey: String,
  },
  { _id: false },
);

const emailSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    sourceId: { type: Schema.Types.ObjectId, ref: 'Source', default: null },
    messageId: { type: String, default: null },
    threadKey: { type: String, default: null, index: true },
    /** Normalized subject shape for grouping templated notifications. */
    subjectTemplate: { type: String, default: null, index: true },
    rawHash: { type: String, required: true, index: true },
    from: { type: addressSchema, default: null },
    to: { type: [addressSchema], default: [] },
    cc: { type: [addressSchema], default: [] },
    subject: { type: String, default: '' },
    date: { type: Date, default: null },
    text: { type: String, default: '' },
    rawText: { type: String, default: '' },
    html: { type: String, default: null },
    attachments: { type: [attachmentSchema], default: [] },
    ingestStatus: {
      type: String,
      enum: ['pending', 'parsing', 'parsed', 'generated', 'skipped', 'failed'],
      default: 'pending',
      index: true,
    },
    pageId: { type: Schema.Types.ObjectId, ref: 'Page', default: null },
    /** Cached subject+body embedding so page-assignment can compare to
     *  candidate page centroids without re-embedding on every retry. */
    embedding: { type: [Number], default: null, select: false },
    embeddingModel: { type: String, default: null },
    error: { type: String, default: null },
  },
  { timestamps: true },
);

emailSchema.index({ userId: 1, messageId: 1 }, { unique: true, sparse: true });
emailSchema.index({ userId: 1, rawHash: 1 }, { unique: true });

export type EmailDoc = HydratedDocument<InferSchemaType<typeof emailSchema>> & {
  _id: Types.ObjectId;
};
export const Email = model('Email', emailSchema);
