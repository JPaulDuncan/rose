import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Calendar as CalendarIcon,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  MapPin as MapPinIcon,
  EyeOff,
  X,
  Rss,
  AtSign,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useApi } from '../lib/api';
import { MapInset, type MapPin } from '../components/MapInset';

type CalendarEventDoc = {
  _id: string;
  title: string;
  start: string;
  end: string | null;
  allDay: boolean;
  location: string | null;
  description: string;
  pageSlug: string | null;
  pageId: string | null;
  sourceEmailId: string;
  dismissed: boolean;
  sourceFromName: string | null;
  sourceFromAddress: string | null;
  sourceSubject: string | null;
  sourceKind: 'email' | 'rss' | null;
  /** Plan 11 — geocoded location for the map inset. */
  geocoded?: {
    lat: number | null;
    lon: number | null;
    displayName: string | null;
    at: string | null;
  };
};

type ViewMode = 'day' | 'week' | 'month';

function startOfMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function endOfMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
}
function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function endOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}
function startOfWeek(d: Date) {
  const out = startOfDay(d);
  out.setDate(out.getDate() - out.getDay()); // Sunday
  return out;
}
function endOfWeek(d: Date) {
  const out = endOfDay(d);
  out.setDate(out.getDate() + (6 - out.getDay()));
  return out;
}
function addDays(d: Date, n: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function addMonths(d: Date, n: number) {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}
function sameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export default function CalendarPage() {
  const api = useApi();
  const qc = useQueryClient();
  const [view, setView] = useState<ViewMode>('month');
  const [cursor, setCursor] = useState<Date>(startOfDay(new Date()));

  // Fetch a window appropriate to the active view (with a bit of bleed for
  // the month grid's leading/trailing days).
  const { fetchStart, fetchEnd } = useMemo(() => {
    if (view === 'day') return { fetchStart: startOfDay(cursor), fetchEnd: endOfDay(cursor) };
    if (view === 'week')
      return { fetchStart: startOfWeek(cursor), fetchEnd: endOfWeek(cursor) };
    const monthStart = startOfMonth(cursor);
    const monthEnd = endOfMonth(cursor);
    const gridStart = addDays(monthStart, -monthStart.getDay());
    const gridEnd = addDays(gridStart, 41);
    return { fetchStart: gridStart, fetchEnd: gridEnd };
  }, [view, cursor]);

  const { data } = useQuery({
    queryKey: ['events', fetchStart.toISOString(), fetchEnd.toISOString()],
    queryFn: () =>
      api.get<{ events: CalendarEventDoc[] }>(
        `/api/events?from=${fetchStart.toISOString()}&to=${fetchEnd.toISOString()}`,
      ),
  });
  const { data: upcoming } = useQuery({
    queryKey: ['events-upcoming'],
    queryFn: () =>
      api.get<{ events: CalendarEventDoc[] }>('/api/events/upcoming?limit=12'),
  });

  const dismiss = useMutation({
    mutationFn: async (id: string) =>
      api.post<{ ok: true }>(`/api/events/${id}/dismiss`),
    onSuccess: () => {
      toast.success('Event hidden');
      qc.invalidateQueries({ queryKey: ['events'] });
      qc.invalidateQueries({ queryKey: ['events-upcoming'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Bucket events by day for fast lookup across all views.
  const byDay = useMemo(() => {
    const m = new Map<string, CalendarEventDoc[]>();
    for (const e of data?.events ?? []) {
      const key = startOfDay(new Date(e.start)).toISOString();
      const arr = m.get(key) ?? [];
      arr.push(e);
      m.set(key, arr);
    }
    for (const arr of m.values())
      arr.sort((a, b) => +new Date(a.start) - +new Date(b.start));
    return m;
  }, [data]);

  const headerLabel = useMemo(() => {
    if (view === 'day')
      return cursor.toLocaleDateString(undefined, {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
    if (view === 'week') {
      const ws = startOfWeek(cursor);
      const we = endOfWeek(cursor);
      const sameMonth = ws.getMonth() === we.getMonth();
      const left = ws.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      const right = we.toLocaleDateString(undefined, {
        month: sameMonth ? undefined : 'short',
        day: 'numeric',
        year: 'numeric',
      });
      return `${left} – ${right}`;
    }
    return cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  }, [view, cursor]);

  function navigate(direction: -1 | 1) {
    if (view === 'day') setCursor(addDays(cursor, direction));
    else if (view === 'week') setCursor(addDays(cursor, direction * 7));
    else setCursor(addMonths(cursor, direction));
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-10">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-xs uppercase tracking-widest text-rose-500">
            <CalendarIcon className="h-3.5 w-3.5" />
            Calendar
          </div>
          <h1 className="mt-1 text-3xl font-bold tracking-tight">{headerLabel}</h1>
        </div>
        <div className="flex items-center gap-2">
          <ViewSwitcher value={view} onChange={setView} />
          <div className="flex items-center gap-1">
            <button className="btn-ghost" onClick={() => navigate(-1)} aria-label="Previous">
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              className="btn-secondary text-xs"
              onClick={() => setCursor(startOfDay(new Date()))}
            >
              Today
            </button>
            <button className="btn-ghost" onClick={() => navigate(1)} aria-label="Next">
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
        <div>
          {view === 'month' && (
            <MonthGrid
              cursor={cursor}
              byDay={byDay}
              onSelect={(d) => {
                setCursor(d);
                setView('day');
              }}
            />
          )}
          {view === 'week' && (
            <WeekGrid cursor={cursor} byDay={byDay} onDismiss={(id) => dismiss.mutate(id)} />
          )}
          {view === 'day' && (
            <DayView
              date={cursor}
              events={byDay.get(startOfDay(cursor).toISOString()) ?? []}
              onDismiss={(id) => dismiss.mutate(id)}
            />
          )}
        </div>

        <aside className="space-y-3">
          {/* Plan 11 — geocoded events on a small inset map. Shows
              up to 12 next pins; hidden when none of the upcoming
              events have coordinates (Settings → Maps off, or
              every location string failed to geocode). */}
          {(() => {
            const pins: MapPin[] = (upcoming?.events ?? [])
              .filter(
                (e) => e.geocoded?.lat != null && e.geocoded?.lon != null,
              )
              .slice(0, 12)
              .map((e) => ({
                lat: e.geocoded!.lat as number,
                lon: e.geocoded!.lon as number,
                label: e.title,
                href: e.pageSlug ? `/p/${e.pageSlug}` : `/e/${e.sourceEmailId}`,
              }));
            return pins.length > 0 ? (
              <div className="card">
                <h3 className="mb-3 text-xs font-semibold uppercase tracking-widest text-ink-500">
                  Where
                </h3>
                <MapInset
                  pins={pins}
                  height="200px"
                  className="overflow-hidden rounded-md border border-ink-200 dark:border-ink-800"
                />
              </div>
            ) : null;
          })()}
          <div className="card">
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-widest text-ink-500">
              Upcoming
            </h3>
            {(upcoming?.events?.length ?? 0) === 0 ? (
              <p className="text-xs text-ink-500">
                No upcoming events. As emails arrive that mention concrete
                dates and times, they'll appear here.
              </p>
            ) : (
              <ul className="space-y-2 text-sm">
                {upcoming!.events.map((e) => (
                  <li
                    key={e._id}
                    className="rounded-lg border border-ink-200 p-2 dark:border-ink-800"
                  >
                    <EventBody e={e} compact />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

function ViewSwitcher({
  value,
  onChange,
}: {
  value: ViewMode;
  onChange: (m: ViewMode) => void;
}) {
  const options: { v: ViewMode; label: string }[] = [
    { v: 'day', label: 'Day' },
    { v: 'week', label: 'Week' },
    { v: 'month', label: 'Month' },
  ];
  return (
    <div className="flex overflow-hidden rounded-lg border border-ink-200 text-xs dark:border-ink-800">
      {options.map((o) => (
        <button
          key={o.v}
          onClick={() => onChange(o.v)}
          className={
            'px-3 py-1.5 transition-colors ' +
            (value === o.v
              ? 'bg-rose-500 text-white'
              : 'text-ink-700 hover:bg-ink-100 dark:text-ink-200 dark:hover:bg-ink-800')
          }
          aria-pressed={value === o.v}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function MonthGrid({
  cursor,
  byDay,
  onSelect,
}: {
  cursor: Date;
  byDay: Map<string, CalendarEventDoc[]>;
  onSelect: (d: Date) => void;
}) {
  const today = startOfDay(new Date());
  const monthStart = startOfMonth(cursor);
  const gridStart = addDays(monthStart, -monthStart.getDay());
  const days: Date[] = [];
  for (let i = 0; i < 42; i++) days.push(addDays(gridStart, i));
  return (
    <>
      <div className="grid grid-cols-7 border-b border-ink-200 pb-1 text-[10px] font-medium uppercase tracking-widest text-ink-500 dark:border-ink-800">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
          <div key={d} className="px-2">
            {d}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7 overflow-hidden rounded-xl border border-ink-200 dark:border-ink-800">
        {days.map((d) => {
          const inMonth = d.getMonth() === cursor.getMonth();
          const isToday = sameDay(d, today);
          const evs = byDay.get(startOfDay(d).toISOString()) ?? [];
          return (
            <button
              key={d.toISOString()}
              onClick={() => onSelect(d)}
              className={
                'group flex min-h-[88px] flex-col items-stretch gap-1 border-b border-r border-ink-200 p-1 text-left transition-colors last:border-r-0 dark:border-ink-800 ' +
                (inMonth ? 'bg-white dark:bg-ink-900' : 'bg-ink-50 dark:bg-ink-950/40') +
                ' hover:bg-rose-50/40 dark:hover:bg-rose-950/10'
              }
            >
              <div className="flex items-center justify-between text-xs">
                <span
                  className={
                    isToday
                      ? 'inline-flex h-5 w-5 items-center justify-center rounded-full bg-rose-500 text-[10px] font-semibold text-white'
                      : inMonth
                        ? 'text-ink-700 dark:text-ink-200'
                        : 'text-ink-400'
                  }
                >
                  {d.getDate()}
                </span>
                {evs.length > 0 && (
                  <span className="rounded-full bg-rose-100 px-1.5 text-[10px] font-medium text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
                    {evs.length}
                  </span>
                )}
              </div>
              {evs.slice(0, 2).map((e) => (
                <span
                  key={e._id}
                  className="truncate rounded bg-rose-100/70 px-1 py-0.5 text-[10px] text-rose-900 dark:bg-rose-950/40 dark:text-rose-200"
                  title={e.title}
                >
                  {!e.allDay && (
                    <span className="mr-1 text-rose-500">
                      {fmtTime(new Date(e.start))}
                    </span>
                  )}
                  {e.title}
                </span>
              ))}
              {evs.length > 2 && (
                <span className="text-[10px] text-ink-500">+{evs.length - 2} more</span>
              )}
            </button>
          );
        })}
      </div>
    </>
  );
}

function WeekGrid({
  cursor,
  byDay,
  onDismiss,
}: {
  cursor: Date;
  byDay: Map<string, CalendarEventDoc[]>;
  onDismiss: (id: string) => void;
}) {
  const today = startOfDay(new Date());
  const ws = startOfWeek(cursor);
  const days: Date[] = [];
  for (let i = 0; i < 7; i++) days.push(addDays(ws, i));
  return (
    <div className="overflow-hidden rounded-xl border border-ink-200 dark:border-ink-800">
      <div className="grid grid-cols-7 divide-x divide-ink-200 dark:divide-ink-800">
        {days.map((d) => {
          const evs = byDay.get(startOfDay(d).toISOString()) ?? [];
          const isToday = sameDay(d, today);
          return (
            <div
              key={d.toISOString()}
              className={
                'flex min-h-[420px] flex-col bg-white dark:bg-ink-900 ' +
                (isToday ? 'ring-2 ring-rose-500 ring-inset' : '')
              }
            >
              <div className="border-b border-ink-200 px-2 py-1.5 text-center text-[10px] font-medium uppercase tracking-widest text-ink-500 dark:border-ink-800">
                <div>{d.toLocaleDateString(undefined, { weekday: 'short' })}</div>
                <div
                  className={
                    'mt-0.5 text-base font-bold ' +
                    (isToday ? 'text-rose-600 dark:text-rose-300' : 'text-ink-900 dark:text-ink-100')
                  }
                >
                  {d.getDate()}
                </div>
              </div>
              <div className="flex flex-1 flex-col gap-2 p-2">
                {evs.length === 0 ? (
                  <span className="text-[10px] italic text-ink-400">—</span>
                ) : (
                  evs.map((e) => (
                    <div
                      key={e._id}
                      className="group rounded-md border border-rose-200 bg-rose-50 p-1.5 text-[11px] text-rose-900 dark:border-rose-900/60 dark:bg-rose-950/30 dark:text-rose-100"
                    >
                      <div className="flex items-start justify-between gap-1">
                        <span className="font-semibold">
                          {e.allDay ? 'All day' : fmtTime(new Date(e.start))}
                        </span>
                        <button
                          className="opacity-0 transition-opacity hover:text-ink-900 group-hover:opacity-100 dark:hover:text-ink-100"
                          onClick={() => onDismiss(e._id)}
                          aria-label="Hide"
                          title="Hide"
                        >
                          <EyeOff className="h-3 w-3" />
                        </button>
                      </div>
                      <div className="mt-0.5 line-clamp-2 font-medium leading-tight">
                        {e.title}
                      </div>
                      {(e.sourceFromName || e.sourceFromAddress) && (
                        <div className="mt-0.5 truncate text-[10px] uppercase tracking-wider text-rose-700/70 dark:text-rose-200/70">
                          via {e.sourceFromName || e.sourceFromAddress}
                        </div>
                      )}
                      {e.pageSlug && (
                        <Link
                          to={`/p/${e.pageSlug}`}
                          className="mt-1 inline-flex items-center gap-0.5 text-[10px] font-medium underline hover:no-underline"
                        >
                          Open <ExternalLink className="h-2.5 w-2.5" />
                        </Link>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DayView({
  date,
  events,
  onDismiss,
}: {
  date: Date;
  events: CalendarEventDoc[];
  onDismiss: (id: string) => void;
}) {
  const isToday = sameDay(date, startOfDay(new Date()));
  return (
    <section className="card">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-ink-500">
            {isToday ? 'Today' : 'Date'}
          </div>
          <h3 className="text-lg font-semibold">
            {date.toLocaleDateString(undefined, {
              weekday: 'long',
              month: 'long',
              day: 'numeric',
              year: 'numeric',
            })}
          </h3>
        </div>
        <span className="rounded-full bg-rose-100 px-2 py-0.5 text-xs font-medium text-rose-800 dark:bg-rose-950/40 dark:text-rose-200">
          {events.length} {events.length === 1 ? 'event' : 'events'}
        </span>
      </div>
      {events.length === 0 ? (
        <p className="text-sm text-ink-500">
          Nothing scheduled. As event emails arrive, they'll show up here.
        </p>
      ) : (
        <ul className="space-y-3 text-sm">
          {events.map((e) => (
            <li
              key={e._id}
              className="flex items-start gap-3 rounded-lg border border-ink-200 p-3 dark:border-ink-800"
            >
              <div className="min-w-0 flex-1">
                <EventBody e={e} />
              </div>
              <button
                className="btn-ghost text-ink-500"
                onClick={() => onDismiss(e._id)}
                title="Hide this event"
                aria-label="Hide"
              >
                <EyeOff className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function EventBody({ e, compact }: { e: CalendarEventDoc; compact?: boolean }) {
  const start = new Date(e.start);
  const end = e.end ? new Date(e.end) : null;
  const sender = e.sourceFromName || e.sourceFromAddress;
  return (
    <>
      <div className="flex items-center gap-2">
        <span className="rounded-full bg-rose-500 px-1.5 py-0.5 text-[10px] font-semibold text-white">
          {e.allDay ? 'all day' : fmtTime(start) + (end ? `–${fmtTime(end)}` : '')}
        </span>
        {!compact && (
          <span className="text-xs text-ink-500">
            {start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
          </span>
        )}
      </div>
      <div className="mt-1 font-medium leading-snug">{e.title}</div>
      {sender && (
        <div className="mt-0.5 inline-flex items-center gap-1 text-[11px] uppercase tracking-widest text-ink-500">
          {e.sourceKind === 'rss' ? (
            <Rss className="h-3 w-3" />
          ) : (
            <AtSign className="h-3 w-3" />
          )}
          via {sender}
        </div>
      )}
      {e.location && (
        <div className="mt-0.5 inline-flex items-center gap-1 text-xs text-ink-500">
          <MapPinIcon className="h-3 w-3" />
          {e.location}
        </div>
      )}
      {e.description && !compact && (
        <p className="mt-1 text-xs text-ink-500">{e.description}</p>
      )}
      <div className="mt-2 flex flex-wrap gap-2 text-xs">
        {e.pageSlug && (
          <Link
            to={`/p/${e.pageSlug}`}
            className="inline-flex items-center gap-1 text-rose-600 hover:underline dark:text-rose-300"
          >
            Open wiki page <ExternalLink className="h-3 w-3" />
          </Link>
        )}
        <Link
          to={`/e/${e.sourceEmailId}`}
          className="inline-flex items-center gap-1 text-ink-500 hover:text-ink-900 dark:hover:text-ink-100"
        >
          Source email
        </Link>
      </div>
    </>
  );
}

function fmtTime(d: Date) {
  return d.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: d.getMinutes() === 0 ? undefined : '2-digit',
  });
}
