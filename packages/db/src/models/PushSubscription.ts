import { Schema, model, type InferSchemaType, type HydratedDocument, Types } from 'mongoose';

/**
 * Browser-side WebPush subscription. The `endpoint` is unique across
 * the whole system (it embeds the user's specific browser channel),
 * so we de-dupe on it.
 */
const pushSubSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    endpoint: { type: String, required: true, unique: true },
    keys: {
      p256dh: { type: String, required: true },
      auth: { type: String, required: true },
    },
    userAgent: { type: String, default: null },
    /** Last failure (e.g. 410 Gone). When set, the next sweep removes
     *  the subscription. */
    lastError: { type: String, default: null },
  },
  { timestamps: true },
);

pushSubSchema.index({ userId: 1, createdAt: -1 });

export type PushSubscriptionDoc = HydratedDocument<InferSchemaType<typeof pushSubSchema>> & {
  _id: Types.ObjectId;
};
export const PushSubscription = model('PushSubscription', pushSubSchema);
