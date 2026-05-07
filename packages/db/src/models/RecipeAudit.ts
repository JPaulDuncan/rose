import { Schema, model, type InferSchemaType, type HydratedDocument, Types } from 'mongoose';

/**
 * One row per recipe evaluation, fired or not. Records the natural
 * subject key (email id, page id, …), the per-action results, and a
 * compact slice of the event payload so the audit panel can show
 * "what triggered this". TTL-pruned at 30 days — beyond that it's
 * not actionable.
 */
const recipeAuditSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    recipeId: { type: Schema.Types.ObjectId, ref: 'Recipe', required: true, index: true },
    firedAt: { type: Date, required: true, default: () => new Date() },
    /** Natural key of the subject the trigger fired on. Powers
     *  cooldown bookkeeping (per-recipe, per-subject). */
    subjectKey: { type: String, default: null, index: true },
    /** Did conditions match AND cooldown allow? When false, `reason`
     *  explains why the recipe didn't actually run. */
    fired: { type: Boolean, required: true, index: true },
    reason: { type: String, default: null },
    /** Per-action outcomes. Same length as Recipe.actions when
     *  fired === true; empty otherwise. */
    results: {
      type: [
        new Schema(
          {
            actionKind: { type: String, required: true },
            ok: { type: Boolean, required: true },
            error: { type: String, default: null },
            durationMs: { type: Number, default: 0 },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    /** Frozen snapshot of the relevant event payload, capped at
     *  ~2 KB to keep the collection small. The full subject is
     *  always still reachable via subjectKey + the source model. */
    evidence: { type: Schema.Types.Mixed, default: () => ({}) },
  },
  { timestamps: false },
);

recipeAuditSchema.index({ userId: 1, recipeId: 1, firedAt: -1 });
recipeAuditSchema.index(
  { firedAt: 1 },
  { expireAfterSeconds: 30 * 24 * 3600 },
);

export type RecipeAuditDoc = HydratedDocument<InferSchemaType<typeof recipeAuditSchema>> & {
  _id: Types.ObjectId;
};
export const RecipeAudit = model('RecipeAudit', recipeAuditSchema);
