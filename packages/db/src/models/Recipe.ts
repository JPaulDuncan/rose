import { Schema, model, type InferSchemaType, type HydratedDocument, Types } from 'mongoose';

/**
 * IFTTT-style recipe — trigger + conditions + actions. See
 * .devlogs/IFTTT-feature.md for the full design.
 *
 * Trigger / condition / action payloads are discriminated unions
 * validated by Zod at the API boundary; we store them as Mixed here
 * since Mongoose schemas express discriminators awkwardly and the
 * Zod layer is the single source of truth.
 */
const triggerSchema = new Schema(
  {
    kind: { type: String, required: true },
    /** Trigger-specific payload (sender filter, cron expression, …). */
    config: { type: Schema.Types.Mixed, default: () => ({}) },
  },
  { _id: false },
);

const conditionSchema = new Schema(
  {
    kind: { type: String, required: true },
    config: { type: Schema.Types.Mixed, default: () => ({}) },
  },
  { _id: false },
);

const actionSchema = new Schema(
  {
    kind: { type: String, required: true },
    config: { type: Schema.Types.Mixed, default: () => ({}) },
  },
  { _id: false },
);

const recipeSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, maxlength: 120 },
    description: { type: String, default: '', maxlength: 500 },
    enabled: { type: Boolean, default: true, index: true },
    /** Exactly one trigger. (Recipes with multiple triggers can be
     *  expressed as multiple recipes; see design §10.) */
    trigger: { type: triggerSchema, required: true },
    /** ANDed; empty = always pass. */
    conditions: { type: [conditionSchema], default: [] },
    /** Run sequentially in order. */
    actions: { type: [actionSchema], default: [] },
    /** Minimum interval between fires for the same (recipe, subject)
     *  pair, in seconds. 0 = no cooldown. */
    cooldownSeconds: { type: Number, default: 0, min: 0, max: 7 * 24 * 3600 },
    /** Soft rate-limit floor — recipes can't fire more than this in a
     *  rolling hour. Catches runaway loops; default 60. */
    fireLimitPerHour: { type: Number, default: 60, min: 1, max: 1000 },
    /** Marker for entries created by Phase 2 migration of legacy
     *  rule-shaped systems. Lets the UI show an "imported" badge and
     *  preserve back-pointer semantics. */
    importedFrom: {
      type: String,
      enum: ['notification-rule', 'webhook', 'spam-policy', 'rule', null],
      default: null,
    },
    /** Stats surfaced in the list UI. */
    fireCount: { type: Number, default: 0 },
    errorCount: { type: Number, default: 0 },
    lastFiredAt: { type: Date, default: null },
    lastErrorAt: { type: Date, default: null },
    lastErrorMessage: { type: String, default: null },
  },
  { timestamps: true },
);

recipeSchema.index({ userId: 1, enabled: 1, 'trigger.kind': 1 });
recipeSchema.index({ userId: 1, name: 1 });

export type RecipeDoc = HydratedDocument<InferSchemaType<typeof recipeSchema>> & {
  _id: Types.ObjectId;
};
export const Recipe = model('Recipe', recipeSchema);
