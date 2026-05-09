import { Schema, model, type InferSchemaType, type HydratedDocument, Types } from 'mongoose';

const conditionSchema = new Schema(
  {
    field: { type: String, required: true },
    op: { type: String, required: true },
    value: { type: Schema.Types.Mixed, default: null },
  },
  { _id: false },
);

const actionSchema = new Schema(
  {
    kind: { type: String, required: true },
    params: { type: Schema.Types.Mixed, default: () => ({}) },
  },
  { _id: false },
);

/**
 * A user-defined (or admin-defined-global) automation rule.
 * Conditions are ANDed; actions run in sequence in the order given.
 * The `priority` field controls run order across rules — lower
 * numbers run first; ties break on createdAt (older first) so
 * reordering is deterministic.
 *
 * Scope mirrors the same model as `Recipe`:
 *   • 'user'   — owned by `userId`, only that user's mail evaluates
 *                against it.
 *   • 'global' — admin-managed, evaluates against every user's mail
 *                in their own context. Invisible to non-admins.
 *
 * Why rules still exist alongside recipes: rules fold their actions
 * into the email→page generation verdict BEFORE the page is
 * written (priority, tag merging, route.topicPage, quarantine,
 * halt). Recipes fire post-write on `email.ingested` /
 * `page.created`. A future unification can migrate rules onto a
 * pre-write `email.ingested` recipe variant; that's a bigger
 * refactor than this scope rollout.
 */
const ruleSchema = new Schema(
  {
    /** Scope. 'user' (default) — owner is `userId`. 'global' —
     *  admin-managed, applies application-wide. */
    scope: {
      type: String,
      enum: ['user', 'global'],
      default: 'user',
      index: true,
    },
    /** Owner (always set). For globals this is the admin who
     *  created the row, used for audit + cron-style fields. */
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true },
    description: { type: String, default: '' },
    enabled: { type: Boolean, default: true, index: true },
    priority: { type: Number, default: 100, index: true },
    conditions: { type: [conditionSchema], default: [] },
    actions: { type: [actionSchema], default: [] },
    /** Stats for the rules list UI. */
    matchCount: { type: Number, default: 0 },
    lastMatchedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

ruleSchema.index({ userId: 1, priority: 1, createdAt: 1 });
// Global dispatch lookup: every email scans all enabled globals
// alongside the user's own rules. Bounded since admins create few.
ruleSchema.index({ scope: 1, enabled: 1, priority: 1 });

export type RuleDoc = HydratedDocument<InferSchemaType<typeof ruleSchema>> & {
  _id: Types.ObjectId;
};
export const Rule = model('Rule', ruleSchema);
