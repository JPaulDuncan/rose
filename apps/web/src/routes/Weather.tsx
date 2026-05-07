import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CloudSun, MapPin, Settings as SettingsIcon } from 'lucide-react';
import { useApi } from '../lib/api';

type WeatherLocation = {
  id: string;
  lat: number;
  lon: number;
  label: string;
  primary: boolean;
};

type ForecastPeriod = {
  number: number;
  name: string;
  startTime: string;
  endTime: string;
  isDaytime: boolean;
  temperature: number;
  temperatureUnit: string;
  shortForecast: string;
  detailedForecast: string;
  windSpeed: string;
  windDirection?: string;
  icon?: string;
};

type WeatherOk = {
  configured: true;
  location: WeatherLocation;
  locations: WeatherLocation[];
  current: ForecastPeriod | null;
  periods: ForecastPeriod[];
  brief: string;
  fetchedAt: string;
  cached: boolean;
  error?: undefined;
};
type WeatherErr = { configured: true; error: string; message?: string };
type WeatherUnconfigured = { configured: false };
type WeatherResp = WeatherUnconfigured | WeatherOk | WeatherErr;

type Snapshot = {
  fetchedAt: string;
  temperature: number;
  temperatureUnit: string;
  shortForecast: string;
  windSpeed: string;
  isDaytime: boolean;
  icon: string | null;
};

type RangeKey = '24h' | '7d' | '30d' | '90d';
const RANGES: { key: RangeKey; label: string; hours: number }[] = [
  { key: '24h', label: 'Last 24 hours', hours: 24 },
  { key: '7d', label: 'Last 7 days', hours: 24 * 7 },
  { key: '30d', label: 'Last 30 days', hours: 24 * 30 },
  { key: '90d', label: 'Last 90 days', hours: 24 * 90 },
];

/**
 * Full-page weather view: current condition, the next ~5 forecast
 * periods, the user's saved-location switcher, and a temperature
 * trend chart drawn from the WeatherSnapshot history that the API
 * accumulates on every poll.
 */
