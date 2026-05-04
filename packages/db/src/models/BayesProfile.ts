import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

/**
 * Per-user Naive Bayes profile for spam/ham classification.
 *
 * `spam` and `ham` are word-frequency tables — the count of how often
 * each token has appeared across spam-marked vs rescued/non-spam
 * messages. `spamDocs` and `hamDocs` are the corpus sizes.
 *
 * Stored as Mongoose Mixed (plain objects) instead of `Map<string, number>`
 * because the table is keyed on arbitrary user-typed tokens; Mongoose
 * Maps require valid sub-paths, and the `.` in some tokens would break.
 *
 * Caps:
 *   - vocabulary trimmed to 5000 tokens per side (we drop the lowest-
 *     frequency entries during training when the cap is hit)
 *   - Laplace smoothing assumed at score time
 *
 * Cold-start gate: callers should require ≥30 spam + ≥30 ham documents
 * before trusting the score.
 */
const bayesProfileSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    /** word → count for spam corpus. */
    spam: { type: Schema.Types.Mixed, default: () => ({}) },
    /** word → count for ham corpus. */
    ham: { type: Schema.Types.Mixed, default: () => ({}) },
    spamDocs: { type: Number, default: 0 },
    hamDocs: { type: Number, default: 0 },
    spamTokens: { type: Number, default: 0 },
    hamTokens: { type: Number, default: 0 },
  },
  { timestamps: true },
);

export type BayesProfileDoc = HydratedDocument<InferSchemaType<typeof bayesProfileSchema>>;
export const BayesProfile = model('BayesProfile', bayesProfileSchema);
