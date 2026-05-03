import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  BookOpen,
  Bookmark,
  Users,
  ChevronRight,
  ScrollText,
} from 'lucide-react';
import { useApi } from '../lib/api';

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

type Codex = {
  chapters: Chapter[];
  orphans: Entry[];
  dramatisPersonae: Persona[];
  index: { slug: string; title: string }[];
  counts: { chapters: number; entries: number; orphans: number; personae: number };
};

export default function CodexPage() {
  const api = useApi();
  const { data, isLoading } = useQuery({
    queryKey: ['codex'],
    queryFn: () => api.get<Codex>('/api/codex'),
  });

  const [activeChapter, setActiveChapter] = useState<string | null>(null);
  const [view, setView] = useState<'chapter' | 'index' | 'personae'>('chapter');

  // Pick the largest chapter as the default focus once data lands.
  const effectiveChapter = useMemo(() => {
    if (activeChapter) return activeChapter;
    if (data?.chapters[0]) return data.chapters[0]._id;
    if (data && data.orphans.length > 0) return '__orphans';
    return null;
  }, [activeChapter, data]);

  if (isLoading) {
    return <div className="px-6 py-10 text-ink-500">Opening the codex…</div>;
  }
  if (!data || (data.counts.entries === 0 && data.counts.orphans === 0)) {
    return (
      <div className="mx-auto w-full max-w-6xl px-6 py-10">
        <div className="card flex flex-col items-center justify-center gap-3 py-16 text-center">
          <BookOpen className="h-10 w-10 text-rose-500" />
          <h2 className="font-serif text-2xl">The codex is unwritten</h2>
          <p className="max-w-md text-sm text-ink-500">
            Once Rose has ingested a few emails and feeds, this view becomes
            a structured book of every wiki entry, organised by chapter
            (category), with a cast of senders and a full alphabetical index.
          </p>
          <Link to="/inbox" className="btn-primary">
            Open inbox
          </Link>
        </div>
      </div>
    );
  }

  const chapterMap = new Map<string, Chapter>();
  for (const c of data.chapters) chapterMap.set(c._id, c);

  const focused: Chapter | { _id: '__orphans'; name: string; entries: Entry[] } | null =
    effectiveChapter === '__orphans'
      ? { _id: '__orphans', name: 'Uncatalogued', entries: data.orphans }
      : effectiveChapter
        ? chapterMap.get(effectiveChapter) ?? null
        : null;

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-10">
      <CodexHeader counts={data.counts} />

      <div className="mt-6 grid gap-6 lg:grid-cols-[220px_1fr_240px]">
        <aside className="space-y-4">
          <div>
            <div className="mb-2 text-[10px] uppercase tracking-[0.25em] text-ink-500">
              Contents
            </div>
            <ChapterRail
              chapters={data.chapters}
              orphans={data.orphans}
              activeId={effectiveChapter}
              onSelect={(id) => {
                setView('chapter');
                setActiveChapter(id);
              }}
            />
          </div>
          <div className="border-t border-ink-200 pt-3 dark:border-ink-800">
            <button
              type="button"
              onClick={() => setView('index')}
              className={
                'flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-sm font-medium ' +
                (view === 'index'
                  ? 'bg-rose-50 text-rose-800 dark:bg-rose-950/40 dark:text-rose-200'
                  : 'text-ink-700 hover:bg-ink-100 dark:text-ink-200 dark:hover:bg-ink-800')
              }
            >
              <span className="inline-flex items-center gap-2">
                <Bookmark className="h-4 w-4" /> Index
              </span>
              <span className="text-xs text-ink-400">{data.index.length}</span>
            </button>
            <button
              type="button"
              onClick={() => setView('personae')}
              className={
                'mt-1 flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-sm font-medium ' +
                (view === 'personae'
                  ? 'bg-rose-50 text-rose-800 dark:bg-rose-950/40 dark:text-rose-200'
                  : 'text-ink-700 hover:bg-ink-100 dark:text-ink-200 dark:hover:bg-ink-800')
              }
            >
              <span className="inline-flex items-center gap-2">
                <Users className="h-4 w-4" /> Personae
              </span>
              <span className="text-xs text-ink-400">{data.counts.personae}</span>
            </button>
          </div>
        </aside>

        <main className="min-w-0">
          {view === 'chapter' && focused && (
            <ChapterView chapter={focused} />
          )}
          {view === 'index' && <IndexView entries={data.index} />}
          {view === 'personae' && <PersonaeView personae={data.dramatisPersonae} />}
        </main>

        <aside className="space-y-4">
          <DramatisRail personae={data.dramatisPersonae.slice(0, 8)} />
        </aside>
      </div>
    </div>
  );
}

