import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Repeat, Trash2, Calendar, AlertCircle } from 'lucide-react';
import toast from 'react-hot-toast';
import { useApi } from '../lib/api';

type Subscription = {
  _id: string;
  serviceName: string;
  serviceKey: string;
  brandKey: string | null;
  merchant: { name: string; logoUrl: string | null } | null;
  amount: number | null;
  currency: string | null;
  cadence: 'monthly' | 'yearly' | 'quarterly' | 'weekly' | 'other';
  category: string | null;
  nextRenewalAt: string | null;
  status: 'active' | 'cancelled' | 'expired';
  firstSeenAt: string | null;
  updatedAt: string | null;
};

type MonthlySpend = {
  byCurrency: { currency: string; monthly: number }[];
};

const STATUS_CLASS: Record<Subscription['status'], string> = {
  active:
    'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200',
  cancelled:
    'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200',
  expired: 'bg-ink-100 text-ink-700 dark:bg-ink-800 dark:text-ink-200',
};

const CATEGORY_LABEL: Record<string, string> = {
  media: 'Media',
  software: 'Software',
  utility: 'Utility',
  fitness: 'Fitness',
  news: 'News',
  insurance: 'Insurance',
  cloud: 'Cloud',
  other: 'Other',
};

function formatMoney(amount: number | null, currency: string | null): string {
  if (amount == null) return '—';
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: currency ?? 'USD',
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency ?? ''}`.trim();
  }
}

/**
 * /subscriptions — typed-event view onto the recurring services
 * extracted from receipt / renewal emails. Spotlights monthly
 * burn at the top so the user sees the answer to "what am I
 * paying for every month" without scrolling.
 */
export default function SubscriptionsPage() {
  const api = useApi();
  const qc = useQueryClient();
  const [status, setStatus] = useState<'all' | 'active' | 'cancelled' | 'expired'>(
    'active',
  );
  const { data, isLoading } = useQuery({
    queryKey: ['subscriptions', status],
    queryFn: () =>
      api.get<{ subscriptions: Subscription[] }>(
        status === 'all'
          ? '/api/subscriptions'
          : `/api/subscriptions?status=${status}`,
      ),
  });
  const { data: spend } = useQuery({
    queryKey: ['subscriptions-monthly'],
    queryFn: () => api.get<MonthlySpend>('/api/subscriptions/monthly-spend'),
  });

  const remove = useMutation({
    mutationFn: async (id: string) =>
      api.del<{ ok: true }>(`/api/subscriptions/${id}`),
    onSuccess: () => {
      toast.success('Subscription removed');
      qc.invalidateQueries({ queryKey: ['subscriptions'] });
      qc.invalidateQueries({ queryKey: ['subscriptions-monthly'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const subs = data?.subscriptions ?? [];
  // Surface upcoming renewals at the top.
  const upcoming = [...subs]
    .filter((s) => s.status === 'active' && s.nextRenewalAt)
    .sort(
      (a, b) =>
        new Date(a.nextRenewalAt!).getTime() -
        new Date(b.nextRenewalAt!).getTime(),
    )
    .slice(0, 5);

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-10">
      <header className="mb-6 flex items-center gap-3">
        <Repeat className="h-6 w-6 text-rose-500" />
        <h1 className="text-2xl font-semibold tracking-tight">Subscriptions</h1>
        <span className="ml-auto text-sm text-ink-500">
          {subs.length} on file
        </span>
      </header>

      {/* Monthly burn */}
      {spend && spend.byCurrency.length > 0 && (
        <div className="card mb-6">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-widest text-ink-500">
            Estimated monthly recurring spend
          </h2>
          <div className="flex flex-wrap gap-4">
            {spend.byCurrency.map((b) => (
              <div key={b.currency}>
                <div className="text-2xl font-semibold">
                  {formatMoney(b.monthly, b.currency)}
                </div>
                <div className="text-xs text-ink-500">{b.currency}</div>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[11px] italic text-ink-500">
            Active subscriptions only. Yearly / quarterly / weekly are
            normalised to a monthly equivalent. Currencies aren't
            converted — each is summed independently.
          </p>
        </div>
      )}

      {/* Upcoming renewals */}
      {upcoming.length > 0 && (
        <div className="card mb-6">
          <h2 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-ink-500">
            <Calendar className="h-3.5 w-3.5" />
            Upcoming renewals
          </h2>
          <ul className="space-y-1 text-sm">
            {upcoming.map((s) => (
              <li
                key={s._id}
                className="flex items-baseline justify-between rounded px-2 py-1 hover:bg-rose-50/40 dark:hover:bg-rose-950/10"
              >
                <span className="truncate">{s.serviceName}</span>
                <span className="ml-2 text-xs text-ink-500">
                  {s.nextRenewalAt
                    ? new Date(s.nextRenewalAt).toLocaleDateString()
                    : '—'}
                  {s.amount != null && (
                    <>
                      {' · '}
                      {formatMoney(s.amount, s.currency)}
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Status filter */}
      <div className="mb-3 inline-flex rounded-md border border-ink-200 p-0.5 text-xs dark:border-ink-800">
        {(['active', 'cancelled', 'expired', 'all'] as const).map((s) => (
          <button
            key={s}
            type="button"
            className={
              'rounded px-3 py-1 ' +
              (status === s
                ? 'bg-rose-500 text-white'
                : 'text-ink-600 dark:text-ink-300')
            }
            onClick={() => setStatus(s)}
          >
            {s}
          </button>
        ))}
      </div>

      {/* List */}
      {isLoading ? (
        <div className="card text-sm text-ink-500">Loading…</div>
      ) : subs.length === 0 ? (
        <div className="card text-center text-sm text-ink-500">
          <AlertCircle className="mx-auto mb-2 h-5 w-5 text-rose-500" />
          No {status === 'all' ? '' : status} subscriptions yet. As
          renewal / sign-up emails land they'll be filed here.
        </div>
      ) : (
        <ul className="space-y-2 text-sm">
          {subs.map((s) => (
            <li
              key={s._id}
              className="flex items-start gap-3 rounded-lg border border-ink-200 px-3 py-2 dark:border-ink-800"
            >
              {s.merchant?.logoUrl ? (
                <img
                  src={s.merchant.logoUrl}
                  alt=""
                  className="mt-0.5 h-8 w-8 shrink-0 rounded object-contain"
                  referrerPolicy="no-referrer"
                  onError={(e) => {
                    (e.currentTarget as HTMLImageElement).style.display = 'none';
                  }}
                />
              ) : (
                <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded bg-rose-50 text-rose-500 dark:bg-rose-950/30">
                  <Repeat className="h-4 w-4" />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="font-medium">{s.serviceName}</span>
                  <span
                    className={`rounded-full px-1.5 py-0.5 text-[10px] uppercase tracking-widest ${STATUS_CLASS[s.status]}`}
                  >
                    {s.status}
                  </span>
                  {s.category && (
                    <span className="rounded-full bg-ink-100 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-ink-600 dark:bg-ink-800 dark:text-ink-300">
                      {CATEGORY_LABEL[s.category] ?? s.category}
                    </span>
                  )}
                </div>
                <div className="mt-0.5 text-xs text-ink-500">
                  {s.amount != null
                    ? `${formatMoney(s.amount, s.currency)} ${s.cadence}`
                    : `${s.cadence} — price unknown`}
                  {s.nextRenewalAt && (
                    <>
                      {' · renews '}
                      {new Date(s.nextRenewalAt).toLocaleDateString()}
                    </>
                  )}
                  {s.merchant && (
                    <>
                      {' · '}
                      <Link
                        to={`/s/${encodeURIComponent(s.brandKey ?? '')}`}
                        className="hover:underline"
                      >
                        {s.merchant.name}
                      </Link>
                    </>
                  )}
                </div>
              </div>
              <button
                type="button"
                className="btn-ghost text-red-600"
                onClick={() => {
                  if (
                    confirm(`Remove "${s.serviceName}" from subscriptions?`)
                  ) {
                    remove.mutate(s._id);
                  }
                }}
                aria-label="Remove"
                title="Remove (extraction will re-run on the source page regenerate)"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
