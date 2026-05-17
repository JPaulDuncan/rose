import { Schema, model, type InferSchemaType, type HydratedDocument, Types } from 'mongoose';

/**
 * Theme-level aggregation of `MemoryComponent` rows about the user.
 * The "groups" layer of xMemory's hierarchy (arXiv:2602.02007).
 * Maintained incrementally by the memory-grouping sweeper:
 *
 *   - Attach: a new component joins its nearest group if cosine
 *     similarity to the centroid exceeds the attach threshold;
 *     otherwise a brand-new group is created.
 *   - Split: groups that grow past `MAX_GROUP_SIZE` or whose
 *     internal coherence falls below threshold get split via
 *     k-means on member embeddings.
 *   - Merge: groups whose centroid is below `MIN_INTER_GROUP_DIST`
 *     from another group's centroid (after deduping near-duplicates)
 *     get merged, with the surviving group's label preferred.
 *
 * The label is initially set by the LLM when the group is created
 * (a one-shot "name this cluster" call given 3–5 representative
 * components); the user can rename it from the "What Rose knows
 * about you" page. We persist `labelLockedByUser` so a future
 * automatic relabel pass doesn't overwrite a deliberate rename.
 */

const memoryGroupSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    /**
     * Subject of the components in this group. A group only ever
     * contains components of one subject — the sweeper's attach
     * step refuses to merge a 'world' component into a 'user'
     * group, and vice versa. Lets the UI render two disjoint
     * surfaces ("What Rose knows about you" vs. "Atomic facts
     * Rose has extracted") without filtering every component.
     * Defaults to 'user' so existing v1 rows migrate cleanly.
     */
    subject: {
      type: String,
      enum: ['user', 'world'],
      default: 'user',
      required: true,
      index: true,
    },
    /** Human-readable theme. "Travel preferences", "Health
     *  constraints", "Family relationships". */
    label: { type: String, required: true, maxlength: 120 },
    /** True when the user renamed the group manually — the
     *  auto-labeler won't overwrite. */
    labelLockedByUser: { type: Boolean, default: false },
    /** Mean of member embeddings. Recomputed on every attach /
     *  split / merge. Used by Stage I retrieval (kNN over group
     *  centroids) and by attach decisions. */
    centroid: { type: [Number], default: [], select: false },
    /** Cached member count. Cheap to render the UI without a
     *  group-by aggregate. */
    componentCount: { type: Number, default: 0 },
    /** Top-N nearest neighbour groups by centroid cosine.
     *  Maintained by the sweeper. Powers xMemory's Stage I
     *  greedy-coverage retrieval — we walk these links to
     *  identify "related evidence regions that remain uncovered"
     *  rather than top-k by raw similarity. */
    neighborGroupIds: { type: [Schema.Types.ObjectId], default: [] },
    /** Sweeper bookkeeping — last time we attached, last split,
     *  last merge. Helps the admin sweeper-status panel debug
     *  "this group hasn't been touched in a month — is it stale?". */
    lastAttachAt: { type: Date, default: null },
    lastReshapeAt: { type: Date, default: null },
  },
  { timestamps: true },
);

memoryGroupSchema.index({ userId: 1, componentCount: -1 });

export type MemoryGroupDoc = HydratedDocument<InferSchemaType<typeof memoryGroupSchema>> & {
  _id: Types.ObjectId;
};
export const MemoryGroup = model('MemoryGroup', memoryGroupSchema);
