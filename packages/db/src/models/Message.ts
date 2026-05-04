import { Schema, model, type InferSchemaType, type HydratedDocument, Types } from 'mongoose';

/**
 * A single chat turn within a Conversation. Assistant turns carry the
 * citation map ({label → page metadata}) the LLM used so the UI can
 * render hyperlinked footnotes. The model field captures which
 * provider+model produced the assistant turn.
 */
const messageSchema = new Schema(
  {
    conversationId: {
      type: Schema.Types.ObjectId,
      ref: 'Conversation',
      required: true,
      index: true,
    },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    role: { type: String, enum: ['user', 'assistant', 'system'], required: true },
    content: { type: String, required: true, default: '' },
    /** Citation map keyed by retrieval label (p1, p2, …). Mongoose
     *  Mixed because the keys are arbitrary. */
    citations: { type: Schema.Types.Mixed, default: () => ({}) },
    /** Provider:model that produced an assistant turn. */
    model: { type: String, default: null },
    inputTokens: { type: Number, default: 0 },
    outputTokens: { type: Number, default: 0 },
  },
  { timestamps: true },
);

messageSchema.index({ conversationId: 1, createdAt: 1 });

export type MessageDoc = HydratedDocument<InferSchemaType<typeof messageSchema>> & {
  _id: Types.ObjectId;
};
export const Message = model('Message', messageSchema);
