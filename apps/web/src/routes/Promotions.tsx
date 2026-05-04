import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Megaphone, Tag as TagIcon } from 'lucide-react';
import { useApi } from '../lib/api';

type SenderBrand = {
  brandKey: string;
  name: string;
  domain: string | null;
  logoUrl: string | null;
};

type PromoPage = {
  _id: string;
  slug: string;
  title: string;
  summary: string;
  heroImageUrl: string | null;
  tags: string[];
  topics: string[];
  senderAddresses: string[];
  messageCount: number;
  updatedAt: string;
};

type PromotionsResp = {
  pages: PromoPage[];
  total: number;
  senderBrands: Record<string, SenderBrand>;
};

export default function PromotionsPage() {
  const api = useApi();
  const { data, isLoading } = useQuery({
    queryKey: ['promotions'],
    queryFn: () => api.get<PromotionsResp>('/api/promotions?limit=100'),
  });

  if (isLoading) {
    return <div className="px-6 py-10 text-ink-500">Loading…</div>;
  }
  if (!data || data.pages.length === 0) {
    return (
      <div className="mx-auto w-full max-w-4xl px-6 py-10">
        <div className="card flex flex-col items-center gap-3 py-16 text-center">
          <Megaphone className="h-10 w-10 text-rose-500" />
          <div>
            <h2 className="font-serif text-2xl">Inbox uncluttered</h2>
            <p className="text-sm text-ink-500">
              No promotional pages right now. As newsletters and marketing
              mail arrive, they'll be tucked into this view instead of the
              front page.
            </p>
          </div>
          <Link to="/" className="btn-secondary">
            Back to the edition
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-10">
      <header className="mb-6 border-b-2 border-ink-900 pb-3 dark:border-ink-100">
        <div className="text-[10px] uppercase tracking-[0.25em] text-ink-500">
          Hidden by default
        </div>
        <div className="mt-0.5 flex items-baseline justify-between gap-4">
          <h1 className="font-serif text-4xl font-black tracking-tight">
            Promotions
          </h1>
          <span className="text-[11px] uppercase tracking-widest text-ink-500">
            {data.total} {data.total === 1 ? 'entry' : 'entries'}
          </span>
        </div>
        <p className="mt-2 text-sm text-ink-500">
          Pages flagged as promotional content (newsletters, ads,
          sponsored mail). Visit the{' '}
          <Link to="/settings/spam" className="text-rose-600 hover:underline dark:text-rose-300">
            spam settings
          </Link>{' '}
          to change how aggressively these are hidden.
        </p>
      </header>

      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {data.pages.map((p) => {
          const primary = p.senderAddresses[0];
          const brand = primary ? data.senderBrands[primary] : null;
          return (
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
                  <div className="mb-1.5 flex items-center gap-2">
                    {brand?.logoUrl ? (
                      <img
                        src={brand.logoUrl}
                        alt=""
                        className="h-4 w-4 shrink-0 rounded-sm bg-white object-contain ring-1 ring-ink-200 dark:ring-ink-700"
                      />
                    ) : null}
                    <span className="truncate text-[11px] uppercase tracking-widest text-ink-500">
                      {brand?.name ?? primary ?? 'Unknown sender'}
                    </span>
                  </div>
                  <h3 className="font-serif text-base font-semibold leading-snug group-hover:text-rose-700 dark:group-hover:text-rose-300">
                    {p.title}
                  </h3>
                  {p.summary && (
                    <p className="mt-1 line-clamp-3 text-xs leading-relaxed text-ink-600 dark:text-ink-300">
                      {p.summary}
                    </p>
                  )}
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
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
