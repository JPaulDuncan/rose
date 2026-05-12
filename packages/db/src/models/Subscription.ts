import { Schema, model, type InferSchemaType, type HydratedDocument, Types } from 'mongoose';

/**
 * Recurring service subscriptions extracted from email — Netflix
 * monthly, GitHub Pro yearly, AT&T fiber, gym memberships, etc.
 * Per-user (subscriptions are personal). Dedup'd on
 * (userId, lowercased serviceName).
 *
 * Evidence captures every email/page that touched the subscription
 * so the user can audit "where did Rose learn about this?" — same
 * pattern receipts and entity-relations use. Cancelling a sub
 * doesn't delete the row; status flips to 'cancelled' or 'expired'
 * with the last evidence entry pointing at the cancellation notice.
 */
const subscriptionEvidenceSchema = new Schema(
  {
    pageId: { type: Schema.Types.ObjectId, ref: 'Page', default: null },
    emailId: { type: Schema.Types.ObjectId, ref: 'Email', default: null },
    /** ≤240 char excerpt that justified the inference. */
    snippet: { type: String, default: '', maxlength: 240 },
    extractedAt: { type: Date, default: () => new Date() },
  },
  { _id: false },
);

const subscriptionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    /** Display name as the user would say it ("Netflix",
     *  "GitHub Pro"). Stored verbatim from the LLM's best guess. */
    serviceName: { type: String, required: true, maxlength: 200 },
    /** Lowercased serviceName — the actual dedup key, since the
     *  LLM emits "Netflix" / "netflix" / "Netflix.com" across runs. */
    serviceKey: { type: String, required: true, index: true },
    /** Optional sender brand-key for the brand chip on the row. */
    brandKey: { type: String, default: null, index: true },
    /** Recurring amount in `currency`. */
    amount: { type: Number, default: null },
    currency: { type: String, default: null, maxlength: 8 },
    /** Renewal cadence — 'other' for usage-based / irregular. */
    cadence: {
      type: String,
      enum: ['monthly', 'yearly', 'quarterly', 'weekly', 'other'],
      default: 'monthly',
    },
    /** Next renewal as a Date. Null when not stated. */
    nextRenewalAt: { type: Date, default: null, index: true },
    /** Lifecycle. 'active' = recurring; 'cancelled' = user
     *  cancelled but coverage may continue; 'expired' = ended. */
    status: {
      type: String,
      enum: ['active', 'cancelled', 'expired'],
      default: 'active',
      index: true,
    },
    /** Coarse category — drives the spending dashboard rollups. */
    category: {
      type: String,
      enum: [
        'media',
        'software',
        'utility',
        'fitness',
        'news',
        'insurance',
        'cloud',
        'other',
        null,
      ],
      default: null,
      index: true,
    },
    /** When this user first saw mail about the sub. Stable across
     *  re-extractions via $setOnInsert. */
    firstSeenAt: { type: Date, default: () => new Date() },
    /** Last time any field changed. Auto-updated by timestamps. */
    evidence: { type: [subscriptionEvidenceSchema], default: [] },
    /** How the most recent extraction was sourced — see
     *  ProductPurchase.extractedBy. */
    extractedBy: {
      type: String,
      enum: ['structured', 'llm'],
      default: 'llm',
      index: true,
    },
  },
  { timestamps: true },
);

subscriptionSchema.index({ userId: 1, serviceKey: 1 }, { unique: true });
subscriptionSchema.index({ userId: 1, status: 1, nextRenewalAt: 1 });

export type SubscriptionDoc = HydratedDocument<InferSchemaType<typeof subscriptionSchema>> & {
  _id: Types.ObjectId;
};
export const Subscription = model('Subscription', subscriptionSchema);
