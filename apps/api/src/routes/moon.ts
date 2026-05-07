import { Router } from 'express';
import {
  moonPhase,
  MOON_PHASE_LABEL,
  moonIllumination,
  upcomingPrincipalPhases,
  type MoonPhase,
} from '@rose/shared';
import { logger } from '../lib/logger.js';

export const moonRouter: Router = Router();

/**
 * Single, globally-shared cache for the current moon phase. Phase
 * changes happen at the synodic period (~29.5 days), so a 6-hour TTL
 * is plenty — the UI never sees data more than a few hours stale.
 *
 * USNO (the U.S. Naval Observatory — the authoritative federal
 * source for astronomical data) is the primary; we fall back to a
 * local pure-function calc when their API misbehaves. NOAA does
 * NOT publish moon phase data — they're weather/oceanic — so the
 * "official source" people often want is actually USNO.
 */
type PhaseEvent = { phase: string; date: string };
type CacheEntry = {
  fetchedAt: number;
  phase: MoonPhase;
  label: string;
  illumination: number;
  source: 'usno' | 'local';
  /** Most-recent past + next-future principal phases — the bracket
   *  that includes "today". The card-sized header on /moon shows
   *  these as "Last quarter on Tue · Next: Full Moon Sat". */
  principal?: PhaseEvent[];
  /** Several principal phases into the future. Drives the
   *  "Coming up" list on /moon and the per-day rows on the
   *  printable monthly view. */
  upcoming?: PhaseEvent[];
};

const TTL_MS = 6 * 60 * 60 * 1000;
let cache: CacheEntry | null = null;

const USNO_URL = 'https://aa.usno.navy.mil/api/moon/phases/date';
const USNO_TIMEOUT_MS = 8_000;

/**
 * Map a USNO principal-phase pair (the most-recent past + next
 * future) to the eight named phases we render. Phase between two
 * events is interstitial; if today is within ~12h of an event we
 * snap to its name.
 */
function classifyByPrincipal(
  prevName: string,
  nextName: string,
  hoursSincePrev: number,
  hoursUntilNext: number,
): MoonPhase {
  const SNAP_HOURS = 12;
  const snap = (n: string): MoonPhase | null => {
    switch (n.toLowerCase()) {
      case 'new moon':
        return 'new';
      case 'first quarter':
        return 'first-quarter';
      case 'full moon':
        return 'full';
      case 'last quarter':
        return 'last-quarter';
      default:
        return null;
    }
  };
  if (hoursSincePrev <= SNAP_HOURS) {
    const x = snap(prevName);
    if (x) return x;
  }
  if (hoursUntilNext <= SNAP_HOURS) {
    const x = snap(nextName);
    if (x) return x;
  }
  // Interstitial: name comes from where we are in the lunation cycle.
  const prev = prevName.toLowerCase();
  if (prev === 'new moon') return 'waxing-crescent';
  if (prev === 'first quarter') return 'waxing-gibbous';
  if (prev === 'full moon') return 'waning-gibbous';
  if (prev === 'last quarter') return 'waning-crescent';
  // Should never hit; let the local calc decide.
  return moonPhase(new Date());
}

type UsnoResponse = {
  apiversion?: string;
  phasedata?: {
    year: number;
    month: number;
    day: number;
    time: string; // "HH:MM"
    phase: string;
  }[];
};

function eventDate(p: { year: number; month: number; day: number; time: string }): Date {
  // USNO times are UTC. Build an ISO timestamp directly.
  const [hh, mm] = p.time.split(':').map((n) => Number(n));
  return new Date(
    Date.UTC(
      p.year,
      p.month - 1,
      p.day,
      Number.isFinite(hh) ? (hh as number) : 0,
      Number.isFinite(mm) ? (mm as number) : 0,
    ),
  );
}

async function fromUsno(now: Date): Promise<CacheEntry | null> {
  // Ask for 16 events starting 14 days before today — comfortably
  // brackets today and gives us a few months of upcoming principals
  // for the /moon page's "Coming up" list.
  const start = new Date(now.getTime() - 14 * 24 * 3600 * 1000);
  const dateStr = start.toISOString().slice(0, 10);
  const url = `${USNO_URL}?date=${dateStr}&nump=16`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), USNO_TIMEOUT_MS);
  let body: UsnoResponse;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'rose-wiki/0.1 (+https://github.com/anthropics/rose)',
        Accept: 'application/json',
      },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, 'usno-moon: non-OK response');
      return null;
    }
    body = (await res.json()) as UsnoResponse;
  } catch (err) {
    logger.warn({ err }, 'usno-moon: fetch failed');
    return null;
  } finally {
    clearTimeout(timer);
  }
  const events = (body.phasedata ?? [])
    .map((e) => ({ ...e, when: eventDate(e) }))
    .sort((a, b) => +a.when - +b.when);
  if (events.length < 2) return null;

  // Find the bracket: most recent past event + next future event.
  let prev: (typeof events)[number] | undefined;
  let next: (typeof events)[number] | undefined;
  for (const e of events) {
    if (e.when <= now) prev = e;
    else if (!next) next = e;
  }
  if (!prev || !next) {
    // Shouldn't happen with a 14-day-prior anchor, but if USNO ever
    // returns less data than expected, give up and fall back.
    return null;
  }
  const sincePrevHrs = (now.getTime() - prev.when.getTime()) / 3_600_000;
  const untilNextHrs = (next.when.getTime() - now.getTime()) / 3_600_000;
  const phase = classifyByPrincipal(prev.phase, next.phase, sincePrevHrs, untilNextHrs);
  const futureEvents = events.filter((e) => e.when > now);
  const pastEvents = events.filter((e) => e.when <= now);
  return {
    fetchedAt: Date.now(),
    phase,
    label: MOON_PHASE_LABEL[phase],
    illumination: moonIllumination(now),
    source: 'usno',
    // The bracket: last past + next future, two events.
    principal: [...pastEvents.slice(-1), ...futureEvents.slice(0, 1)].map((e) => ({
      phase: e.phase,
      date: e.when.toISOString(),
    })),
    // Coming up: the next ~8 principal phases.
    upcoming: futureEvents.slice(0, 8).map((e) => ({
      phase: e.phase,
      date: e.when.toISOString(),
    })),
  };
}

function fromLocal(now: Date): CacheEntry {
  const phase = moonPhase(now);
  const upcoming = upcomingPrincipalPhases(now, 8).map((e) => ({
    phase: e.phase,
    date: e.date.toISOString(),
  }));
  return {
    fetchedAt: Date.now(),
    phase,
    label: MOON_PHASE_LABEL[phase],
    illumination: moonIllumination(now),
    source: 'local',
    upcoming,
  };
}

moonRouter.get('/', async (_req, res) => {
  const now = new Date();
  if (cache && Date.now() - cache.fetchedAt < TTL_MS) {
    res.json(cache);
    return;
  }
  const fresh = (await fromUsno(now)) ?? fromLocal(now);
  cache = fresh;
  res.json(fresh);
});
