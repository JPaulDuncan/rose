import { Schema, model, type InferSchemaType, type HydratedDocument, Types } from 'mongoose';

const addressSchema = new Schema(
  { name: String, address: { type: String, required: true } },
  { _id: false },
);

/**
 * A single outbound message we sent (or tried to send) on behalf of
 * the user. Lives forever as an audit trail and so the user's reply
 * history with a sender is queryable across devices.
 *
 * `status` flow: queued → sent | failed. We don't auto-retry — the
 * user fixes whatever broke and resubmits.
 */
const outboundSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    /** The inbound email this is a reply to (null for compose-from-scratch). */
    inReplyToEmailId: {
      type: Schema.Types.ObjectId,
      ref: 'Email',
      default: null,
      index: true,
    },
    /** Source whose credentials we used to send. */
    sourceId: { type: Schema.Types.ObjectId, ref: 'Source', default: null },
    transport: {
      type: String,
      enum: ['smtp', 'gmail'],
      required: true,
    },
    to: { type: [addressSchema], default: [] },
    cc: { type: [addressSchema], default: [] },
    bcc: { type: [addressSchema], default: [] },
    subject: { type: String, default: '' },
    /** Composed body in Markdown — what the user actually saw. */
    bodyMd: { type: String, default: '' },
    /** Sanitised HTML rendering, sent as the multipart/alternative
     *  HTML half. Persisted so a future view can show what actually
     *  hit the wire. */
    bodyHtml: { type: String, default: '' },
    status: {
      type: String,
      enum: ['queued', 'sent', 'failed'],
      default: 'queued',
      index: true,
    },
    error: { type: String, default: null },
    sentAt: { type: Date, default: null },
    /** Upstream Message-Id captured from the SMTP / Gmail response,
     *  for stitching threads later. */
    messageId: { type: String, default: null },
  },
  { timestamps: true },
);

outboundSchema.index({ userId: 1, createdAt: -1 });
outboundSchema.index({ userId: 1, inReplyToEmailId: 1 });

export type OutboundMessageDoc = HydratedDocument<InferSchemaType<typeof outboundSchema>> & {
  _id: Types.ObjectId;
};
export const OutboundMessage = model('OutboundMessage', outboundSchema);
