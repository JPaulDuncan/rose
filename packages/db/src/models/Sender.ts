import { Schema, model, type InferSchemaType, type HydratedDocument, Types } from 'mongoose';

/**
 * Per-user state about a sender brand. Plan 15 stripped the
 * brand-global fields (logo, addresses, websites, summary, etc.)
 * out to the shared `SenderBrand` collection — those facts are the
 * same for every user. What's left here is genuinely per-user:
 *
 *  • Counters / timestamps (emailCount / pageCount / firstSeenAt /
 *    lastSeenAt / lastMarkedAt) — per user's own correspondence.
 *  • Reputation + auto-quarantine state (spamMarkedCount /
 *    rescuedCount / autoQuarantine).
 *  • The user's preference toggle (`stripAds`).
 *  • Optional per-user overrides — `nameOverride` and
 *    `logoUrlOverride`. Both default null; when set, the user's
 *    UI shows their value instead of the brand-global one. The
 *    "promote to brand" affordance copies an override onto the
 *    `SenderBrand` row so it becomes everyone's default — the
 *    flip side of "forget".
 *
 * `brandKey` joins to `SenderBrand.brandKey`. Brand-cased
 * display name / domain / addresses / websites / logo URL etc.
 * all live on the SenderBrand row; reads merge.
 */
const senderSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    brandKey: { type: String, required: true, index: true },
    /** Optional per-user display-name override. null = use the
     *  shared `SenderBrand.name`. */
    nameOverride: { type: String, default: null },
    /** Optional per-user logo override. null = use
     *  `SenderBrand.logoUrl`. The "promote to brand" path copies
     *  this onto the brand row and clears it back to null. */
    logoUrlOverride: { type: String, default: null },
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
    /** When true, the worker runs an aggressive ad-strip pass over
     *  every email body from this brand before feeding it to the LLM.
     *  Drops sponsored breaks, affiliate-link blocks, and footer
     *  boilerplate that a normal newsletter would leave intact. */
    stripAds: { type: Boolean, default: false },
    /** Timestamp of the last spam-mark for this brand. Used by the
     *  reputation decay sweep so old marks lose weight over time. */
    lastMarkedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

senderSchema.index({ userId: 1, brandKey: 1 }, { unique: true });
senderSchema.index({ userId: 1, lastSeenAt: -1 });
// generatePage queries `Sender.find({userId, addresses: {$in},
// autoQuarantine: true})` on every page write to decide if any
// contributing sender is currently quarantined. Partial index
// keeps it tiny — only the small minority of senders that are
// quarantined live in the index.
senderSchema.index(
  { userId: 1, autoQuarantine: 1 },
  { partialFilterExpression: { autoQuarantine: true } },
);

export type SenderDoc = HydratedDocument<InferSchemaType<typeof senderSchema>> & {
  _id: Types.ObjectId;
};
export const Sender = model('Sender', senderSchema);
