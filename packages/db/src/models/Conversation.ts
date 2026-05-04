import { Schema, model, type InferSchemaType, type HydratedDocument, Types } from 'mongoose';

/**
 * A persistent thread of chat messages between the user and the
 * assistant. Each conversation is keyed on userId; titles get set
 * from the first user message (truncated) and are user-editable.
 */
const conversationSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    title: { type: String, required: true, default: 'New conversation' },
    pinned: { type: Boolean, default: false },
  },
  { timestamps: true },
);

conversationSchema.index({ userId: 1, updatedAt: -1 });

export type ConversationDoc = HydratedDocument<InferSchemaType<typeof conversationSchema>> & {
  _id: Types.ObjectId;
};
export const Conversation = model('Conversation', conversationSchema);
