import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BookOpen,
  Bookmark,
  Users,
  Activity,
  Star,
  Plus,
  X,
  ChevronRight,
  ExternalLink,
  Mail as MailIcon,
  Sparkles,
  Wand2,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useApi } from '../lib/api';
import { SynthesizeDrawer } from '../components/SynthesizeDrawer';

type Entry = {
  _id: string;
  slug: string;
  title: string;
  summary: string;
  heroImageUrl: string | null;
  tags: string[];
  topics: string[];
  senderAddresses: string[];
  groupingMode: string;
  primaryTopic: string | null;
  messageCount: number;
  updatedAt: string;
  articleDate?: string | null;
};
type Chapter = {
  _id: string;
  name: string;
  parentId: string | null;
  icon: string | null;
  color: string | null;
  entries: Entry[];
};
type Persona = {
  brandKey: string;
  name: string;
  domain: string | null;
  logoUrl: string | null;
  pageCount: number;
  emailCount: number;
  summary: string;
};
type CodexResponse = {
  chapters: Chapter[];
  orphans: Entry[];
  dramatisPersonae: Persona[];
  index: { slug: string; title: string }[];
  counts: { chapters: number; entries: number; orphans: number; personae: number };
};
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
  articleDate?: string | null;
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

type TabKey = 'pinned' | 'categories' | 'senders' | 'index' | 'streams';
const TABS: { key: TabKey; label: string; icon: typeof BookOpen }[] = [
  { key: 'pinned', label: 'Pinned', icon: Star },
  { key: 'categories', label: 'Categories', icon: BookOpen },
  { key: 'senders', label: 'Senders', icon: Users },
  { key: 'index', label: 'Index', icon: Bookmark },
  { key: 'streams', label: 'Streams', icon: Activity },
];

/**
 * One unified browse surface. Replaces three older entry points:
 *   - /codex (chapters + index + dramatis personae)
 *   - /streams (notification timeline)
 *   - the Featured-Topics widget on the Home edition
 *
 * Tab is persisted in `?tab=…` so links and bookmarks land on the right view.
 */
export default function BrowsePage() {
  const [params, setParams] = useSearchParams();
  const tabParam = params.get('tab') as TabKey | null;
  const tab: TabKey = TABS.some((t) => t.key === tabParam) ? (tabParam as TabKey) : 'categories';

  function setTab(next: TabKey) {
    const q = new URLSearchParams(params);
    q.set('tab', next);
    setParams(q, { replace: true });
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-8">
      <header className="mb-6 border-b border-ink-200 pb-4 dark:border-ink-800">
        <h1 className="text-3xl font-bold tracking-tight">Browse</h1>
        <p className="mt-1 text-sm text-ink-500">
          One surface for pinned topics, categories, senders, the A–Z index, and
          your notification timeline.
        </p>
        <nav className="mt-4 flex flex-wrap gap-1" aria-label="Browse views">
          {TABS.map(({ key, label, icon: Icon }) => {
            const active = tab === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                className={
                  'inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ' +
                  (active
                    ? 'bg-rose-50 text-rose-800 dark:bg-rose-950/40 dark:text-rose-200'
                    : 'text-ink-600 hover:bg-ink-100 dark:text-ink-300 dark:hover:bg-ink-800')
                }
              >
                <Icon className="h-4 w-4" />
                {label}
              </button>
            );
          })}
        </nav>
      </header>

      {tab === 'pinned' && <PinnedTab />}
      {tab === 'categories' && <CategoriesTab />}
      {tab === 'senders' && <SendersTab />}
      {tab === 'index' && <IndexTab />}
      {tab === 'streams' && <StreamsTab />}
    </div>
  );
}

/* ---------------- Pinned -------------------------------------------------- */

