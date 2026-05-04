import { Schema, model, type InferSchemaType, type HydratedDocument, Types } from 'mongoose';

const eventSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    /** The email this event was extracted from. Null for events
     *  pulled from external calendars (Google Calendar / CalDAV). */
    sourceEmailId: { type: Schema.Types.ObjectId, ref: 'Email', default: null, index: true },
    /** The wiki page that aggregates that email. Optional — emails ingested
     *  but not yet generated won't have one. Cached `pageSlug` for the UI. */
    pageId: { type: Schema.Types.ObjectId, ref: 'Page', default: null },
    pageSlug: { type: String, default: null },
    title: { type: String, required: true, maxlength: 200 },
    /** Start instant. Always required. */
    start: { type: Date, required: true, index: true },
    /** End instant. Optional; absent for point-in-time events. */
    end: { type: Date, default: null },
    allDay: { type: Boolean, default: false },
    location: { type: String, default: null },
    description: { type: String, default: '' },
    /** User-toggled hide flag. Dismissed events stay in the DB but are
     *  excluded from default calendar queries. */
    dismissed: { type: Boolean, default: false, index: true },
    /** Stable identifier for events pulled from Google Calendar.
     *  Format: `gcal:<calendarId>:<eventId>`. Indexed unique-per-user
     *  so re-syncs idempotently upsert. */
    gcalId: { type: String, default: null, sparse: true },
  },
  { timestamps: true },
);

eventSchema.index({ userId: 1, start: 1, dismissed: 1 });
eventSchema.index({ sourceEmailId: 1 });
eventSchema.index({ userId: 1, gcalId: 1 }, { sparse: true });

export type EventDoc = HydratedDocument<InferSchemaType<typeof eventSchema>> & {
  _id: Types.ObjectId;
};
export const CalendarEvent = model('CalendarEvent', eventSchema);
