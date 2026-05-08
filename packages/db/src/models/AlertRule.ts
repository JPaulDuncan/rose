import { Schema, model, type InferSchemaType, type HydratedDocument, Types } from 'mongoose';

/**
 * Operator-facing health alert (Phase D follow-on). Distinct from
 * NotificationRule (which is content-driven — "tell me when a page
 * tagged X arrives"); AlertRule fires on the metrics + slow-query
 * data the worker collects, so the operator gets a push when the
 * worker can't keep up rather than discovering it on the next visit
 * to /settings/diagnostics.
 *
 * Three kinds today:
 *
 *   - queue-failed    — any BullMQ queue's `failed` counter goes
 *                       above `threshold`. The threshold is on the
 *                       absolute count, not the delta — operators
 *                       should resolve failures explicitly so the
 *                       counter doesn't keep re-triggering.
 *
 *   - queue-backlog   — any queue's `waiting` count goes above
 *                       `threshold`. Distinguishes "we have work to
 *                       do" from "we can't keep up" via the
 *                       threshold the operator picks.
 *
 *   - collscan        — a COLLSCAN entry appears in
 *                       system.profile in the last sweep window.
 *                       Indexes drift; this catches it.
 *
 * Cooldown prevents the alert from re-firing on every sweep while
 * the condition persists. Default is 60 minutes — long enough that
 * the operator has time to look + respond, short enough that a
 * recurring real problem still surfaces.
 */
const alertRuleSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    kind: {
      type: String,
      enum: ['queue-failed', 'queue-backlog', 'collscan'],
      required: true,
    },
    /** Display name surfaced in the UI list + the push payload. */
    name: { type: String, default: '' },
    enabled: { type: Boolean, default: true, index: true },
    /** Threshold semantics by kind:
     *    queue-failed   — failed count to trip on (default 1)
     *    queue-backlog  — waiting count to trip on (default 100)
     *    collscan       — count of collscan entries in window
     *                      (default 1; any collscan trips it). */
    threshold: { type: Number, default: 1 },
    /** Minutes between successive fires for the same rule. */
    cooldownMin: { type: Number, default: 60 },
    /** Optional queue-name filter; when set the rule only watches
     *  that one queue. Empty string = match every queue. */
    queueName: { type: String, default: '' },
    lastFiredAt: { type: Date, default: null },
    lastEvaluatedAt: { type: Date, default: null },
    /** Last evaluation result — useful for the UI's "what's the
     *  current value of this rule's metric" display so the user
     *  can sanity-check the threshold. */
    lastValue: { type: Number, default: 0 },
  },
  { timestamps: true },
);

// `enabled` already has `index: true` inline; only the (userId, kind)
// compound is added here on top of the per-field defaults.
alertRuleSchema.index({ userId: 1, kind: 1 });

export type AlertRuleDoc = HydratedDocument<InferSchemaType<typeof alertRuleSchema>> & {
  _id: Types.ObjectId;
};
export const AlertRule = model('AlertRule', alertRuleSchema);
