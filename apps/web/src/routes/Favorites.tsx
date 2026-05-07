import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Star, Tag as TagIcon } from 'lucide-react';
import { useApi } from '../lib/api';

type FavPage = {
  _id: string;
  slug: string;
  title: string;
  summary: string;
  heroImageUrl: string | null;
  tags: string[];
  topics: string[];
  priority: 'high' | 'normal' | 'low';
  senderAddresses: string[];
  sourceEmailIds: string[];
  updatedAt: string;
};

export default function FavoritesPage() {
  const api = useApi();
  const { data, isLoading } = useQuery({
    queryKey: ['favorites'],
    queryFn: () => api.get<{ pages: FavPage[] }>('/api/me/favorites'),
  });

  if (isLoading) {
    return <div className="px-6 py-10 text-ink-500">Loading…</div>;
  }
  if (!data || data.pages.length === 0) {
    return (
      <div className="mx-auto w-full max-w-4xl px-6 py-10">
        <div className="card flex flex-col items-center gap-3 py-16 text-center">
          <Star className="h-10 w-10 text-rose-500" />
          <div>
            <h2 className="font-serif text-2xl">No favorites yet</h2>
            <p className="text-sm text-ink-500">
              Star any article from its header to pin it here.
            </p>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-10">
      <header className="mb-6 border-b-2 border-ink-900 pb-3 dark:border-ink-100">
        <div className="text-[10px] uppercase tracking-[0.25em] text-ink-500">
          Pinned
        </div>
        <h1 className="mt-0.5 font-serif text-4xl font-black tracking-tight">
          Favorites
        </h1>
        <p className="mt-2 text-sm text-ink-500">
          Pages you starred, newest first.
        </p>
      </header>
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {data.pages.map((p) => (
          <li
            key={p._id}
            className="overflow-hidden rounded-xl border border-ink-200 bg-white dark:border-ink-800 dark:bg-ink-900"
          >
            <Link to={`/p/${p.slug}`} className="group block">
              {p.heroImageUrl && (
                <img
                  src={p.heroImageUrl}
                  alt=""
                  className="aspect-[16/9] w-full object-cover"
                  onError={(e) => {
                    (e.currentTarget as HTMLImageElement).style.display = 'none';
                  }}
                />
              )}
              <div className="p-4">
                <h3 className="font-serif text-base font-semibold leading-snug group-hover:text-rose-700 dark:group-hover:text-rose-300">
                  {p.title}
                </h3>
                {p.summary && (
                  <p className="mt-1 line-clamp-3 text-xs leading-relaxed text-ink-600 dark:text-ink-300">
                    {p.summary}
                  </p>
                )}
                {p.tags.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {p.tags.slice(0, 3).map((t) => (
                      <span
                        key={t}
                        className="inline-flex items-center gap-0.5 rounded bg-ink-100 px-1.5 py-0.5 text-[10px] text-ink-600 dark:bg-ink-800 dark:text-ink-300"
                      >
                        <TagIcon className="h-2.5 w-2.5" />
                        {t}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
