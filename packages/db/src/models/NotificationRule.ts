import { Schema, model, type InferSchemaType, type HydratedDocument, Types } from 'mongoose';

/**
 * What the user wants to be notified about. Evaluated by the worker
 * after every page generation; matches fan out to all of the user's
 * push subscriptions.
 *
 * `kind`:
 *   - priority-high: any new page with priority='high'
 *   - tag: page tagged or topic'd with `match.tag`
 *   - sender: page from a sender brand whose key matches `match.brandKey`
 *   - event-soon: a CalendarEvent starts within `match.hoursAhead`
 *     (default 24); checked by a periodic sweep, not page generation
 */
const notificationRuleSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    kind: {
      type: String,
      enum: ['priority-high', 'tag', 'sender', 'event-soon'],
      required: true,
    },
    match: { type: Schema.Types.Mixed, default: () => ({}) },
    enabled: { type: Boolean, default: true, index: true },
  },
  { timestamps: true },
);

notificationRuleSchema.index({ userId: 1, kind: 1 });

export type NotificationRuleDoc = HydratedDocument<InferSchemaType<typeof notificationRuleSchema>> & {
  _id: Types.ObjectId;
};
export const NotificationRule = model('NotificationRule', notificationRuleSchema);