function CodexHeader({ counts }: { counts: Codex['counts'] }) {
  return (
    <header className="border-y-4 border-double border-ink-900 py-6 text-center dark:border-ink-100">
      <div className="text-[10px] uppercase tracking-[0.4em] text-ink-500">Codex</div>
      <h1 className="mt-1 font-serif text-5xl font-black tracking-tight">
        The Tome of Rose
      </h1>
      <p className="mt-2 text-xs uppercase tracking-widest text-ink-500">
        {counts.entries} {counts.entries === 1 ? 'entry' : 'entries'} ·{' '}
        {counts.chapters} {counts.chapters === 1 ? 'chapter' : 'chapters'} ·{' '}
        {counts.personae} dramatis personae
      </p>
    </header>
  );
}

function ChapterRail({
  chapters,
  orphans,
  activeId,
  onSelect,
}: {
  chapters: Chapter[];
  orphans: Entry[];
  activeId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <ul className="space-y-1 text-sm">
      {chapters.map((c, i) => (
        <li key={c._id}>
          <button
            type="button"
            onClick={() => onSelect(c._id)}
            className={
              'flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left ' +
              (activeId === c._id
                ? 'bg-rose-50 text-rose-800 dark:bg-rose-950/40 dark:text-rose-200'
                : 'text-ink-700 hover:bg-ink-100 dark:text-ink-200 dark:hover:bg-ink-800')
            }
          >
            <span className="flex items-center gap-2 truncate">
              <span className="w-5 text-right font-serif text-xs text-ink-400">
                {romanNumeral(i + 1)}
              </span>
              <span className="truncate font-medium">{c.name}</span>
            </span>
            <span className="text-xs text-ink-400">{c.entries.length}</span>
          </button>
        </li>
      ))}
      {orphans.length > 0 && (
        <li>
          <button
            type="button"
            onClick={() => onSelect('__orphans')}
            className={
              'flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left ' +
              (activeId === '__orphans'
                ? 'bg-rose-50 text-rose-800 dark:bg-rose-950/40 dark:text-rose-200'
                : 'text-ink-700 hover:bg-ink-100 dark:text-ink-200 dark:hover:bg-ink-800')
            }
          >
            <span className="flex items-center gap-2 truncate">
              <span className="w-5 text-right font-serif text-xs italic text-ink-400">
                ※
              </span>
              <span className="truncate italic">Uncatalogued</span>
            </span>
            <span className="text-xs text-ink-400">{orphans.length}</span>
          </button>
        </li>
      )}
    </ul>
  );
}

