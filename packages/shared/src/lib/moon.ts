/**
 * Pure-function moon-phase calculator.
 *
 * Uses a fixed reference new moon (2000-01-06 18:14 UTC, the standard
 * J2000-era anchor) and the synodic period (29.530588853 days) to
 * compute the elapsed fraction of the current lunation. No external
 * API; accuracy is ~few hours of the true new-moon, which is plenty
 * for an icon that flips through eight buckets.
 */

const SYNODIC_DAYS = 29.530588853;
const REFERENCE_NEW_MOON_MS = Date.UTC(2000, 0, 6, 18, 14, 0);

export const MOON_PHASES = [
  'new',
  'waxing-crescent',
  'first-quarter',
  'waxing-gibbous',
  'full',
  'waning-gibbous',
  'last-quarter',
  'waning-crescent',
] as const;

export type MoonPhase = (typeof MOON_PHASES)[number];

/** Human-readable label per phase. */
export const MOON_PHASE_LABEL: Record<MoonPhase, string> = {
  new: 'New moon',
  'waxing-crescent': 'Waxing crescent',
  'first-quarter': 'First quarter',
  'waxing-gibbous': 'Waxing gibbous',
  full: 'Full moon',
  'waning-gibbous': 'Waning gibbous',
  'last-quarter': 'Last quarter',
  'waning-crescent': 'Waning crescent',
};

/**
 * Returns the elapsed fraction of the current synodic month for `date`,
 * in [0, 1). 0 = new moon, 0.25 = first quarter, 0.5 = full, etc.
 */
export function moonAge(date: Date): number {
  const days = (date.getTime() - REFERENCE_NEW_MOON_MS) / 86_400_000;
  let frac = (days / SYNODIC_DAYS) % 1;
  if (frac < 0) frac += 1;
  return frac;
}

/**
 * Bucket the lunation fraction into one of the eight named phases.
 * Each phase is a 1/8 slice centered on the canonical event:
 *   new            → centred at 0
 *   waxing crescent→ centred at 1/8
 *   first quarter  → centred at 1/4
 *   waxing gibbous → centred at 3/8
 *   full           → centred at 1/2
 *   waning gibbous → centred at 5/8
 *   last quarter   → centred at 3/4
 *   waning crescent→ centred at 7/8
 */
export function moonPhase(date: Date): MoonPhase {
  const a = moonAge(date);
  // Shift by half a slice so each canonical event sits in the middle
  // of its bucket. Slice width = 1/8 = 0.125.
  const slot = Math.floor(((a + 1 / 16) % 1) * 8);
  return MOON_PHASES[slot] ?? 'new';
}

/** Illuminated fraction in [0, 1] — sinusoidal approximation. */
export function moonIllumination(date: Date): number {
  const a = moonAge(date);
  // 0 at new, 1 at full, back to 0 at next new — symmetrical.
  return (1 - Math.cos(2 * Math.PI * a)) / 2;
}
