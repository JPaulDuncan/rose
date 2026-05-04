import { Schema, model, type InferSchemaType, type HydratedDocument, Types } from 'mongoose';

/**
 * Outbound webhook subscription. Events are fanned out by the worker
 * after the relevant state-change (page generation, spam flag, etc.).
 * Each delivery is HMAC-signed with the per-subscription `secret`,
 * which is encrypted at rest via the same AES-256-GCM helper used for
 * source credentials.
 */
const webhookSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true },
    url: { type: String, required: true },
    events: { type: [String], default: [] },
    /** Encrypted HMAC secret (AES-256-GCM JSON). */
    encryptedSecret: { type: String, default: null, select: false },
    enabled: { type: Boolean, default: true },
    /** Counters shown in the dashboard. */
    deliveryCount: { type: Number, default: 0 },
    failureCount: { type: Number, default: 0 },
    lastDeliveredAt: { type: Date, default: null },
    lastError: { type: String, default: null },
  },
  { timestamps: true },
);

webhookSchema.index({ userId: 1, enabled: 1 });

export type WebhookSubscriptionDoc = HydratedDocument<InferSchemaType<typeof webhookSchema>> & {
  _id: Types.ObjectId;
};
export const WebhookSubscription = model('WebhookSubscription', webhookSchema);
