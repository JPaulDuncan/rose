import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

const sourceSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, enum: ['upload', 'imap', 'webhook', 'gmail'], required: true },
    name: { type: String, required: true },
    status: { type: String, enum: ['active', 'paused', 'error'], default: 'active' },
    /** AES-256-GCM encrypted JSON of source-specific config. */
    encryptedConfig: { type: String, default: null, select: false },
    /**
     * How often the worker polls this source. Editable independently of the
     * encrypted credential blob so we can show + change it without touching
     * the secrets. Applies to imap/gmail; ignored for upload/webhook.
     */
    pollIntervalMinutes: { type: Number, default: 5, min: 1, max: 1440 },
    lastSyncAt: { type: Date, default: null },
    lastError: { type: String, default: null },
  },
  { timestamps: true },
);

export type SourceDoc = HydratedDocument<InferSchemaType<typeof sourceSchema>>;
export const Source = model('Source', sourceSchema);
