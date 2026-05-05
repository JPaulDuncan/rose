import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bookmark, BookOpen, ExternalLink, Search as SearchIcon } from 'lucide-react';
import toast from 'react-hot-toast';
import type { SearchResponse } from '@rose/shared';
import { useApi } from '../lib/api';

type LibraryHit = {
  _id: string;
  url: string;
  title: string;
  author?: string;
  publishedAt?: string | null;
  summary?: string;
  topics?: string[];
  tags?: string[];
};

type LibrarySearchResponse = {
  mode: 'recent' | 'search';
  documents: LibraryHit[];
};

const LIBRARY_PREF_KEY = 'rose.search.includeLibrary';

export default function SearchPage() {
  const api = useApi();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [mode, setMode] = useState<'hybrid' | 'text' | 'semantic'>('hybrid');
  // Read the user's last preference so the toggle survives reloads.
  // Library search is only meaningful when the user has the Library
  // enabled, but the toggle's harmless when off — the API just
  // returns no documents for users who haven't ingested any.
  const [includeLibrary, setIncludeLibrary] = useState<boolean>(() => {
    try {
      return localStorage.getItem(LIBRARY_PREF_KEY) === '1';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(LIBRARY_PREF_KEY, includeLibrary ? '1' : '0');
    } catch {
      /* localStorage unavailable in private browsing — non-fatal. */
    }
  }, [includeLibrary]);
  const inputRef = useRef<HTMLInputElement>(null);

  const saveSearch = useMutation({
    mutationFn: async () => {
      const name = window.prompt('Save this search as:', debounced.slice(0, 40)) ?? '';
      if (!name.trim()) throw new Error('cancelled');
      return api.post<{ id: string; name: string }>('/api/me/saved-searches', {
        name: name.trim(),
        query: debounced,
        pinned: true,
      });
    },
    onSuccess: (r) => {
      toast.success(`Saved "${r.name}" to your sidebar`);
      qc.invalidateQueries({ queryKey: ['saved-searches'] });
    },
    onError: (e: Error) => {
      if (e.message !== 'cancelled') toast.error(e.message);
    },
  });

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 200);
    return () => clearTimeout(t);
  }, [q]);

  const { data, isFetching } = useQuery({
    queryKey: ['search', debounced, mode],
    queryFn: () =>
      api.get<SearchResponse>(`/api/search?q=${encodeURIComponent(debounced)}&mode=${mode}`),
    enabled: debounced.length >= 2,
  });

  // Library search runs in parallel only when the user has opted in.
  // Disabled-by-default — the trust boundary plan 10 called out:
  // pages are first-party content, library docs come from outside.
  const { data: libraryData, isFetching: libraryFetching } = useQuery({
    queryKey: ['search-library', debounced],
    queryFn: () =>
      api.get<LibrarySearchResponse>(
        `/api/library?q=${encodeURIComponent(debounced)}&limit=15`,
      ),
    enabled: debounced.length >= 2 && includeLibrary,
  });

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-10">
      <div className="mb-2 flex items-center gap-2 rounded-xl border border-ink-200 bg-white px-3 py-2 shadow-soft focus-within:border-rose-500 dark:border-ink-700 dark:bg-ink-900">
        <SearchIcon className="h-4 w-4 text-ink-400" />
        <input
          ref={inputRef}
          className="flex-1 bg-transparent text-base outline-none"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search pages by keyword or meaning…"
        />
        <select
          value={mode}
          onChange={(e) => setMode(e.target.value as typeof mode)}
          className="bg-transparent text-xs text-ink-500"
        >
          <option value="hybrid">Hybrid</option>
          <option value="text">Keyword</option>
          <option value="semantic">Semantic</option>
        </select>
        <label
          className="flex shrink-0 cursor-pointer items-center gap-1 text-xs text-ink-500"
          title="Also search documents you've added to the Library."
        >
          <input
            type="checkbox"
            checked={includeLibrary}
            onChange={(e) => setIncludeLibrary(e.target.checked)}
            className="accent-rose-500"
          />
          <BookOpen className="h-3 w-3" />
          Library
        </label>
      </div>
      {data && (
        <div className="mb-6 flex items-center justify-between text-xs text-ink-500">
          <span>
            {data.hits.length} hits · {data.totalText} text · {data.totalSemantic} semantic
            · {data.tookMs}ms
          </span>
          {debounced.length >= 2 && (
            <button
              type="button"
              className="btn-ghost text-xs"
              onClick={() => saveSearch.mutate()}
              disabled={saveSearch.isPending}
              title="Pin this search to the sidebar"
            >
              <Bookmark className="h-3.5 w-3.5" /> Save search
            </button>
          )}
        </div>
      )}

      {!debounced && <div className="text-ink-500">Type at least 2 characters.</div>}
      {isFetching && <div className="text-ink-500">Searching…</div>}
      {data && (
        <ul className="space-y-3">
          {data.hits.map((h) => (
            <li key={h.pageId}>
              <Link to={`/p/${h.slug}`} className="card block hover:border-rose-300">
                <div className="flex items-start justify-between gap-3">
                  <div className="font-medium">{h.title}</div>
                  <div className="flex gap-1">
                    {h.matchedBy.map((m) => (
                      <span key={m} className="pill text-[10px]">
                        {m}
                      </span>
                    ))}
                  </div>
                </div>
                <p className="mt-1 line-clamp-2 text-sm text-ink-500">{h.summary}</p>
                {h.snippet && (
                  <p className="mt-1 text-xs text-ink-400 italic">…{h.snippet}…</p>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}

      {includeLibrary && debounced.length >= 2 && (
        <section className="mt-8">
          <div className="mb-3 flex items-center gap-2 border-t border-ink-200 pt-4 text-xs uppercase tracking-widest text-ink-500 dark:border-ink-800">
            <BookOpen className="h-3.5 w-3.5" />
            From your Library
            {libraryFetching && <span className="text-ink-400">· searching…</span>}
            {libraryData && (
              <span className="text-ink-400">
                · {libraryData.documents.length} hit
                {libraryData.documents.length === 1 ? '' : 's'}
              </span>
            )}
          </div>
          {libraryData && libraryData.documents.length === 0 && !libraryFetching && (
            <p className="text-xs italic text-ink-500">
              No library matches. Add sources in{' '}
              <Link
                to="/settings/library"
                className="text-rose-600 hover:underline dark:text-rose-300"
              >
                Settings → Library
              </Link>{' '}
              to grow the corpus.
            </p>
          )}
          {libraryData && libraryData.documents.length > 0 && (
            <ul className="space-y-3">
              {libraryData.documents.map((d) => (
                <li key={d._id}>
                  <a
                    href={d.url}
                    target="_blank"
                    rel="noreferrer"
                    className="card block hover:border-rose-300"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="font-medium">{d.title || d.url}</div>
                      <ExternalLink className="h-3.5 w-3.5 shrink-0 text-ink-400" />
                    </div>
                    {d.summary && (
                      <p className="mt-1 line-clamp-2 text-sm text-ink-500">
                        {d.summary}
                      </p>
                    )}
                    <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] uppercase tracking-widest text-ink-500">
                      {d.author && <span>{d.author}</span>}
                      {d.publishedAt && (
                        <span>· {new Date(d.publishedAt).toLocaleDateString()}</span>
                      )}
                      {(d.tags ?? []).slice(0, 3).map((t) => (
                        <span key={t}>· #{t}</span>
                      ))}
                    </div>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
