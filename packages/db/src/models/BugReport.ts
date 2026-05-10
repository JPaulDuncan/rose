import { Schema, model, type InferSchemaType, type HydratedDocument, Types } from 'mongoose';

/**
 * Bug reports + feature requests filed from the SPA. The "Report"
 * button in the Shell user-menu opens a modal that collects the
 * user's text plus the page they're on and a small set of browser
 * vitals so the admin reviewing the report has enough context to
 * reproduce the bug without back-and-forth.
 *
 * Per-user history is part of the contract — users see their own
 * reports in Settings → Reports so they know whether something's
 * been actioned. Admin sees every user's reports on the Admin tab
 * with status + an internal note field.
 */
const bugReportSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    /** 'bug' = something is broken; 'feature' = enhancement request.
     *  Different kinds because the metadata that's relevant differs
     *  (a feature request rarely needs route + browser vitals). */
    kind: { type: String, enum: ['bug', 'feature'], required: true, index: true },
    title: { type: String, required: true, maxlength: 200 },
    body: { type: String, required: true, maxlength: 10_000 },
    /** Route the user was on when they hit Report. Bug-only;
     *  feature requests leave this null. */
    route: { type: String, default: null, maxlength: 500 },
    /** Trimmed user-agent string. Capped so a malicious UA can't
     *  bloat the row. */
    userAgent: { type: String, default: null, maxlength: 500 },
    /** Browser viewport + pixel-ratio. Width × height × DPR is
     *  enough for "this layout is broken on small screens" debug. */
    screen: {
      width: { type: Number, default: null },
      height: { type: Number, default: null },
      devicePixelRatio: { type: Number, default: null },
    },
    /** Browser locale + timezone so a "the date renders wrong"
     *  report has the local context. */
    locale: { type: String, default: null, maxlength: 32 },
    timezone: { type: String, default: null, maxlength: 64 },
    /** Optional client-side build label / git sha. Filled when the
     *  build embeds a `VITE_APP_VERSION` env. */
    appVersion: { type: String, default: null, maxlength: 80 },
    /** Lifecycle. Defaults to 'open'; the admin moves it through. */
    status: {
      type: String,
      enum: ['open', 'in-progress', 'closed'],
      default: 'open',
      index: true,
    },
    /** Admin's running notes — visible to the reporter so they can
     *  see "fixed in deploy X" without DM. */
    adminNote: { type: String, default: '', maxlength: 2000 },
  },
  { timestamps: true },
);

bugReportSchema.index({ userId: 1, createdAt: -1 });
bugReportSchema.index({ status: 1, createdAt: -1 });

export type BugReportDoc = HydratedDocument<InferSchemaType<typeof bugReportSchema>> & {
  _id: Types.ObjectId;
};
export const BugReport = model('BugReport', bugReportSchema);
