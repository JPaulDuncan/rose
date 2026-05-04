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
    /**
     * Discriminator across all ingested content kinds. The shape is
     * the same — subject, from, text/html, attachments — but the
     * source differs:
     *   email     traditional inbound mail
     *   rss       feed entries (sender = feed@<host>)
     *   url       saved web page (sender = web@<host>)
     *   document  uploaded PDF / DOCX / text (sender = you@<host>)
     */
    kind: {
      type: String,
      enum: ['email', 'rss', 'url', 'document'],
      default: 'email',
      index: true,
    },
    messageId: { type: String, default: null },
    /** Original URL when this row came from a URL save or a fetched
     *  document. Indexed for fast dedup. */
    sourceUrl: { type: String, default: null, index: true },
    /** Document metadata for `kind='document'` rows. */
    documentMeta: {
      filename: { type: String, default: null },
      contentType: { type: String, default: null },
      size: { type: Number, default: 0 },
      pageCount: { type: Number, default: null },
    },
    /** Site name from OpenGraph / Twitter card on URL saves. */
    siteName: { type: String, default: null },
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
    /** Header/heuristic-derived priority. */
    priority: {
      type: String,
      enum: ['high', 'normal', 'low'],
      default: 'normal',
      index: true,
    },
    /** Coarse topics extracted at ingestion (hashtags + capitalized phrases). */
    topics: { type: [String], default: [], index: true },
    /** URLs found in body/HTML, deduped. */
    links: {
      type: [
        new Schema(
          { url: { type: String, required: true }, text: { type: String, default: null } },
          { _id: false },
        ),
      ],
      default: [],
    },
    /** Image URLs from HTML, with optional alt text. Trackers/data URIs filtered. */
    images: {
      type: [
        new Schema(
          { url: { type: String, required: true }, alt: { type: String, default: null } },
          { _id: false },
        ),
      ],
      default: [],
    },
    /** 0..1 — higher means more likely spam. Threshold ≥0.5 surfaces a warning. */
    spamScore: { type: Number, default: 0, index: true },
    spamSignals: { type: [String], default: [] },
    /** Legitimate bulk mail (List-Unsubscribe present). Distinct from spam. */
    isMassMailing: { type: Boolean, default: false },
    /** 0..1 — likelihood that the email is promotional/marketing
     *  content. Distinct from spamScore: a wanted newsletter scores
     *  high here without being spam. */
    promotionalScore: { type: Number, default: 0, index: true },
    isPromotional: { type: Boolean, default: false, index: true },
    promotionalSignals: { type: [String], default: [] },
    /** SPF/DKIM/DMARC outcomes captured from Authentication-Results. */
    authResults: {
      spf: {
        type: String,
        enum: ['pass', 'fail', 'softfail', 'neutral', 'none', 'unknown'],
        default: 'unknown',
      },
      dkim: {
        type: String,
        enum: ['pass', 'fail', 'softfail', 'neutral', 'none', 'unknown'],
        default: 'unknown',
      },
      dmarc: {
        type: String,
        enum: ['pass', 'fail', 'softfail', 'neutral', 'none', 'unknown'],
        default: 'unknown',
      },
    },
    /** Brand-logo candidate scraped from the email head — fed into the
     *  Sender address book on generation. Not surfaced in the UI directly. */
    logoCandidate: {
      url: { type: String, default: null },
      alt: { type: String, default: null },
      confidence: { type: Number, default: 0 },
    },
    /** Unsubscribe URLs from List-Unsubscribe header. */
    unsubscribeUrls: { type: [String], default: [] },
    /** Timestamp of the last extract.events run for this email. The worker
     *  uses presence of this field to skip already-extracted emails on
     *  re-generation; clear it to force re-extraction. */
    eventsExtractedAt: { type: Date, default: null },
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
