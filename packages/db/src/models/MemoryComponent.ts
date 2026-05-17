import { Schema, model, type InferSchemaType, type HydratedDocument, Types } from 'mongoose';

/**
 * Atomic, evidence-preserving claim about the user. The "components"
 * layer of the xMemory hierarchy
 * (arXiv:2602.02007 — "Beyond RAG for Agent Memory") adapted to
 * Rose's substrate: one row per reusable fact, preference,
 * constraint, relation, or state-update extracted from a page about
 * the user.
 *
 * The whole point of this layer (vs. the existing Page-level
 * summaries) is **decoupling before aggregation** — when "I live in
 * Brooklyn" and "I live in Chicago" both come from the user's
 * mailbox, top-k similarity over page summaries blurs the conflict;
 * decoupled components preserve the two atomic claims and the
 * supersession chain that resolves them.
 *
 * v1 scope: user-facts only (subject='user'). v2 broadens to
 * world-facts as well (subject='world') — atomic claims about
 * subjects in the page (people, places, works, organizations,
 * events) that downstream consumers can use for retrieval and
 * citation. Both subjects share the same component table + the
 * same grouping sweeper, but groups stay homogeneous (a group is
 * either all-user or all-world) so consumers can filter by
 * subject without scanning every row.
 */

export const MEMORY_COMPONENT_SUBJECTS = ['user', 'world'] as const;
export type MemoryComponentSubject = (typeof MEMORY_COMPONENT_SUBJECTS)[number];

export const MEMORY_COMPONENT_TYPES = [
  'fact',
  'preference',
  'constraint',
  'relation',
  'state-update',
] as const;
export type MemoryComponentType = (typeof MEMORY_COMPONENT_TYPES)[number];

const memoryComponentSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    /**
     * Subject domain of the claim:
     *   - 'user'  — about the requesting user (the original v1 scope).
     *   - 'world' — about a subject IN the page (a person, place,
     *               work, organization, event). Downstream
     *               consumers (daydream context, future chat-RAG)
     *               can retrieve these to ground synthesis prompts
     *               in claims Rose has previously extracted.
     * Existing rows from the v1 substrate default to 'user' so
     * the migration is a no-op for current consumers.
     */
    subject: {
      type: String,
      enum: MEMORY_COMPONENT_SUBJECTS,
      default: 'user',
      required: true,
      index: true,
    },
    /** One of: fact, preference, constraint, relation, state-update.
     *  Drives the grouping label heuristic + the "What Rose knows
     *  about you" UI sections. */
    type: { type: String, enum: MEMORY_COMPONENT_TYPES, required: true, index: true },
    /** The atomic claim, in plain English. ≤ 200 chars. The
     *  extractor is instructed to write each component as one
     *  declarative sentence in the user's voice — "I prefer aisle
     *  seats", "I'm allergic to penicillin", "my dog's name is
     *  Otis". Voice consistency makes the grouping centroid and the
     *  downstream prompt context coherent. */
    text: { type: String, required: true, maxlength: 400 },
    /** Embedding for grouping + retrieval. Same model as the rest
     *  of Rose's embed path (resolveProviderForUser ... 'embedding'). */
    embedding: { type: [Number], default: null, select: false },
    embeddingModel: { type: String, default: null, select: false },
    /** Pages this claim was extracted from. Multi-source: when the
     *  same fact appears in multiple pages we keep all references
     *  so the user can see provenance and so a single page deletion
     *  doesn't orphan the component. */
    sourcePageIds: { type: [Schema.Types.ObjectId], default: [], index: true },
    /** Group this component currently belongs to. Null while
     *  ungrouped (just-extracted, before the sweeper runs).
     *  Updates as the sweeper attaches/splits/merges. */
    groupId: { type: Schema.Types.ObjectId, ref: 'MemoryGroup', default: null, index: true },
    /** Extractor's self-reported confidence 0..1. The grouping
     *  objective doesn't use it; the UI surfaces it so the user can
     *  glance over "things Rose isn't sure about" and confirm or
     *  reject. */
    confidence: { type: Number, default: 0.5, min: 0, max: 1 },
    /** Supersession chain — when the user moves, changes a
     *  preference, or replaces a constraint, the new component
     *  points back at the old one via `supersedes`, and the old
     *  one's `supersededBy` gets set so the retrieval helper can
     *  pick the current state by default. The old row is kept
     *  (not deleted) so the temporal record survives. */
    supersededBy: { type: Schema.Types.ObjectId, ref: 'MemoryComponent', default: null },
    supersedes: { type: [Schema.Types.ObjectId], default: [] },
    /** User action on this component:
     *    'active'   — visible everywhere
     *    'archived' — hidden but not deleted (the user pinned it
     *                 down as outdated rather than wrong)
     *    'rejected' — user marked the extraction as incorrect; the
     *                 component is suppressed in retrieval AND a
     *                 re-extraction on the same page won't bring it
     *                 back (the text + sourcePageIds tuple is in a
     *                 deny-list we check at extraction time). */
    status: {
      type: String,
      enum: ['active', 'archived', 'rejected'],
      default: 'active',
      index: true,
    },
    firstSeenAt: { type: Date, default: () => new Date() },
    lastSeenAt: { type: Date, default: () => new Date() },
  },
  { timestamps: true },
);

memoryComponentSchema.index({ userId: 1, status: 1, type: 1 });
memoryComponentSchema.index({ userId: 1, groupId: 1 });
memoryComponentSchema.index({ userId: 1, subject: 1, status: 1 });

export type MemoryComponentDoc = HydratedDocument<
  InferSchemaType<typeof memoryComponentSchema>
> & {
  _id: Types.ObjectId;
};
export const MemoryComponent = model('MemoryComponent', memoryComponentSchema);