function ChapterView({
  chapter,
}: {
  chapter: Chapter | { _id: '__orphans'; name: string; entries: Entry[] };
}) {
  return (
    <section className="space-y-6">
      <div className="border-b-2 border-ink-900 pb-3 dark:border-ink-100">
        <div className="text-[10px] uppercase tracking-[0.25em] text-ink-500">
          Chapter
        </div>
        <h2 className="mt-0.5 font-serif text-4xl font-black leading-none tracking-tight">
          {chapter.name}
        </h2>
        <p className="mt-1 text-xs uppercase tracking-widest text-ink-500">
          {chapter.entries.length}{' '}
          {chapter.entries.length === 1 ? 'entry' : 'entries'}
        </p>
      </div>
      <ul className="divide-y divide-ink-200 dark:divide-ink-800">
        {chapter.entries.map((e, i) => (
          <li key={e._id} className="py-4">
            <EntryRow entry={e} number={i + 1} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function EntryRow({ entry, number }: { entry: Entry; number: number }) {
  return (
    <Link
      to={`/p/${entry.slug}`}
      className="grid gap-4 sm:grid-cols-[40px_1fr_120px]"
    >
      <div className="font-serif text-2xl font-bold leading-none text-ink-300 dark:text-ink-700">
        {String(number).padStart(2, '0')}
      </div>
      <div className="min-w-0">
        <h3 className="font-serif text-lg font-semibold leading-snug text-ink-900 hover:text-rose-700 dark:text-ink-100 dark:hover:text-rose-300">
          {entry.title}
        </h3>
        {entry.summary && (
          <p className="mt-1 text-sm leading-relaxed text-ink-600 line-clamp-2 dark:text-ink-300">
            {entry.summary}
          </p>
        )}
        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] uppercase tracking-widest text-ink-500">
          {entry.groupingMode === 'topic' && entry.primaryTopic && (
            <span>Topic · #{entry.primaryTopic}</span>
          )}
          {entry.senderAddresses[0] && <span>via {entry.senderAddresses[0]}</span>}
          <span>
            {entry.messageCount}{' '}
            {entry.messageCount === 1 ? 'message' : 'messages'}
          </span>
        </div>
        {entry.tags.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {entry.tags.slice(0, 4).map((t) => (
              <span
                key={t}
                className="rounded bg-ink-100 px-1.5 py-0.5 text-[10px] text-ink-600 dark:bg-ink-800 dark:text-ink-300"
              >
                #{t}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="hidden text-right text-[11px] uppercase tracking-widest text-ink-400 sm:block">
        {new Date(entry.updatedAt).toLocaleDateString(undefined, {
          month: 'short',
          day: 'numeric',
        })}
      </div>
    </Link>
  );
}

function IndexView({ entries }: { entries: { slug: string; title: string }[] }) {
  // Group alphabetically by first character (digits & punctuation collapse to "#").
  const groups = new Map<string, { slug: string; title: string }[]>();
  for (const e of entries) {
    const first = e.title.charAt(0).toUpperCase();
    const key = /^[A-Z]$/.test(first) ? first : '#';
    const arr = groups.get(key) ?? [];
    arr.push(e);
    groups.set(key, arr);
  }
  const ordered = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  return (
    <section>
      <div className="border-b-2 border-ink-900 pb-3 dark:border-ink-100">
        <div className="text-[10px] uppercase tracking-[0.25em] text-ink-500">
          Index
        </div>
        <h2 className="mt-0.5 font-serif text-4xl font-black leading-none tracking-tight">
          A — Z
        </h2>
      </div>
      <div className="mt-6 columns-1 gap-8 sm:columns-2">
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
    </section>
  );
}

function PersonaeView({ personae }: { personae: Persona[] }) {
  return (
    <section>
      <div className="border-b-2 border-ink-900 pb-3 dark:border-ink-100">
        <div className="text-[10px] uppercase tracking-[0.25em] text-ink-500">
          Dramatis Personae
        </div>
        <h2 className="mt-0.5 font-serif text-4xl font-black leading-none tracking-tight">
          The Cast
        </h2>
      </div>
      <ul className="mt-6 grid gap-4 sm:grid-cols-2">
        {personae.map((p) => (
          <li
            key={p.brandKey}
            className="flex gap-3 rounded-lg border border-ink-200 p-3 dark:border-ink-800"
          >
            <PersonaPortrait persona={p} />
            <div className="min-w-0 flex-1">
              <div className="font-serif text-base font-semibold">{p.name}</div>
              {p.domain && (
                <div className="text-xs text-ink-500">{p.domain}</div>
              )}
              <div className="mt-1 text-[10px] uppercase tracking-widest text-ink-400">
                {p.pageCount} entries · {p.emailCount} messages
              </div>
              {p.summary && (
                <p className="mt-2 line-clamp-3 text-xs leading-snug text-ink-600 dark:text-ink-300">
                  {p.summary}
                </p>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function DramatisRail({ personae }: { personae: Persona[] }) {
  if (personae.length === 0) return null;
  return (
    <div className="card">
      <div className="mb-3 flex items-center gap-2 text-xs uppercase tracking-widest text-ink-500">
        <ScrollText className="h-3.5 w-3.5" />
        Marginalia
      </div>
      <ul className="space-y-2 text-sm">
        {personae.map((p) => (
          <li key={p.brandKey} className="flex items-start gap-2">
            <PersonaPortrait persona={p} small />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{p.name}</div>
              <div className="text-[10px] uppercase tracking-widest text-ink-400">
                {p.pageCount} entries
              </div>
            </div>
            <ChevronRight className="h-3 w-3 text-ink-300" />
          </li>
        ))}
      </ul>
    </div>
  );
}

function PersonaPortrait({ persona, small }: { persona: Persona; small?: boolean }) {
  const cls = small ? 'h-8 w-8 text-xs' : 'h-12 w-12 text-base';
  if (persona.logoUrl) {
    return (
      <img
        src={persona.logoUrl}
        alt={persona.name}
        className={`${cls} shrink-0 rounded bg-white object-contain ring-1 ring-ink-200 dark:ring-ink-700`}
        onError={(e) => {
          (e.currentTarget as HTMLImageElement).style.display = 'none';
        }}
      />
    );
  }
  return (
    <span
      className={`${cls} inline-flex shrink-0 items-center justify-center rounded bg-rose-50 font-serif font-bold text-rose-700 ring-1 ring-rose-100 dark:bg-rose-950/40 dark:text-rose-200 dark:ring-rose-900/60`}
    >
      {persona.name.charAt(0).toUpperCase()}
    </span>
  );
}

function romanNumeral(n: number): string {
  // Cap at L; the rail rarely needs more than that.
  if (n <= 0) return '';
  const map: [number, string][] = [
    [50, 'L'],
    [40, 'XL'],
    [10, 'X'],
    [9, 'IX'],
    [5, 'V'],
    [4, 'IV'],
    [1, 'I'],
  ];
  let out = '';
  let r = n;
  for (const [v, s] of map) {
    while (r >= v) {
      out += s;
      r -= v;
    }
  }
  return out;
}
