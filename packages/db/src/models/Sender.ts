import { Schema, model, type InferSchemaType, type HydratedDocument, Types } from 'mongoose';

/**
 * A canonical record per (user, brand). The `brandKey` is the lowercase
 * second-level domain label (e.g. "medium" for `*@medium.com` and
 * `notifications@email.medium.com`), so all addresses sharing a brand
 * roll up here. For free-mail providers (gmail, yahoo, …) `brandKey` is
 * the local part of the address — each individual contact gets their
 * own record.
 *
 * The Sender doc is the application's "address book": it accumulates
 * everything Rose has learned about a sender across messages — visible
 * addresses, websites referenced, the most likely logo, an LLM-written
 * "who is this" summary, postal addresses parsed from footers,
 * unsubscribe URLs, and frequency counters. Pages and the Codex view
 * surface it for attribution and dramatis-personae rails.
 */
const senderSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    brandKey: { type: String, required: true, index: true },
    /** Display name. Starts as the brand-cased domain ("Medium"); can be
     *  overridden by the user. */
    name: { type: String, required: true },
    /** Primary domain (e.g. "medium.com"). null for personal-mail brands. */
    domain: { type: String, default: null, index: true },
    /** Every email address Rose has ever seen for this brand. */
    addresses: { type: [String], default: [], index: true },
    /** All link domains we've seen referenced in this brand's mail
     *  (their own marketing/help links, etc.) — useful for the codex. */
    websites: { type: [String], default: [] },
    /** Best logo URL we've extracted, plus a 0..1 confidence score. */
    logoUrl: { type: String, default: null },
    logoConfidence: { type: Number, default: 0 },
    /** Set when the user has manually fixed the logo — disables the
     *  auto-update path so we don't clobber their override. */
    logoLocked: { type: Boolean, default: false },
    /** Unsubscribe URLs scraped from the List-Unsubscribe header and
     *  obvious unsubscribe links in the body. */
    unsubscribeUrls: { type: [String], default: [] },
    /** Postal addresses parsed from email footers, deduped. */
    postalAddresses: { type: [String], default: [] },
    /** LLM-written 1-paragraph summary. Refreshed on demand from the
     *  Senders settings page. */
    summary: { type: String, default: '' },
    summaryGeneratedAt: { type: Date, default: null },
    summaryLocked: { type: Boolean, default: false },
    /** Counters for sorting/filtering in the UI. */
    emailCount: { type: Number, default: 0 },
    pageCount: { type: Number, default: 0 },
    firstSeenAt: { type: Date, default: () => new Date() },
    lastSeenAt: { type: Date, default: () => new Date() },
    /** Number of pages from this brand the user has marked as spam.
     *  Drives the auto-quarantine reputation threshold. */
    spamMarkedCount: { type: Number, default: 0, index: true },
    /** Number of pages from this brand the user has explicitly rescued.
     *  Resets/offsets `spamMarkedCount` so a once-blocked sender can be
     *  trusted again without nuking the record. */
    rescuedCount: { type: Number, default: 0 },
    /** Set when reputation threshold is exceeded — incoming pages from
     *  this brand are auto-marked as quarantined unless the user rescues. */
    autoQuarantine: { type: Boolean, default: false, index: true },
  },
  { timestamps: true },
);

senderSchema.index({ userId: 1, brandKey: 1 }, { unique: true });
senderSchema.index({ userId: 1, lastSeenAt: -1 });

export type SenderDoc = HydratedDocument<InferSchemaType<typeof senderSchema>> & {
  _id: Types.ObjectId;
};
export const Sender = model('Sender', senderSchema);
