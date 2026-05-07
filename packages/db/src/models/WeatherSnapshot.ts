import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

/**
 * One observation (really, NOAA's "current period" forecast) for a
 * given lat/lon, captured each time a user's weather panel pulls
 * fresh data. Globally-shared across users so one location's trend
 * line doesn't depend on which account fetched it.
 *
 * Lat/lon are rounded to 3 decimal places (~110 m) before insert
 * so concurrent users hitting the same NOAA point produce the same
 * row key, and so unique enforcement is meaningful.
 */
const snapshotSchema = new Schema(
  {
    /** Rounded lat (3 d.p.) so identical-but-jittery coords dedupe. */
    lat: { type: Number, required: true },
    lon: { type: Number, required: true },
    /** Best-known display label for this point (last writer wins). */
    label: { type: String, default: '' },
    /** When the API actually fetched the data (not when the period
     *  starts/ends — that lives in startTime/endTime below). */
    fetchedAt: { type: Date, required: true },
    /** The NOAA forecast period that was rendered as "current" at
     *  fetchedAt. Stored verbatim so we can replay any historical
     *  snapshot without re-deriving fields. */
    temperature: { type: Number, required: true },
    temperatureUnit: { type: String, default: 'F' },
    shortForecast: { type: String, default: '' },
    windSpeed: { type: String, default: '' },
    windDirection: { type: String, default: '' },
    isDaytime: { type: Boolean, default: true },
    icon: { type: String, default: null },
    startTime: { type: Date, default: null },
    endTime: { type: Date, default: null },
  },
  { timestamps: false },
);

snapshotSchema.index({ lat: 1, lon: 1, fetchedAt: -1 });
// Unique on (point, fetchedAt) so a poll race or duplicate fetch
// doesn't insert two rows for the same instant.
snapshotSchema.index({ lat: 1, lon: 1, fetchedAt: 1 }, { unique: true });
// 365-day TTL — trend charts beyond a year aren't actionable for a
// personal weather widget, and unlimited growth doesn't pay rent.
snapshotSchema.index(
  { fetchedAt: 1 },
  { expireAfterSeconds: 365 * 24 * 3600 },
);

export type WeatherSnapshotDoc = HydratedDocument<InferSchemaType<typeof snapshotSchema>>;
export const WeatherSnapshot = model('WeatherSnapshot', snapshotSchema);
