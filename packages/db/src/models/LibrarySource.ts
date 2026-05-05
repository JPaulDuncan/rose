import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

/**
 * A user-curated source the Library worker crawls. Distinct from the
 * existing `Source` model: ingestion sources (IMAP, Gmail, RSS-as-
 * inbox) produce Email rows that flow through the page-generation
 * pipeline. Library sources produce LibraryDocument rows that don't
 * become wiki pages — they're a search-and-discovery substrate.
 *
 * v1 supports `rss` and `url`. Sitemap and bulk URL-list import are
 * called out in plan 10 as follow-ups.
 */
const sourceSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    kind: { type: String, enum: ['rss', 'sitemap', 'url', 'urlList'], required: true },
    name: { type: String, required: true },
    /** Feed URL, sitemap URL, or single page URL. Null for `urlList`. */
    url: { type: String, default: null },
    /** Bulk URL-list — for `kind: 'urlList'`. */
    urls: { type: [String], default: [] },
    tags: { type: [String], default: [] },
    /** How often the worker polls this source. RSS: 60. Sitemap/url: 1440. */
    pollIntervalMinutes: { type: Number, default: 60, min: 5, max: 7 * 24 * 60 },
    /** Conditional-GET caches (RSS / sitemap). */
    etag: { type: String, default: null },
    lastModified: { type: String, default: null },
    lastSyncAt: { type: Date, default: null },
    lastError: { type: String, default: null },
    status: {
      type: String,
      enum: ['active', 'paused', 'error'],
      default: 'active',
      index: true,
    },
  },
  { timestamps: true },
);

sourceSchema.index({ userId: 1, kind: 1, status: 1 });
sourceSchema.index({ userId: 1, lastSyncAt: 1 });

export type LibrarySourceDoc = HydratedDocument<InferSchemaType<typeof sourceSchema>>;
export const LibrarySource = model('LibrarySource', sourceSchema);
