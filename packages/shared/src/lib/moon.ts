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

/**
 * Approximate upcoming principal-phase events relative to `from`.
 * Useful as a local fallback when the USNO API is unreachable.
 *
 * Returns the next `count` principal phases (New, First Quarter,
 * Full, Last Quarter), accurate to within a few hours of the true
 * astronomical event over a 50-year span. Phase fractions step by
 * 1/4 of the synodic period.
 */
export function upcomingPrincipalPhases(
  from: Date,
  count = 8,
): { phase: string; date: Date }[] {
  const labels = ['New Moon', 'First Quarter', 'Full Moon', 'Last Quarter'];
  const a = moonAge(from);
  // Walk forward in 0.25-of-lunation steps from the next quarter
  // boundary that's strictly after `from`.
  const out: { phase: string; date: Date }[] = [];
  // The fractional progress of the *next* quarter event is the next
  // multiple of 0.25 above `a`.
  let nextQuarter = Math.ceil(a * 4) / 4;
  if (nextQuarter === a) nextQuarter += 0.25;
  for (let i = 0; i < count; i += 1) {
    const target = nextQuarter + i * 0.25;
    // Days from the reference new moon to this target fractional age.
    // Solve: ((days / SYNODIC_DAYS) - floor(days / SYNODIC_DAYS)) === target
    // We anchor to the lunation containing `from`, so:
    const lunationsBeforeFrom = Math.floor(
      (from.getTime() - REFERENCE_NEW_MOON_MS) / 86_400_000 / SYNODIC_DAYS,
    );
    const lunationFromAnchor =
      lunationsBeforeFrom + Math.floor(target);
    const fraction = target - Math.floor(target);
    const days = (lunationFromAnchor + fraction) * SYNODIC_DAYS;
    const ms = REFERENCE_NEW_MOON_MS + days * 86_400_000;
    const phaseIdx = Math.round(fraction * 4) % 4;
    out.push({
      phase: labels[phaseIdx]!,
      date: new Date(ms),
    });
  }
  return out;
}
