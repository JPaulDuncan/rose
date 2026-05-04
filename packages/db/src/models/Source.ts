import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

const sourceSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: {
      type: String,
      enum: ['upload', 'imap', 'webhook', 'gmail', 'rss', 'slack', 'discord', 'gcal'],
      required: true,
    },
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
    /** RSS-only conditional GET caches so we re-fetch cheaply. */
    rssEtag: { type: String, default: null },
    rssLastModified: { type: String, default: null },
    /** RSS feed metadata captured on first successful fetch (display only). */
    rssFeedTitle: { type: String, default: null },
    rssFeedUrl: { type: String, default: null },
    /** Outbound SMTP overrides for IMAP sources — derived host
     *  defaults work for most providers (smtp.<domain>:465 secure)
     *  but the user can override per-source. */
    smtpHost: { type: String, default: null },
    smtpPort: { type: Number, default: null, min: 1, max: 65535 },
    smtpSecure: { type: Boolean, default: true },
    /** Default From: name on outbound mail from this source. Falls
     *  back to the user's display name when null. */
    fromName: { type: String, default: null },
    /** Optional signature (markdown) appended to drafted replies
     *  before sending. */
    signature: { type: String, default: '' },
  },
  { timestamps: true },
);

export type SourceDoc = HydratedDocument<InferSchemaType<typeof sourceSchema>>;
export const Source = model('Source', sourceSchema);
