import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ShieldAlert, Megaphone, Ban, ArrowRight } from 'lucide-react';
import { useApi } from '../lib/api';

type Summary = {
  quarantine: number;
  spam: number;
  promotions: number;
  total: number;
};

/**
 * Plan 12 (R6) — single landing page surfacing the three "hidden by
 * default" buckets so the user has one place to look for stuff
 * Rose has filtered out. Each card links to the existing dedicated
 * route where the bulk actions live; this page is intentionally
 * thin so it doesn't compete with those.
 */
export default function HiddenPage() {
  const api = useApi();
  const { data, isLoading } = useQuery({
    queryKey: ['hidden-summary'],
    queryFn: () => api.get<Summary>('/api/hidden/summary'),
  });

  const cards: Array<{
    title: string;
    detail: string;
    icon: typeof ShieldAlert;
    to: string;
    count: number | null;
    accent: string;
  }> = [
    {
      title: 'Quarantine',
      detail:
        'Pages auto-flagged by the spam classifier — sender reputation past the threshold or a rule with quarantine action.',
      icon: ShieldAlert,
      to: '/quarantine',
      count: data?.quarantine ?? null,
      accent:
        'border-rose-200 bg-rose-50 dark:border-rose-900/40 dark:bg-rose-950/20',
    },
    {
      title: 'Muted',
      detail:
        "Pages from senders you've muted, plus anything matching your tag mute list. They're filed but kept out of the main feed.",
      icon: Ban,
      to: '/settings/spam',
      count: data?.spam ?? null,
      accent:
        'border-red-200 bg-red-50 dark:border-red-900/40 dark:bg-red-950/20',
    },
    {
      title: 'Promotions',
      detail:
        'Pages where ≥60% of the contributing emails were classified as promotional content. Hidden from digests by default.',
      icon: Megaphone,
      to: '/promotions',
      count: data?.promotions ?? null,
      accent:
        'border-amber-200 bg-amber-50 dark:border-amber-900/40 dark:bg-amber-950/20',
    },
  ];

  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-10">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Hidden content</h1>
        <p className="mt-1 text-sm text-ink-500">
          Pages Rose keeps out of the home edition by default —
          quarantine flags, spam policy hits, and promotional rollups.
          {!isLoading && data && (
            <>
              {' '}
              <span className="font-medium">
                {data.total} page{data.total === 1 ? '' : 's'} hidden in
                total.
              </span>
            </>
          )}
        </p>
      </div>

      <ul className="grid gap-4 sm:grid-cols-3">
        {cards.map((c) => (
          <li key={c.title}>
            <Link
              to={c.to}
              className={`group block rounded-xl border p-4 transition-colors hover:border-rose-300 ${c.accent}`}
            >
              <div className="mb-2 flex items-center gap-2">
                <c.icon className="h-4 w-4" />
                <h2 className="font-semibold">{c.title}</h2>
                <ArrowRight className="ml-auto h-3.5 w-3.5 opacity-0 transition-opacity group-hover:opacity-100" />
              </div>
              <div className="text-3xl font-semibold">
                {c.count ?? (isLoading ? '…' : 0)}
              </div>
              <p className="mt-2 text-xs text-ink-600 dark:text-ink-300">
                {c.detail}
              </p>
            </Link>
          </li>
        ))}
      </ul>

      <p className="mt-6 text-xs italic text-ink-500">
        Tweak the thresholds + policy in{' '}
        <Link to="/settings/spam" className="text-rose-600 hover:underline">
          Settings → Spam
        </Link>
        .
      </p>
    </div>
  );
}
