import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

/**
 * Encyclopedic context for a single subject (a topic, sender brand,
 * tag, or extracted entity), produced by the daydream worker from
 * external knowledge sources during idle periods. Non-destructive —
 * lives alongside the user's content, never modifies Page.contentMd.
 *
 * Plan 14 — notes are now **globally shared** across users. The
 * underlying content is encyclopedic (Wikipedia summaries, OpenAlex
 * abstracts, etc.) and contains no user-specific signal, so any
 * researcher's work benefits every other user. Per-user "forget"
 * lives in `forgottenBy: ObjectId[]` — the user who clicks Forget
 * gets the note hidden from their views, but the note itself
 * persists and any other user's refresh resurfaces it.
 *
 * Dedup key is `(kind, subjectKey)`. `firstResearchedBy` records
 * which user's daydream pass first surfaced the subject; purely
 * informational and not used for filtering.
 */
const noteSchema = new Schema(
  {
    /** Audit-only — first user whose daydream pass surfaced this
     *  subject. Reads MUST NOT filter by this. */
    firstResearchedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    kind: {
      type: String,
      enum: ['topic', 'sender', 'tag', 'entity'],
      required: true,
    },
    /** Normalised dedup key — lowercase for topic/tag/entity, brandKey for sender. */
    subjectKey: { type: String, required: true },
    /** Display string the LLM chose, e.g. "Rust (programming language)". */
    displayName: { type: String, default: '' },
    /** ≤280 chars — collapsed-view headline. */
    summary: { type: String, default: '' },
    /** ≤800 chars markdown — expanded body. */
    bodyMd: { type: String, default: '' },
    sources: {
      type: [
        new Schema(
          {
            adapter: { type: String, required: true },
            url: { type: String, required: true },
            title: { type: String, default: '' },
            fetchedAt: { type: Date, default: () => new Date() },
            contentHash: { type: String, default: null },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    confidence: {
      type: String,
      enum: ['low', 'medium', 'high'],
      default: 'medium',
    },
    /** provider:model string, e.g. "ollama:llama3.1:8b-instruct". */
    model: { type: String, default: null },
    generatedAt: { type: Date, default: null },
    /** Re-research is allowed after this date. Sweeper skips notes
     *  with `staleAfter` in the future. */
    staleAfter: { type: Date, default: null, index: true },
    /** Last attempt produced no usable content from any enabled source. */
    failed: { type: Boolean, default: false },
    failureReason: { type: String, default: null },
    /**
     * Plan 14 — users who've explicitly "forgotten" this note. The
     * note itself stays in the collection (so any user's refresh
     * resurfaces it for everyone else); each entry just hides it
     * from one user's views. Read paths filter
     * `forgottenBy: { $ne: userId }`.
     */
    forgottenBy: { type: [Schema.Types.ObjectId], default: [], index: true },
  },
  { timestamps: true },
);

noteSchema.index({ kind: 1, subjectKey: 1 }, { unique: true });
noteSchema.index({ generatedAt: -1 });

export type DaydreamNoteDoc = HydratedDocument<InferSchemaType<typeof noteSchema>>;
export const DaydreamNote = model('DaydreamNote', noteSchema);
