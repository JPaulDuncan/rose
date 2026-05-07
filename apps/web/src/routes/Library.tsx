import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Search, BookOpen, ExternalLink, Settings as SettingsIcon } from 'lucide-react';
import { useApi } from '../lib/api';

type LibrarySource = {
  _id: string;
  kind: string;
  name: string;
  status: string;
  lastSyncAt: string | null;
  docCount: number;
};

type LibraryDoc = {
  _id: string;
  sourceId: string | null;
  url: string;
  title: string;
  author: string;
  publishedAt: string | null;
  summary: string;
  topics: string[];
  tags: string[];
  crawledAt: string | null;
};

type LibrarySettings = {
  enabled: boolean;
  dailyCrawlCap: number;
  useInDaydream: boolean;
};

/**
 * Standalone search-and-browse surface for the user's curated
 * Library. Different question than /search (which is archive-only):
 * this is "search the corpus I follow." Empty state nudges to
 * Settings → Library so the user knows where to add sources.
 */
export default function LibraryPage() {
  const api = useApi();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const tag = params.get('tag') ?? '';
  const [draft, setDraft] = useState(q);

  useEffect(() => setDraft(q), [q]);

  const { data: settings } = useQuery({
    queryKey: ['library-settings'],
    queryFn: () => api.get<LibrarySettings>('/api/library/settings'),
  });
  const { data: sources } = useQuery({
    queryKey: ['library-sources'],
    queryFn: () => api.get<{ sources: LibrarySource[] }>('/api/library/sources'),
    refetchInterval: 30_000,
  });
  const { data: docs, isLoading } = useQuery({
    queryKey: ['library-docs', q, tag],
    queryFn: () => {
      const url = q
        ? `/api/library?q=${encodeURIComponent(q)}${tag ? `&tag=${encodeURIComponent(tag)}` : ''}`
        : `/api/library${tag ? `?tag=${encodeURIComponent(tag)}` : ''}`;
      return api.get<{ mode: 'recent' | 'search'; documents: LibraryDoc[] }>(url);
    },
  });

  const sourceMap = new Map<string, LibrarySource>(
    (sources?.sources ?? []).map((s) => [s._id, s]),
  );
  const totalDocs = (sources?.sources ?? []).reduce((acc, s) => acc + s.docCount, 0);

  if (settings && !settings.enabled) {
    return (
      <div className="mx-auto w-full max-w-3xl px-6 py-10">
        <div className="card flex flex-col items-center gap-3 py-16 text-center">
          <BookOpen className="h-10 w-10 text-rose-500" />
          <div>
            <h2 className="font-semibold">Library is off</h2>
            <p className="mt-1 text-sm text-ink-500">
              Enable it in Settings → Library to start crawling RSS
              feeds and URLs you trust into a searchable corpus.
            </p>
          </div>
          <Link to="/settings/library" className="btn-primary">
            <SettingsIcon className="h-4 w-4" /> Open settings
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-8">
      <div className="mb-6 flex items-baseline justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Library</h1>
          <p className="text-xs text-ink-500">
            {totalDocs} documents · {sources?.sources.length ?? 0} sources
          </p>
        </div>
        <Link
          to="/settings/library"
          className="text-xs uppercase tracking-widest text-ink-500 hover:text-rose-600"
        >
          Manage sources →
        </Link>
      </div>

      <form
        className="mb-6 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const next = new URLSearchParams(params);
          if (draft.trim()) next.set('q', draft.trim());
          else next.delete('q');
          setParams(next);
        }}
      >
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
          <input
            className="input pl-9"
            placeholder="Search your library…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            autoFocus
          />
        </div>
        <button type="submit" className="btn-primary">
          Search
        </button>
        {(q || tag) && (
          <button
            type="button"
            className="btn-ghost"
            onClick={() => setParams(new URLSearchParams())}
          >
            Clear
          </button>
        )}
      </form>

      {tag && (
        <div className="mb-3 text-xs text-ink-500">
          Filtering by tag: <code>{tag}</code>{' '}
          <button
            type="button"
            className="text-rose-600 hover:underline"
            onClick={() => {
              const next = new URLSearchParams(params);
              next.delete('tag');
              setParams(next);
            }}
          >
            (clear)
          </button>
        </div>
      )}

      {isLoading ? (
        <div className="text-sm text-ink-500">Loading…</div>
      ) : (docs?.documents.length ?? 0) === 0 ? (
        <div className="card text-sm text-ink-500">
          {q
            ? 'No matches in your library.'
            : 'No documents yet — add a source in Settings → Library to start indexing.'}
        </div>
      ) : (
        <ul className="divide-y divide-ink-200 dark:divide-ink-800">
          {docs!.documents.map((d) => (
            <li key={d._id} className="py-3">
              <DocRow doc={d} source={d.sourceId ? sourceMap.get(d.sourceId) : undefined} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DocRow({ doc, source }: { doc: LibraryDoc; source?: LibrarySource }) {
  return (
    <article className="flex items-start gap-3">
      <div className="min-w-0 flex-1">
        <a
          href={doc.url}
          target="_blank"
          rel="noreferrer"
          className="group block"
        >
          <h2 className="font-serif text-lg font-semibold leading-snug group-hover:text-rose-700 dark:group-hover:text-rose-300">
            {doc.title || doc.url}
          </h2>
        </a>
        {doc.summary && (
          <p className="mt-1 text-sm text-ink-600 line-clamp-2 dark:text-ink-300">
            {doc.summary}
          </p>
        )}
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] uppercase tracking-widest text-ink-500">
          {source && <span>{source.name}</span>}
          {doc.author && <span>· {doc.author}</span>}
          {doc.publishedAt && (
            <span>· {new Date(doc.publishedAt).toLocaleDateString()}</span>
          )}
          {doc.tags.slice(0, 4).map((t) => (
            <Link
              key={t}
              to={`/library?tag=${encodeURIComponent(t)}`}
              className="hover:text-rose-600"
            >
              #{t}
            </Link>
          ))}
        </div>
      </div>
      <a
        href={doc.url}
        target="_blank"
        rel="noreferrer"
        className="btn-ghost shrink-0"
        aria-label="Open original"
      >
        <ExternalLink className="h-4 w-4" />
      </a>
    </article>
  );
}