export default function WeatherPage() {
  const api = useApi();
  const [params, setParams] = useSearchParams();
  const activeId = params.get('id') ?? null;
  const range = (params.get('range') as RangeKey) ?? '7d';
  const rangeHours = RANGES.find((r) => r.key === range)?.hours ?? 24 * 7;

  const { data, isLoading } = useQuery({
    queryKey: ['weather-page', activeId ?? 'primary'],
    queryFn: () =>
      api.get<WeatherResp>(
        activeId ? `/api/weather?id=${encodeURIComponent(activeId)}` : '/api/weather',
      ),
    refetchInterval: 5 * 60_000,
  });

  const fromIso = useMemo(
    () => new Date(Date.now() - rangeHours * 3600 * 1000).toISOString(),
    [rangeHours],
  );
  const { data: history } = useQuery({
    queryKey: ['weather-history', activeId ?? 'primary', range],
    queryFn: () =>
      api.get<{ snapshots: Snapshot[] }>(
        `/api/weather/history?from=${encodeURIComponent(fromIso)}` +
          (activeId ? `&id=${encodeURIComponent(activeId)}` : ''),
      ),
    refetchInterval: 5 * 60_000,
  });

  function setActiveId(id: string | null) {
    const next = new URLSearchParams(params);
    if (id) next.set('id', id);
    else next.delete('id');
    setParams(next, { replace: true });
  }
  function setRange(r: RangeKey) {
    const next = new URLSearchParams(params);
    next.set('range', r);
    setParams(next, { replace: true });
  }

  if (isLoading) {
    return <div className="px-6 py-10 text-ink-500">Loading…</div>;
  }
  if (!data || data.configured === false) {
    return (
      <div className="mx-auto w-full max-w-3xl px-6 py-10">
        <div className="card flex flex-col items-center gap-3 py-16 text-center">
          <CloudSun className="h-10 w-10 text-rose-500" />
          <div>
            <h2 className="font-semibold">No weather location yet</h2>
            <p className="mt-1 text-sm text-ink-500">
              Add one in Settings → Newsletter to see today's forecast and a
              temperature trend chart.
            </p>
          </div>
          <Link to="/settings/newsletter" className="btn-primary">
            <SettingsIcon className="h-4 w-4" /> Open settings
          </Link>
        </div>
      </div>
    );
  }
  if ('error' in data && data.error) {
    return (
      <div className="mx-auto w-full max-w-3xl px-6 py-10">
        <div className="card text-sm text-amber-800 dark:text-amber-200">
          Weather temporarily unavailable: {data.message ?? data.error}
        </div>
      </div>
    );
  }

  const ok = data as WeatherOk;
  const cur = ok.current;
  const snapshots = history?.snapshots ?? [];

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-8">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3 border-b border-ink-200 pb-4 dark:border-ink-800">
        <div>
          <div className="flex items-center gap-2 text-xs uppercase tracking-widest text-rose-500">
            <CloudSun className="h-3.5 w-3.5" />
            Forecast
          </div>
          <h1 className="mt-1 flex items-center gap-2 text-3xl font-bold tracking-tight">
            <MapPin className="h-5 w-5 text-rose-500" />
            {ok.location.label}
          </h1>
          <p className="text-xs text-ink-500">
            <code>
              {ok.location.lat.toFixed(3)}, {ok.location.lon.toFixed(3)}
            </code>
            {' · '}
            updated{' '}
            {new Date(ok.fetchedAt).toLocaleTimeString(undefined, {
              hour: 'numeric',
              minute: '2-digit',
            })}
          </p>
        </div>
        {ok.locations.length > 1 && (
          <div className="flex flex-wrap gap-1.5">
            {ok.locations.map((l) => {
              const isActive = l.id === ok.location.id;
              return (
                <button
                  key={l.id}
                  type="button"
                  onClick={() => setActiveId(l.id)}
                  className={
                    'rounded-full px-2.5 py-0.5 text-xs transition-colors ' +
                    (isActive
                      ? 'bg-rose-600 text-white'
                      : 'bg-ink-100 text-ink-700 hover:bg-rose-100 hover:text-rose-700 dark:bg-ink-800 dark:text-ink-200 dark:hover:bg-rose-950/40 dark:hover:text-rose-200')
                  }
                  title={l.label}
                >
                  {l.label.split(',')[0]}
                </button>
              );
            })}
          </div>
        )}
      </header>

      <section className="card mb-6 overflow-hidden bg-gradient-to-br from-sky-50 via-white to-rose-50 dark:from-sky-950/30 dark:via-ink-900 dark:to-rose-950/20">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          {cur?.icon && (
            <img
              src={cur.icon}
              alt={cur.shortForecast}
              className="h-24 w-24 shrink-0 rounded-lg border border-ink-200 bg-white object-cover dark:border-ink-700"
              referrerPolicy="no-referrer"
            />
          )}
          <div className="min-w-0 flex-1">
            <div className="text-[10px] uppercase tracking-widest text-ink-500">
              Now
            </div>
            {cur && (
              <>
                <div className="mt-0.5 flex items-baseline gap-3">
                  <span className="font-serif text-5xl font-black tracking-tight">
                    {cur.temperature}°{cur.temperatureUnit}
                  </span>
                  <span className="text-base text-ink-700 dark:text-ink-200">
                    {cur.shortForecast}
                  </span>
                </div>
                <div className="mt-1 text-xs text-ink-500">
                  Wind {cur.windSpeed}
                  {cur.windDirection ? ` ${cur.windDirection}` : ''}
                </div>
                <p className="mt-3 text-sm leading-relaxed text-ink-700 dark:text-ink-200">
                  {cur.detailedForecast}
                </p>
              </>
            )}
          </div>
        </div>
      </section>

      <section className="mb-6">
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-widest text-ink-500">
            Temperature trend
          </h2>
          <div className="flex flex-wrap gap-1.5">
            {RANGES.map((r) => {
              const isActive = r.key === range;
              return (
                <button
                  key={r.key}
                  type="button"
                  onClick={() => setRange(r.key)}
                  className={
                    'rounded-full px-2 py-0.5 text-[11px] transition-colors ' +
                    (isActive
                      ? 'bg-ink-900 text-white dark:bg-ink-100 dark:text-ink-950'
                      : 'bg-ink-100 text-ink-700 hover:bg-ink-200 dark:bg-ink-800 dark:text-ink-200 dark:hover:bg-ink-700')
                  }
                >
                  {r.label}
                </button>
              );
            })}
          </div>
        </div>
        <div className="card">
          <TrendChart snapshots={snapshots} unit={cur?.temperatureUnit ?? 'F'} />
          <p className="mt-2 text-xs text-ink-500">
            {snapshots.length === 0
              ? 'No history yet — snapshots accumulate as the home weather panel polls (every 30 minutes).'
              : `${snapshots.length} reading${snapshots.length === 1 ? '' : 's'} in the last ${
                  RANGES.find((r) => r.key === range)?.label.toLowerCase() ?? 'period'
                }.`}
          </p>
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-widest text-ink-500">
          Forecast
        </h2>
        <ul className="grid gap-2 sm:grid-cols-2">
          {ok.periods.map((p) => (
            <li
              key={p.number}
              className="flex items-start gap-3 rounded-lg border border-ink-200 p-3 dark:border-ink-800"
            >
              {p.icon && (
                <img
                  src={p.icon}
                  alt={p.shortForecast}
                  className="h-12 w-12 shrink-0 rounded border border-ink-200 bg-white object-cover dark:border-ink-700"
                  referrerPolicy="no-referrer"
                />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-medium">{p.name}</span>
                  <span className="font-serif text-lg font-bold tabular-nums">
                    {p.temperature}°{p.temperatureUnit}
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-ink-700 dark:text-ink-300">
                  {p.shortForecast}
                </p>
                <p className="mt-1 text-[11px] text-ink-500">
                  Wind {p.windSpeed}
                  {p.windDirection ? ` ${p.windDirection}` : ''}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/* ---------------- Trend chart -------------------------------------------- */

const CHART_W = 760;
const CHART_H = 220;
const CHART_PAD = { top: 16, right: 12, bottom: 28, left: 36 };

function TrendChart({ snapshots, unit }: { snapshots: Snapshot[]; unit: string }) {
  // Useful early-out: nothing to draw.
  if (snapshots.length === 0) {
    return (
      <div className="flex h-[180px] items-center justify-center text-sm text-ink-400">
        No data in this range yet.
      </div>
    );
  }

  const xs = snapshots.map((s) => new Date(s.fetchedAt).getTime());
  const ys = snapshots.map((s) => s.temperature);
  const xMin = xs[0]!;
  const xMax = xs[xs.length - 1]!;
  const xSpan = Math.max(xMax - xMin, 1);
  // Pad the y-axis a little so the line never touches the frame.
  const yLo = Math.min(...ys);
  const yHi = Math.max(...ys);
  const yPad = Math.max(2, (yHi - yLo) * 0.1);
  const yMin = Math.floor(yLo - yPad);
  const yMax = Math.ceil(yHi + yPad);
  const ySpan = Math.max(yMax - yMin, 1);

  const innerW = CHART_W - CHART_PAD.left - CHART_PAD.right;
  const innerH = CHART_H - CHART_PAD.top - CHART_PAD.bottom;

  function px(t: number) {
    return CHART_PAD.left + ((t - xMin) / xSpan) * innerW;
  }
  function py(v: number) {
    return CHART_PAD.top + (1 - (v - yMin) / ySpan) * innerH;
  }

  const linePath = snapshots
    .map((s, i) => {
      const cmd = i === 0 ? 'M' : 'L';
      return `${cmd}${px(xs[i]!).toFixed(1)},${py(s.temperature).toFixed(1)}`;
    })
    .join(' ');

  // Y-axis ticks: 4 evenly-spaced gridlines.
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(yMin + f * ySpan));
  // X-axis ticks: ~5 evenly-spaced labels along the time range.
  const xTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => xMin + f * xSpan);

  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    const svg = e.currentTarget;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const local = pt.matrixTransform(ctm.inverse());
    // Find the snapshot whose x is closest to the cursor.
    let best = 0;
    let bestDx = Infinity;
    for (let i = 0; i < snapshots.length; i += 1) {
      const dx = Math.abs(px(xs[i]!) - local.x);
      if (dx < bestDx) {
        bestDx = dx;
        best = i;
      }
    }
    setHoverIdx(best);
  }

  const hovered = hoverIdx != null ? snapshots[hoverIdx] : null;

  return (
    <div className="overflow-x-auto">
      <svg
        viewBox={`0 0 ${CHART_W} ${CHART_H}`}
        className="block w-full text-ink-500"
        preserveAspectRatio="none"
        style={{ height: 220 }}
        onMouseMove={onMove}
        onMouseLeave={() => setHoverIdx(null)}
        role="img"
        aria-label="Temperature over time"
      >
        {yTicks.map((t) => {
          const y = py(t);
          return (
            <g key={`y-${t}`}>
              <line
                x1={CHART_PAD.left}
                x2={CHART_W - CHART_PAD.right}
                y1={y}
                y2={y}
                stroke="currentColor"
                strokeOpacity={0.12}
                strokeDasharray="2 4"
              />
              <text
                x={CHART_PAD.left - 6}
                y={y + 3}
                fontSize={10}
                textAnchor="end"
                fill="currentColor"
                opacity={0.6}
              >
                {t}°{unit}
              </text>
            </g>
          );
        })}
        {xTicks.map((t, i) => {
          const x = px(t);
          const d = new Date(t);
          // Pick a label format based on range length.
          const span = xSpan / 1000 / 3600;
          const label =
            span < 36
              ? d.toLocaleTimeString(undefined, { hour: 'numeric' })
              : span < 24 * 14
                ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
                : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
          return (
            <text
              key={`x-${i}`}
              x={x}
              y={CHART_H - 8}
              fontSize={10}
              textAnchor="middle"
              fill="currentColor"
              opacity={0.6}
            >
              {label}
            </text>
          );
        })}
        <path
          d={linePath}
          fill="none"
          stroke="currentColor"
          strokeOpacity={0.85}
          strokeWidth={1.5}
          className="text-rose-500"
        />
        {snapshots.length < 60 &&
          snapshots.map((s, i) => (
            <circle
              key={`pt-${i}`}
              cx={px(xs[i]!)}
              cy={py(s.temperature)}
              r={2}
              className="fill-rose-500"
            />
          ))}
        {hovered && hoverIdx != null && (
          <g>
            <line
              x1={px(xs[hoverIdx]!)}
              x2={px(xs[hoverIdx]!)}
              y1={CHART_PAD.top}
              y2={CHART_H - CHART_PAD.bottom}
              stroke="currentColor"
              strokeOpacity={0.35}
            />
            <circle
              cx={px(xs[hoverIdx]!)}
              cy={py(hovered.temperature)}
              r={4}
              className="fill-rose-500 stroke-white dark:stroke-ink-950"
              strokeWidth={1.5}
            />
          </g>
        )}
      </svg>
      {hovered && (
        <div className="-mt-2 px-2 text-xs text-ink-600 dark:text-ink-300">
          <span className="font-mono tabular-nums">
            {new Date(hovered.fetchedAt).toLocaleString(undefined, {
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
            })}
          </span>
          {' · '}
          <span className="font-medium">
            {hovered.temperature}°{hovered.temperatureUnit}
          </span>
          {' · '}
          <span>{hovered.shortForecast}</span>
        </div>
      )}
    </div>
  );
}
