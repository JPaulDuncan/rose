import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

/**
 * Encyclopedic context for a single subject (a topic, sender brand,
 * tag, or extracted entity), produced by the daydream worker from
 * external knowledge sources during idle periods. Non-destructive —
 * lives alongside the user's content, never modifies Page.contentMd.
 *
 * Dedup key is `(userId, kind, subjectKey)` so the same topic reused
 * across many pages produces one note. Pages back-reference the
 * subjects they depend on via `Page.daydreamSubjects[]`.
 */
const noteSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
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
  },
  { timestamps: true },
);

noteSchema.index({ userId: 1, kind: 1, subjectKey: 1 }, { unique: true });
noteSchema.index({ userId: 1, generatedAt: -1 });

export type DaydreamNoteDoc = HydratedDocument<InferSchemaType<typeof noteSchema>>;
export const DaydreamNote = model('DaydreamNote', noteSchema);
