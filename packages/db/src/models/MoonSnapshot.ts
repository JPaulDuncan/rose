import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

/**
 * One snapshot of the current moon phase + the principal events
 * around it (last past + next upcoming, plus a longer "Coming up"
 * calendar). Globally shared — moon phase is the same for every
 * observer on Earth, so we store one row per fetch and hand it to
 * every user that asks.
 *
 * Same shared-data treatment as WeatherSnapshot: any user's
 * request hydrates the row, and subsequent users (across processes
 * and after a restart) reuse it without round-tripping to USNO
 * again until the TTL expires.
 *
 * Storage shape mirrors the API's in-memory CacheEntry verbatim so
 * hydration is a straight shape-pass. We keep a rolling history
 * (capped by the TTL index) rather than a singleton so the on-disk
 * row never blocks a fresh write — any stale row simply ages out.
 */
const moonSnapshotSchema = new Schema(
  {
    /** When the data was fetched. Read paths take the row with the
     *  latest fetchedAt within the TTL window. */
    fetchedAt: { type: Date, required: true, index: true },
    /** One of 'new' | 'waxing-crescent' | 'first-quarter' |
     *  'waxing-gibbous' | 'full' | 'waning-gibbous' |
     *  'last-quarter' | 'waning-crescent'. */
    phase: { type: String, required: true },
    label: { type: String, required: true },
    /** 0–1 fraction of the visible disc lit. */
    illumination: { type: Number, required: true },
    /** Where the data came from — 'usno' (preferred) or 'local'
     *  (the pure-function fallback when USNO is unreachable). */
    source: { type: String, enum: ['usno', 'local'], required: true },
    /** Most-recent past + next-future principal phases bracketing
     *  the snapshot. Two events. */
    principal: {
      type: [
        new Schema(
          {
            phase: { type: String, required: true },
            date: { type: String, required: true },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    /** Several principal phases into the future. Drives the
     *  "Coming up" list on /moon. */
    upcoming: {
      type: [
        new Schema(
          {
            phase: { type: String, required: true },
            date: { type: String, required: true },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
  },
  { timestamps: false },
);

// 30-day TTL — well past the 6-hour cache window. Old snapshots
// don't need to stick around once they're expired; the next request
// repopulates from USNO.
moonSnapshotSchema.index(
  { fetchedAt: 1 },
  { expireAfterSeconds: 30 * 24 * 3600 },
);

export type MoonSnapshotDoc = HydratedDocument<InferSchemaType<typeof moonSnapshotSchema>>;
export const MoonSnapshot = model('MoonSnapshot', moonSnapshotSchema);
