import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  ExternalLink,
  Mail as MailIcon,
} from 'lucide-react';
import { useApi } from '../lib/api';

type Stream = {
  _id: string;
  slug: string;
  title: string;
  summary: string;
  tags: string[];
  senderAddresses: string[];
  heroImageUrl: string | null;
  messageCount: number;
  updatedAt: string;
};
type TimelineEntry = {
  emailId: string;
  pageId: string;
  pageSlug: string;
  pageTitle: string;
  tag: string | null;
  subject: string;
  sender: string | null;
  date: string;
};
type StreamsResponse = { streams: Stream[]; timeline: TimelineEntry[] };

function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function dayLabel(d: Date) {
  const today = startOfDay(new Date());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const od = startOfDay(d);
  if (+od === +today) return 'Today';
  if (+od === +yesterday) return 'Yesterday';
  const weekAgo = new Date(today);
  weekAgo.setDate(weekAgo.getDate() - 6);
  if (od >= weekAgo) {
    return d.toLocaleDateString(undefined, { weekday: 'long' });
  }
  return d.toLocaleDateString(undefined, {
    month: 'long',
    day: 'numeric',
    year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric',
  });
}
function fmtTime(d: Date) {
  return d.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
}

const PAGE_COLORS = [
  'bg-rose-500',
  'bg-sky-500',
  'bg-emerald-500',
  'bg-amber-500',
  'bg-violet-500',
  'bg-fuchsia-500',
  'bg-teal-500',
  'bg-orange-500',
];
function colorForPage(pageId: string): string {
  let h = 0;
  for (let i = 0; i < pageId.length; i++) h = (h * 31 + pageId.charCodeAt(i)) | 0;
  return PAGE_COLORS[Math.abs(h) % PAGE_COLORS.length]!;
}

