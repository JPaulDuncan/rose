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
 * A user-defined automation rule. Conditions are ANDed; actions run
 * in sequence in the order given. The `priority` field controls run
 * order across rules — lower numbers run first; ties break on
 * createdAt (older first) so reordering is deterministic.
 */
const ruleSchema = new Schema(
  {
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

export type RuleDoc = HydratedDocument<InferSchemaType<typeof ruleSchema>> & {
  _id: Types.ObjectId;
};
export const Rule = model('Rule', ruleSchema);
