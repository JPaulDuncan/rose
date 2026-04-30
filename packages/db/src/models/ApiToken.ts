import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

const tokenSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true },
    /** SHA-256 hex of the actual token; the raw value is shown once at creation. */
    tokenHash: { type: String, required: true, unique: true, index: true },
    sourceId: { type: Schema.Types.ObjectId, ref: 'Source', default: null },
    lastUsedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

export type ApiTokenDoc = HydratedDocument<InferSchemaType<typeof tokenSchema>>;
export const ApiToken = model('ApiToken', tokenSchema);
