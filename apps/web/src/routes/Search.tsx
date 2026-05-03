import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Search as SearchIcon } from 'lucide-react';
import type { SearchResponse } from '@rose/shared';
import { useApi } from '../lib/api';

export default function SearchPage() {
  const api = useApi();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [mode, setMode] = useState<'hybrid' | 'text' | 'semantic'>('hybrid');
  const inputRef = useRef<HTMLInputElement>(null);

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
      </div>
      {data && (
        <div className="mb-6 text-xs text-ink-500">
          {data.hits.length} hits · {data.totalText} text · {data.totalSemantic} semantic ·{' '}
          {data.tookMs}ms
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
    </div>
  );
}
