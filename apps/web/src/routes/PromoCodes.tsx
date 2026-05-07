import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  Tag as TagIcon,
  Copy,
  Trash2,
  Archive,
  ArchiveRestore,
  CheckCircle2,
  RefreshCw,
  ExternalLink,
  Clock,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useApi } from '../lib/api';

type PromoCode = {
  _id: string;
  code: string;
  brand: string | null;
  brandLabel: string | null;
  description: string;
  discount: string | null;
  expiresAt: string | null;
  url: string | null;
  emailId: string;
  pageId: string | null;
  usedAt: string | null;
  archivedAt: string | null;
  createdAt: string;
};

type Filter = 'active' | 'used' | 'archived';

/**
 * Promotional Codes page. Rose extracts promo codes from incoming
 * emails and groups them by brand here. Active = not used + not
 * archived; "Mark used" and "Archive" let the user prune the list as
 * they spend or expire codes. The "Scan inbox" button on the empty
 * state runs the extractor across recent emails so first-time users
 * see results without waiting for new mail.
 */
export default function PromoCodesPage() {
  const api = useApi();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<Filter>('active');

  const { data, isLoading } = useQuery({
    queryKey: ['promo-codes', filter],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filter === 'used') params.set('used', '1');
      if (filter === 'archived') params.set('archived', '1');
      const r = await api.get<{ promoCodes: PromoCode[] }>(
        `/api/promo-codes?${params.toString()}`,
      );
      return r;
    },
  });

  const update = useMutation({
    mutationFn: async ({
      id,
      patch,
    }: {
      id: string;
      patch: Record<string, unknown>;
    }) => api.patch<{ ok: true }>(`/api/promo-codes/${id}`, patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['promo-codes'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: async (id: string) =>
      api.del<{ ok: true }>(`/api/promo-codes/${id}`),
    onSuccess: () => {
      toast.success('Removed');
      void qc.invalidateQueries({ queryKey: ['promo-codes'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const scan = useMutation({
    mutationFn: async () =>
      api.post<{ ok: true; scannedEmails: number; codesUpserted: number }>(
        '/api/promo-codes/scan',
        {},
      ),
    onSuccess: (r) => {
      toast.success(
        `Scanned ${r.scannedEmails} emails, ${r.codesUpserted} codes saved`,
      );
      void qc.invalidateQueries({ queryKey: ['promo-codes'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const codes = data?.promoCodes ?? [];
  const groups = groupByBrand(codes);

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 px-4 py-8">
      <header>
        <div className="text-[10px] uppercase tracking-[0.25em] text-rose-600 dark:text-rose-300">
          Discounts desk
        </div>
        <h1 className="mt-1 font-serif text-3xl font-black tracking-tight">
          Promotional Codes
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-ink-500">
          Coupons, voucher codes, and discounts Rose pulled from your inbox.
          Mark a code used or archive it to clean up the list — the source
          email stays put.
        </p>
      </header>

      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-200 pb-3 text-xs dark:border-ink-800">
        <div className="flex flex-wrap gap-2">
          {(['active', 'used', 'archived'] as Filter[]).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={
                'rounded-full px-3 py-1 capitalize ' +
                (filter === f
                  ? 'bg-rose-100 text-rose-800 dark:bg-rose-950/40 dark:text-rose-200'
                  : 'text-ink-500 hover:text-ink-700 dark:hover:text-ink-200')
              }
            >
              {f}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="btn-ghost text-xs"
          onClick={() => scan.mutate()}
          disabled={scan.isPending}
        >
          <RefreshCw
            className={'h-3.5 w-3.5' + (scan.isPending ? ' animate-spin' : '')}
          />{' '}
          Scan inbox
        </button>
      </div>

      {isLoading ? (
        <div className="card text-sm text-ink-500">Loading codes…</div>
      ) : codes.length === 0 ? (
        <div className="card flex flex-col items-center gap-3 py-12 text-center">
          <TagIcon className="h-10 w-10 text-rose-500" />
          <div>
            <h3 className="font-semibold">
              {filter === 'active'
                ? 'No active codes'
                : filter === 'used'
                  ? 'Nothing marked used'
                  : 'Nothing archived'}
            </h3>
            <p className="mt-1 text-sm text-ink-500">
              Rose adds codes here automatically when an email mentions one.
              Hit <strong>Scan inbox</strong> to backfill from recent mail.
            </p>
          </div>
          <button
            type="button"
            className="btn-primary text-xs"
            onClick={() => scan.mutate()}
            disabled={scan.isPending}
          >
            <RefreshCw
              className={'h-3.5 w-3.5' + (scan.isPending ? ' animate-spin' : '')}
            />{' '}
            Scan inbox
          </button>
        </div>
      ) : (
        <div className="space-y-6">
          {groups.map(({ brand, items }) => (
            <section key={brand}>
              <h2 className="mb-2 text-[10px] uppercase tracking-[0.25em] text-ink-500">
                {brand}
                <span className="ml-1 text-ink-400">· {items.length}</span>
              </h2>
              <ul className="space-y-2">
                {items.map((c) => (
                  <PromoCodeCard
                    key={c._id}
                    promo={c}
                    onMarkUsed={(used) =>
                      update.mutate({ id: c._id, patch: { used } })
                    }
                    onArchive={(archived) =>
                      update.mutate({ id: c._id, patch: { archived } })
                    }
                    onRemove={() => {
                      if (
                        confirm(
                          `Delete code ${c.code}? The source email stays in your inbox.`,
                        )
                      ) {
                        remove.mutate(c._id);
                      }
                    }}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function PromoCodeCard({
  promo,
  onMarkUsed,
  onArchive,
  onRemove,
}: {
  promo: PromoCode;
  onMarkUsed: (used: boolean) => void;
  onArchive: (archived: boolean) => void;
  onRemove: () => void;
}) {
  const expires = promo.expiresAt ? new Date(promo.expiresAt) : null;
  const expired = expires ? expires.getTime() < Date.now() : false;
  const isUsed = !!promo.usedAt;
  const isArchived = !!promo.archivedAt;

  return (
    <li
      className={
        'card space-y-2 ' +
        (isUsed || isArchived || expired ? 'opacity-60' : '')
      }
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <code
              className={
                'rounded bg-rose-100 px-2 py-1 font-mono text-sm font-bold text-rose-800 dark:bg-rose-950/40 dark:text-rose-200 ' +
                (isUsed ? 'line-through decoration-2' : '')
              }
            >
              {promo.code}
            </code>
            {promo.discount && (
              <span className="text-xs font-medium text-emerald-700 dark:text-emerald-300">
                {promo.discount}
              </span>
            )}
            {expires && (
              <span
                className={
                  'inline-flex items-center gap-1 text-[11px] ' +
                  (expired
                    ? 'text-red-600 dark:text-red-400'
                    : 'text-amber-700 dark:text-amber-300')
                }
              >
                <Clock className="h-3 w-3" />
                {expired ? 'Expired ' : 'Expires '}
                {expires.toLocaleDateString()}
              </span>
            )}
          </div>
          {promo.description && (
            <p className="mt-1 line-clamp-2 text-xs text-ink-600 dark:text-ink-300">
              {promo.description}
            </p>
          )}
        </div>
        <div className="flex flex-shrink-0 items-center gap-1">
          <button
            type="button"
            className="btn-ghost text-xs"
            onClick={() => {
              void navigator.clipboard.writeText(promo.code).catch(() => null);
              toast.success('Copied');
            }}
            title="Copy code"
          >
            <Copy className="h-3.5 w-3.5" />
          </button>
          <Link
            to={`/e/${promo.emailId}`}
            className="btn-ghost text-xs"
            title="Open source email"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </Link>
          <button
            type="button"
            className={'btn-ghost text-xs ' + (isUsed ? 'text-emerald-600' : '')}
            onClick={() => onMarkUsed(!isUsed)}
            title={isUsed ? 'Restore (mark unused)' : 'Mark used'}
          >
            <CheckCircle2 className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className="btn-ghost text-xs"
            onClick={() => onArchive(!isArchived)}
            title={isArchived ? 'Restore from archive' : 'Archive'}
          >
            {isArchived ? (
              <ArchiveRestore className="h-3.5 w-3.5" />
            ) : (
              <Archive className="h-3.5 w-3.5" />
            )}
          </button>
          <button
            type="button"
            className="btn-ghost text-xs text-red-600"
            onClick={onRemove}
            title="Delete"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </li>
  );
}

function groupByBrand(codes: PromoCode[]): { brand: string; items: PromoCode[] }[] {
  const m = new Map<string, PromoCode[]>();
  for (const c of codes) {
    const key = c.brandLabel ?? c.brand ?? 'Unknown sender';
    const arr = m.get(key) ?? [];
    arr.push(c);
    m.set(key, arr);
  }
  return [...m.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([brand, items]) => ({ brand, items }));
}
