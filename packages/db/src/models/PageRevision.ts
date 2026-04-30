import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

const revSchema = new Schema(
  {
    pageId: { type: Schema.Types.ObjectId, ref: 'Page', required: true, index: true },
    version: { type: Number, required: true },
    title: String,
    summary: String,
    contentMd: String,
    editor: { type: String, enum: ['user', 'llm'], required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

revSchema.index({ pageId: 1, version: -1 }, { unique: true });

export type PageRevisionDoc = HydratedDocument<InferSchemaType<typeof revSchema>>;
export const PageRevision = model('PageRevision', revSchema);
