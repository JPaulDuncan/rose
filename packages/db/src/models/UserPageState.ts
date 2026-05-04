import { Schema, model, type InferSchemaType, type HydratedDocument, Types } from 'mongoose';

/**
 * Per-user-per-page bits: read/unread tracking and favorites. Lives in
 * its own collection so the Page document stays free of user-specific
 * state (single-tenant today, multi-user-shareable tomorrow).
 *
 * Read-state is opt-in via `User.settings.trackReads`. When the flag
 * is off, the API never writes here and never returns unread counts.
 */
const userPageStateSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    pageId: { type: Schema.Types.ObjectId, ref: 'Page', required: true, index: true },
    read: { type: Boolean, default: false },
    readAt: { type: Date, default: null },
    favorited: { type: Boolean, default: false, index: true },
    favoritedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

userPageStateSchema.index({ userId: 1, pageId: 1 }, { unique: true });
userPageStateSchema.index({ userId: 1, favorited: 1, favoritedAt: -1 });

export type UserPageStateDoc = HydratedDocument<InferSchemaType<typeof userPageStateSchema>> & {
  _id: Types.ObjectId;
};
export const UserPageState = model('UserPageState', userPageStateSchema);
