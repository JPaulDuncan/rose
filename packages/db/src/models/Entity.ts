import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

/**
 * Named entity types the registry recognises. `person`, `work`, and
 * `organization` come from the linker-driven `extract.entities`
 * step. `place` rows are written by the place-extraction step
 * (post-geocoding) so /n/<key> can route uniformly without
 * special-casing places in every API handler.
 *
 * Plan 12 (R3) — `place` was added when the audit flagged the
 * cross-collection special-casing as redundant. Place rows still
 * live alongside entries in Page.places[] (which carries lat/lon);
 * Entity is the canonical "everything named" registry.
 */
export const ENTITY_TYPES = ['person', 'work', 'organization', 'place'] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

/**
 * Daydream subject-key normalisation: whitespace-collapsed lowercase
 * displayName form (NOT kebab). The daydream subsystem uses this so
 * notes are reusable across surfaces (page Background panel, /n/<key>
 * entity page, Settings → Daydream recent activity).
 *
 * Plan 13 (D2) folded `apps/worker/src/lib/sourceLabel.ts`'s
 * `normaliseSubjectKey`, the `daydreamSubjectKey` helper in
 * `apps/api/src/routes/entities.ts`, and two inline call sites in
 * the same file into this single export.
 */
export function daydreamSubjectKey(displayName: string | null | undefined): string {
  return (displayName ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Per-user named-entity registry. One row per (userId, key) so the
 * /n/:key route, the auto-linker, and the future Settings →
 * Entities tab can all share a fast lookup. `aliases` lets the LLM
 * fold "Wait Wait" into the same row as "Wait Wait... Don't Tell
 * Me!" without spawning two pages.
 */
const entitySchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    /** Stable kebab-case lookup key. Used as the URL slug
     *  (`/n/<key>`) and as the value the auto-linker matches
     *  against. */
    key: { type: String, required: true },
    /** Human-readable form rendered in prose ("Wait Wait... Don't
     *  Tell Me!"). The original casing + punctuation the LLM
     *  emitted. */
    displayName: { type: String, required: true },
    type: { type: String, enum: ENTITY_TYPES, required: true, index: true },
    /** Other surface forms that should fold into this entity. Stored
     *  in normalised kebab form. */
    aliases: { type: [String], default: [], index: true },
    /** Rolling count of pages currently carrying this entity. Lazy;
     *  best-effort signal for sorting in the directory UI. */
    pageCount: { type: Number, default: 0 },
    lastSeenAt: { type: Date, default: () => new Date() },
  },
  { timestamps: true },
);

entitySchema.index({ userId: 1, key: 1 }, { unique: true });
entitySchema.index({ userId: 1, type: 1, pageCount: -1 });

export type EntityDoc = HydratedDocument<InferSchemaType<typeof entitySchema>>;
export const Entity = model('Entity', entitySchema);
