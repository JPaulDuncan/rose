import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ShoppingBag, Filter } from 'lucide-react';
import { useApi } from '../lib/api';

type ProductListItem = {
  productId: string;
  slugKey: string;
  name: string;
  manufacturer: string | null;
  modelNumber: string | null;
  category: string | null;
  imageUrl: string | null;
  purchaseCount: number;
  totalAmount: number | null;
  currency: string | null;
  firstPurchasedAt: string | null;
  lastPurchasedAt: string | null;
};

type SpendBucket = {
  category: string;
  currency: string | null;
  total: number;
  count: number;
};

const CATEGORY_LABEL: Record<string, string> = {
  food: 'Food',
  electronics: 'Electronics',
  clothing: 'Clothing',
  home: 'Home',
  media: 'Media',
  service: 'Services',
  travel: 'Travel',
  health: 'Health',
  office: 'Office',
  other: 'Other',
  uncategorized: 'Uncategorized',
};

function formatMoney(amount: number | null, currency: string | null): string {
  if (amount == null || amount === 0) return '—';
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
 * /products — every product the user has bought, extracted from
 * their receipt-tagged pages. Sorted by recency; spend rollup by
 * category up top. Click through to /products/<slug> for the
 * per-product wiki + purchase history.
 */
export default function ProductsPage() {
  const api = useApi();
  const [category, setCategory] = useState<string>('');

  const { data, isLoading } = useQuery({
    queryKey: ['products'],
    queryFn: () => api.get<{ products: ProductListItem[] }>('/api/products'),
  });
  const { data: spend } = useQuery({
    queryKey: ['products-spend'],
    queryFn: () => api.get<{ byCategory: SpendBucket[] }>('/api/products/spend'),
  });

  const products = data?.products ?? [];
  const filtered = useMemo(
    () =>
      category
        ? products.filter((p) => (p.category ?? 'uncategorized') === category)
        : products,
    [products, category],
  );

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const p of products) set.add(p.category ?? 'uncategorized');
    return [...set];
  }, [products]);

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-10">
      <div className="mb-6 flex items-center gap-3">
        <ShoppingBag className="h-6 w-6 text-rose-500" />
        <h1 className="text-2xl font-semibold tracking-tight">Products</h1>
        <span className="ml-auto text-sm text-ink-500">
          {products.length} product{products.length === 1 ? '' : 's'}
        </span>
      </div>

      {spend && spend.byCategory.length > 0 && (
        <div className="card mb-6">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-ink-500">
            Spend by category
          </h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {spend.byCategory.map((b) => (
              <button
                key={`${b.category}-${b.currency}`}
                type="button"
                onClick={() =>
                  setCategory(category === b.category ? '' : b.category)
                }
                className={
                  'rounded-lg border p-3 text-left transition-colors ' +
                  (category === b.category
                    ? 'border-rose-300 bg-rose-50 dark:border-rose-700 dark:bg-rose-950/30'
                    : 'border-ink-200 hover:border-rose-300 dark:border-ink-800 dark:hover:border-rose-800')
                }
                title={`Filter to #${b.category}`}
              >
                <div className="text-[10px] uppercase tracking-widest text-ink-500">
                  {CATEGORY_LABEL[b.category] ?? b.category}
                </div>
                <div className="mt-1 text-base font-semibold">
                  {formatMoney(b.total, b.currency)}
                </div>
                <div className="text-[11px] text-ink-500">
                  {b.count} purchase{b.count === 1 ? '' : 's'}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {category && (
        <div className="mb-3 flex items-center gap-2 text-xs text-ink-500">
          <Filter className="h-3.5 w-3.5" />
          Filtering by{' '}
          <code className="rounded bg-ink-100 px-1 dark:bg-ink-800">
            {CATEGORY_LABEL[category] ?? category}
          </code>
          <button
            type="button"
            className="ml-auto btn-ghost text-xs"
            onClick={() => setCategory('')}
          >
            Clear
          </button>
        </div>
      )}

      {isLoading ? (
        <div className="card text-sm text-ink-500">Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="card text-sm text-ink-500">
          {products.length === 0
            ? 'No products yet. When a receipt or order-confirmation page lands, Rose extracts the line items and files them here.'
            : 'No products in this category.'}
        </div>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((p) => (
            <li key={p.productId}>
              <Link
                to={`/products/${encodeURIComponent(p.slugKey)}`}
                className="card block hover:border-rose-300 dark:hover:border-rose-700"
              >
                <div className="flex items-start gap-3">
                  {p.imageUrl ? (
                    <img
                      src={p.imageUrl}
                      alt=""
                      className="h-14 w-14 shrink-0 rounded object-cover"
                      loading="lazy"
                      referrerPolicy="no-referrer"
                      onError={(e) => {
                        (e.currentTarget as HTMLImageElement).style.display = 'none';
                      }}
                    />
                  ) : (
                    <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded bg-rose-50 text-rose-500 dark:bg-rose-950/30">
                      <ShoppingBag className="h-6 w-6" />
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{p.name}</div>
                    <div className="mt-0.5 text-xs text-ink-500">
                      {p.manufacturer ?? '—'}
                      {p.modelNumber ? ` · ${p.modelNumber}` : ''}
                    </div>
                    <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11px] text-ink-500">
                      <span className="font-semibold text-ink-700 dark:text-ink-200">
                        {formatMoney(p.totalAmount, p.currency)}
                      </span>
                      <span>
                        · {p.purchaseCount} purchase
                        {p.purchaseCount === 1 ? '' : 's'}
                      </span>
                      {p.category && (
                        <span className="rounded-full bg-ink-100 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-ink-600 dark:bg-ink-800 dark:text-ink-300">
                          {CATEGORY_LABEL[p.category] ?? p.category}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
