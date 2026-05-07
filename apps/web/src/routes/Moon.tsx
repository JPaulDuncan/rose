import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import { useApi } from '../lib/api';
import { MoonPhaseIcon } from '../components/MoonPhaseIcon';
import type { MoonPhase } from '@rose/shared';

type MoonResp = {
  phase: MoonPhase;
  label: string;
  illumination: number;
  source: 'usno' | 'local';
  principal?: { phase: string; date: string }[];
  upcoming?: { phase: string; date: string }[];
};

/**
 * Full-page moon view. Pulls from /api/moon, which the API resolves
 * from the U.S. Naval Observatory (the federal authority for
 * astronomical data — NOAA does NOT publish moon-phase data) with a
 * graceful local-calc fallback when USNO is unreachable.
 */
export default function MoonPage() {
  const api = useApi();
  const { data, isLoading } = useQuery({
    queryKey: ['moon-page'],
    queryFn: () => api.get<MoonResp>('/api/moon'),
    refetchInterval: 60 * 60_000,
    staleTime: 30 * 60_000,
  });

  if (isLoading || !data) {
    return <div className="px-6 py-10 text-ink-500">Loading…</div>;
  }

  const illumPct = Math.round(data.illumination * 100);
  const sourceLabel =
    data.source === 'usno' ? 'U.S. Naval Observatory' : 'local approximation';

  // Try to find the bracketing past + next-future event for the
  // header line. principal[] is [past, future] when USNO resolved;
  // when it's the local fallback we may only have `upcoming`.
  const past = data.principal?.[0];
  const next =
    data.principal?.[1] ??
    (data.upcoming && data.upcoming.length > 0 ? data.upcoming[0] : undefined);

  const upcoming = data.upcoming ?? [];

  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-8">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3 border-b border-ink-200 pb-4 dark:border-ink-800">
        <div>
          <div className="flex items-center gap-2 text-xs uppercase tracking-widest text-rose-500">
            <Sparkles className="h-3.5 w-3.5" />
            Moon Phase
          </div>
          <h1 className="mt-1 text-3xl font-bold tracking-tight">{data.label}</h1>
          <p className="mt-1 text-xs text-ink-500">
            {illumPct}% illuminated · source: {sourceLabel}
          </p>
        </div>
      </header>

      <section className="card mb-6 overflow-hidden bg-gradient-to-br from-ink-50 via-white to-rose-50/40 dark:from-ink-900 dark:via-ink-950 dark:to-rose-950/10">
        <div className="flex flex-col items-start gap-6 sm:flex-row sm:items-center">
          <MoonPhaseIcon
            phase={data.phase}
            size={120}
            title={data.label}
            className="shrink-0"
          />
          <div className="min-w-0 flex-1">
            <div className="text-[10px] uppercase tracking-widest text-ink-500">
              Today
            </div>
            <div className="mt-1 font-serif text-4xl font-bold tracking-tight">
              {data.label}
            </div>
            <div className="mt-2 grid gap-1 text-sm text-ink-700 dark:text-ink-200">
              {past && (
                <div>
                  <span className="text-ink-500">Last: </span>
                  <span className="font-medium">{past.phase}</span>
                  <span className="ml-2 text-xs text-ink-500">
                    {humanDate(past.date)}
                  </span>
                </div>
              )}
              {next && (
                <div>
                  <span className="text-ink-500">Next: </span>
                  <span className="font-medium">{next.phase}</span>
                  <span className="ml-2 text-xs text-ink-500">
                    {humanDate(next.date)}
                  </span>
                </div>
              )}
              <div>
                <span className="text-ink-500">Illuminated: </span>
                <span className="font-medium tabular-nums">{illumPct}%</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-widest text-ink-500">
          Coming up
        </h2>
        {upcoming.length === 0 ? (
          <div className="card text-sm text-ink-500">
            Couldn't load upcoming phase events.
          </div>
        ) : (
          <ol className="grid gap-2 sm:grid-cols-2">
            {upcoming.map((e, i) => (
              <li
                key={`${e.phase}-${e.date}-${i}`}
                className="flex items-center gap-3 rounded-lg border border-ink-200 p-3 dark:border-ink-800"
              >
                <PrincipalGlyph principalName={e.phase} />
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{e.phase}</div>
                  <div className="text-xs text-ink-500">
                    {humanDateLong(e.date)}
                  </div>
                </div>
                <div className="shrink-0 text-right text-xs text-ink-500">
                  {relativeFromNow(e.date)}
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      <footer className="mt-6 text-xs text-ink-500">
        <p>
          Moon phase data is fetched from the{' '}
          <a
            href="https://aa.usno.navy.mil/data/api"
            target="_blank"
            rel="noreferrer"
            className="text-rose-600 hover:underline dark:text-rose-300"
          >
            U.S. Naval Observatory
          </a>{' '}
          — the federal authority for astronomical data. (NOAA, often confused
          with USNO, doesn't publish lunar data; they're a weather and oceanic
          agency.) When USNO is unreachable, Rose falls back to a synodic-period
          approximation accurate to within a few hours.{' '}
          <Link
            to="/calendar"
            className="text-rose-600 hover:underline dark:text-rose-300"
          >
            See moon phases on the calendar
          </Link>
          .
        </p>
      </footer>
    </div>
  );
}

/**
 * Map a USNO principal-phase name to the named moon-phase enum the
 * MoonPhaseIcon renders. (USNO's phasedata uses the four primary
 * names; our local enum has eight.)
 */
function PrincipalGlyph({ principalName }: { principalName: string }) {
  const map: Record<string, MoonPhase> = {
    'New Moon': 'new',
    'First Quarter': 'first-quarter',
    'Full Moon': 'full',
    'Last Quarter': 'last-quarter',
  };
  const phase = map[principalName] ?? 'new';
  return <MoonPhaseIcon phase={phase} size={28} title={principalName} />;
}

function humanDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

function humanDateLong(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function relativeFromNow(iso: string): string {
  const now = Date.now();
  const t = new Date(iso).getTime();
  const diff = t - now;
  const days = Math.round(diff / (24 * 3600 * 1000));
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days < 7) return `in ${days}d`;
  if (days < 30) return `in ${Math.round(days / 7)}w`;
  return `in ${Math.round(days / 30)}mo`;
}