export default function StreamsPage() {
  const api = useApi();
  const { data, isLoading } = useQuery({
    queryKey: ['streams'],
    queryFn: () => api.get<StreamsResponse>('/api/streams?limit=300'),
    refetchInterval: 60_000,
  });

  const [active, setActive] = useState<Set<string> | null>(null);
  // null = all enabled; otherwise the explicit active set.

  const filtered = useMemo(() => {
    if (!data) return [];
    if (!active) return data.timeline;
    return data.timeline.filter((t) => active.has(t.pageId));
  }, [data, active]);

  const grouped = useMemo(() => {
    const m = new Map<string, TimelineEntry[]>();
    for (const t of filtered) {
      const key = startOfDay(new Date(t.date)).toISOString();
      const arr = m.get(key) ?? [];
      arr.push(t);
      m.set(key, arr);
    }
    return [...m.entries()].sort((a, b) => +new Date(b[0]) - +new Date(a[0]));
  }, [filtered]);

  if (isLoading || !data) {
    return <div className="px-6 py-10 text-ink-500">Loading streams…</div>;
  }

  if (data.streams.length === 0) {
    return (
      <div className="mx-auto w-full max-w-6xl px-6 py-10">
        <header className="mb-6 border-b border-ink-200 pb-4 dark:border-ink-800">
          <div className="flex items-center gap-2 text-xs uppercase tracking-widest text-rose-500">
            <Activity className="h-3.5 w-3.5" />
            Notification streams
          </div>
          <h1 className="mt-1 text-3xl font-bold tracking-tight">Streams</h1>
        </header>
        <div className="card text-center text-sm text-ink-500">
          No notification streams yet. As three-or-more emails of the same shape
          arrive (CI failures, receipts, daily digests, monitoring alerts), they
          collapse onto one wiki page and show up here as a chronological feed.
        </div>
      </div>
    );
  }

  function toggleStream(id: string) {
    setActive((prev) => {
      const cur = prev ?? new Set(data!.streams.map((s) => s._id));
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      // If everything is back on, drop to null sentinel.
      if (next.size === data!.streams.length) return null;
      return next;
    });
  }
  function isOn(id: string) {
    return active === null ? true : active.has(id);
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-10">
      <header className="mb-6 border-b border-ink-200 pb-4 dark:border-ink-800">
        <div className="flex items-center gap-2 text-xs uppercase tracking-widest text-rose-500">
          <Activity className="h-3.5 w-3.5" />
          Notification streams
        </div>
        <h1 className="mt-1 text-3xl font-bold tracking-tight">Streams</h1>
        <p className="mt-1 text-sm text-ink-500">
          {data.streams.length} active stream{data.streams.length === 1 ? '' : 's'} ·{' '}
          {data.timeline.length} message{data.timeline.length === 1 ? '' : 's'} in this
          window.
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[1fr_260px]">
        <div className="min-w-0">
          {grouped.length === 0 ? (
            <div className="card text-sm text-ink-500">No messages match the current filter.</div>
          ) : (
            <ol className="relative space-y-8">
              {/* Vertical rail */}
              <div
                className="pointer-events-none absolute left-[7px] top-1 bottom-0 w-px bg-ink-200 dark:bg-ink-800"
                aria-hidden
              />
              {grouped.map(([dayKey, items]) => (
                <li key={dayKey} className="relative pl-8">
                  <div className="absolute -left-1 top-0 z-10 flex h-4 items-center">
                    <span className="rounded-full bg-ink-900 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-white dark:bg-ink-100 dark:text-ink-950">
                      {dayLabel(new Date(dayKey))}
                    </span>
                  </div>
                  <ul className="mt-6 space-y-3">
                    {items.map((t) => (
                      <TimelineRow key={t.emailId + t.date} entry={t} />
                    ))}
                  </ul>
                </li>
              ))}
            </ol>
          )}
        </div>

        <aside className="space-y-3">
          <div className="card">
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-widest text-ink-500">
              Filter streams
            </h3>
            <ul className="space-y-1.5 text-sm">
              {data.streams.map((s) => {
                const on = isOn(s._id);
                return (
                  <li key={s._id}>
                    <button
                      type="button"
                      onClick={() => toggleStream(s._id)}
                      className={
                        'flex w-full items-center gap-2 rounded-lg border px-2 py-1.5 text-left transition-colors ' +
                        (on
                          ? 'border-ink-200 bg-white dark:border-ink-700 dark:bg-ink-900'
                          : 'border-dashed border-ink-200 bg-ink-50 opacity-50 dark:border-ink-800 dark:bg-ink-950/50')
                      }
                      title={on ? 'Click to hide' : 'Click to show'}
                    >
                      <span
                        className={`h-2.5 w-2.5 shrink-0 rounded-full ${colorForPage(s._id)}`}
                      />
                      <span className="min-w-0 flex-1 truncate text-xs">{s.title}</span>
                      <span className="shrink-0 text-[10px] text-ink-500">
                        {s.messageCount}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {active && (
              <button
                type="button"
                onClick={() => setActive(null)}
                className="mt-3 w-full rounded-lg border border-ink-200 px-2 py-1 text-[11px] text-ink-500 hover:bg-ink-100 dark:border-ink-700 dark:hover:bg-ink-800"
              >
                Show all
              </button>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

function TimelineRow({ entry }: { entry: TimelineEntry }) {
  const dot = colorForPage(entry.pageId);
  const t = new Date(entry.date);
  return (
    <li className="relative">
      <span
        className={`absolute -left-[29px] top-2 z-10 h-3 w-3 rounded-full border-2 border-white ${dot} dark:border-ink-950`}
        aria-hidden
      />
      <div className="rounded-lg border border-ink-200 bg-white p-3 dark:border-ink-800 dark:bg-ink-900">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-ink-500">
              <span className="font-mono tabular-nums">{fmtTime(t)}</span>
              <Link
                to={`/p/${entry.pageSlug}`}
                className="font-medium text-ink-900 hover:text-rose-700 dark:text-ink-50 dark:hover:text-rose-300"
              >
                {entry.pageTitle}
              </Link>
              {entry.tag && (
                <Link
                  to={`/t/${encodeURIComponent(entry.tag)}`}
                  className="rounded bg-ink-100 px-1.5 py-0.5 text-[10px] hover:bg-rose-100 hover:text-rose-800 dark:bg-ink-800 dark:hover:bg-rose-950/40 dark:hover:text-rose-300"
                >
                  #{entry.tag}
                </Link>
              )}
            </div>
            <div className="mt-1 truncate text-sm font-medium">
              {entry.subject || '(no subject)'}
            </div>
            {entry.sender && (
              <div className="mt-0.5 flex items-center gap-1 text-xs text-ink-500">
                <MailIcon className="h-3 w-3" />
                {entry.sender}
              </div>
            )}
          </div>
          <Link
            to={`/e/${entry.emailId}`}
            className="btn-ghost shrink-0 text-xs"
            title="Open original email"
          >
            <ExternalLink className="h-3 w-3" />
          </Link>
        </div>
      </div>
    </li>
  );
}
