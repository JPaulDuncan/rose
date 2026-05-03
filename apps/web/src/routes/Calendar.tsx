import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Calendar as CalendarIcon,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  MapPin,
  EyeOff,
  X,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useApi } from '../lib/api';

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
};

function startOfMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function endOfMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
}
function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function addDays(d: Date, n: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
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
  const [cursor, setCursor] = useState<Date>(startOfMonth(new Date()));
  const [selected, setSelected] = useState<Date | null>(null);

  // Fetch events covering the visible 6-week window plus a few days of bleed.
  const monthStart = startOfMonth(cursor);
  const monthEnd = endOfMonth(cursor);
  const gridStart = addDays(monthStart, -monthStart.getDay()); // Sunday
  const gridEnd = addDays(gridStart, 41); // 6 weeks − 1

  const { data } = useQuery({
    queryKey: ['events', gridStart.toISOString(), gridEnd.toISOString()],
    queryFn: () =>
      api.get<{ events: CalendarEventDoc[] }>(
        `/api/events?from=${gridStart.toISOString()}&to=${gridEnd.toISOString()}`,
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

  // Bucket events by day for fast grid lookup.
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

  const days: Date[] = [];
  for (let i = 0; i < 42; i++) days.push(addDays(gridStart, i));

  const today = startOfDay(new Date());

  const monthLabel = cursor.toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  });

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-10">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2 text-xs uppercase tracking-widest text-rose-500">
            <CalendarIcon className="h-3.5 w-3.5" />
            Calendar
          </div>
          <h1 className="mt-1 text-3xl font-bold tracking-tight">{monthLabel}</h1>
        </div>
        <div className="flex items-center gap-1">
          <button
            className="btn-ghost"
            onClick={() => setCursor(startOfMonth(addDays(monthStart, -1)))}
            aria-label="Previous month"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            className="btn-secondary text-xs"
            onClick={() => {
              const d = new Date();
              setCursor(startOfMonth(d));
              setSelected(startOfDay(d));
            }}
          >
            Today
          </button>
          <button
            className="btn-ghost"
            onClick={() => setCursor(startOfMonth(addDays(monthEnd, 1)))}
            aria-label="Next month"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
        <div>
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
              const isSelected = selected && sameDay(d, selected);
              const evs = byDay.get(startOfDay(d).toISOString()) ?? [];
              return (
                <button
                  key={d.toISOString()}
                  onClick={() => setSelected(d)}
                  className={
                    'group flex min-h-[88px] flex-col items-stretch gap-1 border-b border-r border-ink-200 p-1 text-left transition-colors last:border-r-0 dark:border-ink-800 ' +
                    (inMonth ? 'bg-white dark:bg-ink-900' : 'bg-ink-50 dark:bg-ink-950/40') +
                    (isSelected
                      ? ' ring-2 ring-rose-500 ring-inset'
                      : ' hover:bg-rose-50/40 dark:hover:bg-rose-950/10')
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

          {selected && (
            <DayPanel
              date={selected}
              events={byDay.get(startOfDay(selected).toISOString()) ?? []}
              onClose={() => setSelected(null)}
              onDismiss={(id) => dismiss.mutate(id)}
            />
          )}
        </div>

        <aside className="space-y-3">
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

function DayPanel({
  date,
  events,
  onClose,
  onDismiss,
}: {
  date: Date;
  events: CalendarEventDoc[];
  onClose: () => void;
  onDismiss: (id: string) => void;
}) {
  return (
    <section className="card mt-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold">
          {date.toLocaleDateString(undefined, {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
          })}
        </h3>
        <button className="btn-ghost" onClick={onClose} aria-label="Close">
          <X className="h-4 w-4" />
        </button>
      </div>
      {events.length === 0 ? (
        <p className="text-xs text-ink-500">No events on this day.</p>
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
  return (
    <>
      <div className="flex items-center gap-2">
        <span
          className={
            'rounded-full bg-rose-500 px-1.5 py-0.5 text-[10px] font-semibold text-white' +
            (compact ? '' : '')
          }
        >
          {e.allDay
            ? 'all day'
            : fmtTime(start) + (end ? `–${fmtTime(end)}` : '')}
        </span>
        {!compact && (
          <span className="text-xs text-ink-500">
            {start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
          </span>
        )}
      </div>
      <div className="mt-1 font-medium leading-snug">{e.title}</div>
      {e.location && (
        <div className="mt-0.5 inline-flex items-center gap-1 text-xs text-ink-500">
          <MapPin className="h-3 w-3" />
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