function PinnedTab() {
  const api = useApi();
  const qc = useQueryClient();
  const { data: featured } = useQuery({
    queryKey: ['featured-tags'],
    queryFn: () => api.get<{ tags: string[] }>('/api/featured-tags'),
  });
  const { data: directory } = useQuery({
    queryKey: ['tag-directory'],
    queryFn: () => api.get<{ tags: { tag: string; pageCount: number }[] }>('/api/tags'),
  });
  const { data: codex } = useQuery({
    queryKey: ['codex'],
    queryFn: () => api.get<CodexResponse>('/api/codex'),
  });

  const [input, setInput] = useState('');
  const tags = featured?.tags ?? [];

  const add = useMutation({
    mutationFn: async (tag: string) =>
      api.post<{ tags: string[] }>('/api/featured-tags', { tag }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['featured-tags'] });
      qc.invalidateQueries({ queryKey: ['digest'] });
      setInput('');
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: async (tag: string) =>
      api.del<{ tags: string[] }>(`/api/featured-tags/${encodeURIComponent(tag)}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['featured-tags'] });
      qc.invalidateQueries({ queryKey: ['digest'] });
    },
  });

  // Group every page by tag so each pinned section shows recent items.
  const pagesByTag = useMemo(() => {
    const m = new Map<string, Entry[]>();
    const all: Entry[] = [
      ...(codex?.chapters.flatMap((c) => c.entries) ?? []),
      ...(codex?.orphans ?? []),
    ];
    for (const e of all) {
      for (const t of [...e.tags, ...e.topics]) {
        const arr = m.get(t) ?? [];
        arr.push(e);
        m.set(t, arr);
      }
    }
    for (const [, arr] of m) {
      arr.sort(
        (a, b) =>
          +new Date(b.articleDate ?? b.updatedAt) -
          +new Date(a.articleDate ?? a.updatedAt),
      );
    }
    return m;
  }, [codex]);

  const suggestions =
    directory?.tags?.filter((d) => !tags.includes(d.tag))?.slice(0, 8) ?? [];

  return (
    <div className="space-y-6">
      <div className="card">
        <div className="mb-2 text-xs uppercase tracking-widest text-ink-500">
          Pin a topic
        </div>
        <p className="mb-3 text-sm text-ink-500">
          Pinned topics anchor your home edition and appear here as their own
          sections. Pin three to five to start.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const v = input.trim().toLowerCase();
            if (!v) return;
            if (tags.includes(v)) {
              toast.error('Already pinned');
              return;
            }
            add.mutate(v);
          }}
          className="flex gap-2"
        >
          <input
            className="input flex-1"
            list="pinned-suggestions"
            placeholder="add a topic, e.g. github"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <datalist id="pinned-suggestions">
            {suggestions.map((s) => (
              <option key={s.tag} value={s.tag}>
                {s.pageCount} page{s.pageCount === 1 ? '' : 's'}
              </option>
            ))}
          </datalist>
          <button
            className="btn-primary"
            type="submit"
            disabled={add.isPending || !input.trim()}
          >
            <Plus className="h-4 w-4" /> Pin
          </button>
        </form>
        {tags.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {tags.map((t) => (
              <span
                key={t}
                className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2 py-0.5 text-xs font-medium text-rose-800 dark:bg-rose-950/40 dark:text-rose-200"
              >
                #{t}
                <button
                  type="button"
                  onClick={() => remove.mutate(t)}
                  aria-label={`Unpin ${t}`}
                  className="-mr-1 ml-0.5 rounded-full p-0.5 hover:bg-rose-200 dark:hover:bg-rose-900/60"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      {tags.length === 0 ? (
        <div className="card text-center text-sm text-ink-500">
          No pinned topics yet. Pin a tag above to give it a permanent home.
        </div>
      ) : (
        <ul className="space-y-6">
          {tags.map((t) => {
            const pages = pagesByTag.get(t) ?? [];
            return (
              <li key={t}>
                <div className="mb-2 flex items-baseline justify-between gap-3">
                  <Link
                    to={`/t/${encodeURIComponent(t)}`}
                    className="font-serif text-2xl font-bold tracking-tight hover:text-rose-700 dark:hover:text-rose-300"
                  >
                    #{t}
                  </Link>
                  <span className="text-xs uppercase tracking-widest text-ink-500">
                    {pages.length} page{pages.length === 1 ? '' : 's'}
                  </span>
                </div>
                {pages.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-ink-200 px-3 py-4 text-sm text-ink-500 dark:border-ink-800">
                    No pages yet for #{t}.
                  </div>
                ) : (
                  <ul className="divide-y divide-ink-200 dark:divide-ink-800">
                    {pages.slice(0, 5).map((e) => (
                      <li key={e._id} className="py-3">
                        <EntryRow entry={e} />
                      </li>
                    ))}
                    {pages.length > 5 && (
                      <li className="pt-2">
                        <Link
                          to={`/t/${encodeURIComponent(t)}`}
                          className="text-xs uppercase tracking-widest text-rose-600 hover:underline"
                        >
                          See all {pages.length} →
                        </Link>
                      </li>
                    )}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* ---------------- Categories --------------------------------------------- */

function CategoriesTab() {
  const api = useApi();
  const { data, isLoading } = useQuery({
    queryKey: ['codex'],
    queryFn: () => api.get<CodexResponse>('/api/codex'),
  });
  const [activeId, setActiveId] = useState<string | null>(null);

  const focused = useMemo(() => {
    if (!data) return null;
    if (activeId === '__orphans')
      return { _id: '__orphans', name: 'Uncategorized', entries: data.orphans };
    const id = activeId ?? data.chapters[0]?._id ?? null;
    if (!id) return null;
    return data.chapters.find((c) => c._id === id) ?? null;
  }, [data, activeId]);

  if (isLoading || !data) {
    return <div className="text-sm text-ink-500">Loading…</div>;
  }
  if (data.counts.entries === 0 && data.counts.orphans === 0) {
    return <EmptyHint label="No pages yet — once Rose ingests something, categories appear here." />;
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[220px_1fr]">
      <aside>
        <ul className="space-y-1 text-sm">
          {data.chapters.map((c) => (
            <li key={c._id}>
              <button
                type="button"
                onClick={() => setActiveId(c._id)}
                className={railButtonClass(focused?._id === c._id)}
              >
                <span className="truncate font-medium">{c.name}</span>
                <span className="text-xs text-ink-400">{c.entries.length}</span>
              </button>
            </li>
          ))}
          {data.orphans.length > 0 && (
            <li>
              <button
                type="button"
                onClick={() => setActiveId('__orphans')}
                className={railButtonClass(focused?._id === '__orphans')}
              >
                <span className="truncate italic">Uncategorized</span>
                <span className="text-xs text-ink-400">{data.orphans.length}</span>
              </button>
            </li>
          )}
        </ul>
      </aside>
      <main className="min-w-0">
        {focused ? <ChapterPanel chapter={focused} /> : null}
      </main>
    </div>
  );
}

function railButtonClass(active: boolean) {
  return (
    'flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left ' +
    (active
      ? 'bg-rose-50 text-rose-800 dark:bg-rose-950/40 dark:text-rose-200'
      : 'text-ink-700 hover:bg-ink-100 dark:text-ink-200 dark:hover:bg-ink-800')
  );
}

type RecategorizeOutcome = {
  pageId: string;
  title: string;
  oldCategory: string | null;
  newCategory: string | null;
  status: 'changed' | 'unchanged' | 'failed';
  reason?: string;
};

function ChapterPanel({
  chapter,
}: {
  chapter: { _id: string; name: string; entries: Entry[] };
}) {
  const api = useApi();
  const qc = useQueryClient();
  const [synthesizing, setSynthesizing] = useState(false);
  const synthesisIds = chapter.entries.slice(0, 8).map((e) => e._id);
  const isOrphans = chapter._id === '__orphans';

  // Recategorize burns LLM tokens — cap each batch at 50 so a runaway
  // category doesn't fan out to a giant request.
  const recategorize = useMutation({
    mutationFn: async (pageIds: string[]) =>
      api.post<{ outcomes: RecategorizeOutcome[] }>('/api/pages/recategorize', {
        pageIds: pageIds.slice(0, 50),
      }),
    onSuccess: (resp) => {
      const changed = resp.outcomes.filter((o) => o.status === 'changed').length;
      const failed = resp.outcomes.filter((o) => o.status === 'failed').length;
      if (changed === 0 && failed === 0) {
        toast.success('Reviewed — no changes needed.');
      } else if (failed === 0) {
        toast.success(
          `Moved ${changed} page${changed === 1 ? '' : 's'} to better-fitting categor${
            changed === 1 ? 'y' : 'ies'
          }.`,
        );
      } else {
        toast.success(
          `Moved ${changed}; ${failed} failed (see logs).`,
        );
      }
      qc.invalidateQueries({ queryKey: ['codex'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <section className="space-y-4">
      <div className="flex items-end justify-between gap-3 border-b border-ink-200 pb-3 dark:border-ink-800">
        <div>
          <div className="text-[10px] uppercase tracking-[0.25em] text-ink-500">
            Category
          </div>
          <h2 className="mt-0.5 font-serif text-3xl font-bold tracking-tight">
            {chapter.name}
          </h2>
          <p className="mt-1 text-xs uppercase tracking-widest text-ink-500">
            {chapter.entries.length}{' '}
            {chapter.entries.length === 1 ? 'page' : 'pages'}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {chapter.entries.length >= 1 && (
            <button
              type="button"
              className="btn-secondary text-xs"
              onClick={() => {
                const n = Math.min(50, chapter.entries.length);
                if (
                  confirm(
                    isOrphans
                      ? `Re-run categorization on ${n} uncategorized page${
                          n === 1 ? '' : 's'
                        }? This burns LLM tokens.`
                      : `Re-run categorization on ${n} page${n === 1 ? '' : 's'} in "${chapter.name}"? Pages may move into other categories. This burns LLM tokens.`,
                  )
                ) {
                  recategorize.mutate(chapter.entries.map((e) => e._id));
                }
              }}
              disabled={recategorize.isPending}
              title="Re-run category assignment using the current LLM and your existing taxonomy"
            >
              <Wand2 className={`h-3.5 w-3.5 ${recategorize.isPending ? 'animate-pulse' : ''}`} />
              {recategorize.isPending ? 'Recategorizing…' : 'Recategorize'}
            </button>
          )}
          {chapter.entries.length >= 2 && (
            <button
              type="button"
              className="btn-secondary text-xs"
              onClick={() => setSynthesizing(true)}
              title={`Combine the top ${Math.min(8, chapter.entries.length)} pages into a meta-page`}
            >
              <Sparkles className="h-3.5 w-3.5" /> Synthesize
            </button>
          )}
        </div>
      </div>
      <ul className="divide-y divide-ink-200 dark:divide-ink-800">
        {chapter.entries.map((e) => (
          <li key={e._id} className="py-3">
            <EntryRow entry={e} />
          </li>
        ))}
      </ul>
      {synthesizing && (
        <SynthesizeDrawer
          pageIds={synthesisIds}
          defaultTitle={`${chapter.name} — synthesis`}
          onClose={() => setSynthesizing(false)}
        />
      )}
    </section>
  );
}

function EntryRow({ entry }: { entry: Entry }) {
  return (
    <Link to={`/p/${entry.slug}`} className="block">
      <h3 className="font-serif text-lg font-semibold leading-snug hover:text-rose-700 dark:hover:text-rose-300">
        {entry.title}
      </h3>
      {entry.summary && (
        <p className="mt-1 text-sm leading-relaxed text-ink-600 line-clamp-2 dark:text-ink-300">
          {entry.summary}
        </p>
      )}
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] uppercase tracking-widest text-ink-500">
        {entry.senderAddresses[0] && <span>via {entry.senderAddresses[0]}</span>}
        <span>
          {entry.messageCount} {entry.messageCount === 1 ? 'message' : 'messages'}
        </span>
        <span>
          {new Date(entry.articleDate ?? entry.updatedAt).toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric',
          })}
        </span>
      </div>
    </Link>
  );
}

/* ---------------- Senders ------------------------------------------------ */

function SendersTab() {
  const api = useApi();
  const { data, isLoading } = useQuery({
    queryKey: ['codex'],
    queryFn: () => api.get<CodexResponse>('/api/codex'),
  });
  if (isLoading || !data) {
    return <div className="text-sm text-ink-500">Loading…</div>;
  }
  if (data.dramatisPersonae.length === 0) {
    return <EmptyHint label="No senders yet — once mail arrives, they appear here." />;
  }
  return (
    <ul className="grid gap-3 sm:grid-cols-2">
      {data.dramatisPersonae.map((p) => (
        <li key={p.brandKey}>
          <Link
            to={`/s/${encodeURIComponent(p.brandKey)}`}
            className="group flex gap-3 rounded-lg border border-ink-200 p-3 hover:border-rose-300 dark:border-ink-800 dark:hover:border-rose-800"
          >
            <SenderLogo persona={p} />
            <div className="min-w-0 flex-1">
              <div className="font-serif text-base font-semibold group-hover:text-rose-700 dark:group-hover:text-rose-300">
                {p.name}
              </div>
              {p.domain && <div className="text-xs text-ink-500">{p.domain}</div>}
              <div className="mt-1 text-[10px] uppercase tracking-widest text-ink-400">
                {p.pageCount} pages · {p.emailCount} messages
              </div>
              {p.summary && (
                <p className="mt-2 line-clamp-3 text-xs leading-snug text-ink-600 dark:text-ink-300">
                  {p.summary}
                </p>
              )}
            </div>
            <ChevronRight className="h-4 w-4 shrink-0 self-center text-ink-300 group-hover:text-rose-400" />
          </Link>
        </li>
      ))}
    </ul>
  );
}

function SenderLogo({ persona }: { persona: Persona }) {
  if (persona.logoUrl) {
    return (
      <img
        src={persona.logoUrl}
        alt={persona.name}
        className="h-12 w-12 shrink-0 rounded bg-white object-contain ring-1 ring-ink-200 dark:ring-ink-700"
        onError={(e) => {
          (e.currentTarget as HTMLImageElement).style.display = 'none';
        }}
      />
    );
  }
  return (
    <span className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded bg-rose-50 font-serif text-base font-bold text-rose-700 ring-1 ring-rose-100 dark:bg-rose-950/40 dark:text-rose-200 dark:ring-rose-900/60">
      {persona.name.charAt(0).toUpperCase()}
    </span>
  );
}

/* ---------------- Index -------------------------------------------------- */

function IndexTab() {
  const api = useApi();
  const { data, isLoading } = useQuery({
    queryKey: ['codex'],
    queryFn: () => api.get<CodexResponse>('/api/codex'),
  });
  if (isLoading || !data) {
    return <div className="text-sm text-ink-500">Loading…</div>;
  }
  if (data.index.length === 0) {
    return <EmptyHint label="No pages indexed yet." />;
  }
  const groups = new Map<string, { slug: string; title: string }[]>();
  for (const e of data.index) {
    const first = e.title.charAt(0).toUpperCase();
    const key = /^[A-Z]$/.test(first) ? first : '#';
    const arr = groups.get(key) ?? [];
    arr.push(e);
    groups.set(key, arr);
  }
  const ordered = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  return (
    <div className="columns-1 gap-8 sm:columns-2">
      {ordered.map(([letter, items]) => (
        <div key={letter} className="mb-6 break-inside-avoid">
          <div className="mb-1 border-b border-ink-300 pb-0.5 font-serif text-2xl font-bold dark:border-ink-700">
            {letter}
          </div>
          <ul className="space-y-1">
            {items.map((it) => (
              <li key={it.slug}>
                <Link
                  to={`/p/${it.slug}`}
                  className="block truncate text-sm text-ink-700 hover:text-rose-700 dark:text-ink-200 dark:hover:text-rose-300"
                >
                  {it.title}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/* ---------------- Streams ------------------------------------------------ */

function StreamsTab() {
  const api = useApi();
  const { data, isLoading } = useQuery({
    queryKey: ['streams'],
    queryFn: () => api.get<StreamsResponse>('/api/streams?limit=300'),
    refetchInterval: 60_000,
  });
  const [active, setActive] = useState<Set<string> | null>(null);

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
    return <div className="text-sm text-ink-500">Loading…</div>;
  }
  if (data.streams.length === 0) {
    return (
      <EmptyHint label="No notification streams yet. Once three or more emails of the same shape arrive (CI failures, receipts, daily digests, monitoring alerts), they collapse onto one page and show up here as a chronological feed." />
    );
  }

  function toggleStream(id: string) {
    setActive((prev) => {
      const cur = prev ?? new Set(data!.streams.map((s) => s._id));
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      if (next.size === data!.streams.length) return null;
      return next;
    });
  }
  function isOn(id: string) {
    return active === null ? true : active.has(id);
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_240px]">
      <div className="min-w-0">
        {grouped.length === 0 ? (
          <div className="card text-sm text-ink-500">
            No messages match the current filter.
          </div>
        ) : (
          <ol className="relative space-y-8">
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
      <aside>
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

function EmptyHint({ label }: { label: string }) {
  return <div className="card text-center text-sm text-ink-500">{label}</div>;
}
