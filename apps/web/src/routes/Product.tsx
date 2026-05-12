import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShoppingBag, ChevronLeft, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { useApi } from '../lib/api';

type ProductDetail = {
  product: {
    _id: string;
    slugKey: string;
    name: string;
    manufacturer: string | null;
    modelNumber: string | null;
    category: string | null;
    summary: string;
    imageUrl: string | null;
    wikidataId: string | null;
    wikidataConfidence: number;
  };
  summary: {
    totalAmount: number;
    currency: string | null;
    purchaseCount: number;
    totalQuantity: number;
    firstPurchasedAt: string | null;
    lastPurchasedAt: string | null;
  };
  purchases: {
    _id: string;
    amount: number | null;
    currency: string | null;
    quantity: number;
    purchasedAt: string | null;
    /** Where this purchase row came from — 'structured' means
     *  read straight from the email's schema.org JSON-LD; 'llm'
     *  means inferred from prose. */
    extractedBy: 'structured' | 'llm';
    merchant: { brandKey: string; name: string; logoUrl: string | null } | null;
    page: { slug: string; title: string } | null;
  }[];
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
 * Per-product wiki. Hero = canonical product info (image, name,
 * manufacturer). Side rail = spend summary + purchase history,
 * each linking to the source receipt Page. Globally-shared
 * product info (name, manufacturer, future summary brief) means a
 * future user buying the same item gets the same canonical entry
 * with zero LLM re-work.
 */
export default function ProductPage() {
  const { slug } = useParams<{ slug: string }>();
  const api = useApi();
  const qc = useQueryClient();
  const { data, isLoading, isError } = useQuery({
    queryKey: ['product', slug],
    queryFn: () =>
      api.get<ProductDetail>(`/api/products/${encodeURIComponent(slug ?? '')}`),
    enabled: !!slug,
  });
  const remove = useMutation({
    mutationFn: async (id: string) =>
      api.del<{ ok: true }>(`/api/products/purchases/${id}`),
    onSuccess: () => {
      toast.success('Purchase removed');
      qc.invalidateQueries({ queryKey: ['product', slug] });
      qc.invalidateQueries({ queryKey: ['products'] });
      qc.invalidateQueries({ queryKey: ['products-spend'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (isLoading) {
    return <div className="px-6 py-10 text-ink-500">Loading…</div>;
  }
  if (isError || !data) {
    return (
      <div className="mx-auto w-full max-w-4xl px-6 py-10 text-sm">
        <div className="card">
          <div className="font-medium text-red-600">Product not found.</div>
          <div className="mt-1 text-xs text-ink-500">
            You haven't bought this product, or it hasn't been extracted yet.{' '}
            <Link to="/products" className="text-rose-600 hover:underline">
              Back to Products
            </Link>
            .
          </div>
        </div>
      </div>
    );
  }

  const { product, summary, purchases } = data;

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-10">
      <Link
        to="/products"
        className="mb-4 inline-flex items-center gap-1 text-xs text-ink-500 hover:text-ink-900 dark:hover:text-ink-100"
      >
        <ChevronLeft className="h-3 w-3" /> Products
      </Link>

      <div className="mb-6 flex items-start gap-4">
        {product.imageUrl ? (
          <img
            src={product.imageUrl}
            alt=""
            className="h-20 w-20 shrink-0 rounded-lg object-cover"
            referrerPolicy="no-referrer"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = 'none';
            }}
          />
        ) : (
          <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-lg bg-rose-50 text-rose-500 dark:bg-rose-950/30">
            <ShoppingBag className="h-10 w-10" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            {product.name}
          </h1>
          <p className="mt-1 text-sm text-ink-500">
            {product.manufacturer ?? '—'}
            {product.modelNumber ? ` · ${product.modelNumber}` : ''}
            {product.category ? ` · ${product.category}` : ''}
          </p>
          {product.wikidataId && (
            <p className="mt-1 text-xs">
              <a
                href={`https://www.wikidata.org/wiki/${product.wikidataId}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 rounded-full bg-ink-100 px-2 py-0.5 text-[11px] text-ink-700 hover:bg-ink-200 dark:bg-ink-800 dark:text-ink-200 dark:hover:bg-ink-700"
                title={`Wikidata canonical entry · resolver confidence ${Math.round((product.wikidataConfidence ?? 0) * 100)}%`}
              >
                Wikidata: <code>{product.wikidataId}</code>
                {(product.wikidataConfidence ?? 0) < 0.9 && (
                  <span className="text-[10px] italic">unverified</span>
                )}
              </a>
            </p>
          )}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,7fr)_minmax(0,3fr)]">
        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-widest text-ink-500">
            Purchase history
          </h2>
          {purchases.length === 0 ? (
            <p className="text-sm italic text-ink-500">
              No purchases on file.
            </p>
          ) : (
            <ul className="space-y-2 text-sm">
              {purchases.map((p) => (
                <li
                  key={p._id}
                  className="flex items-start gap-3 rounded-lg border border-ink-200 px-3 py-2 dark:border-ink-800"
                >
                  {p.merchant?.logoUrl ? (
                    <img
                      src={p.merchant.logoUrl}
                      alt=""
                      className="mt-0.5 h-8 w-8 shrink-0 rounded object-contain"
                      referrerPolicy="no-referrer"
                      onError={(e) => {
                        (e.currentTarget as HTMLImageElement).style.display = 'none';
                      }}
                    />
                  ) : null}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span className="font-medium">
                        {formatMoney(p.amount, p.currency)}
                      </span>
                      {p.quantity > 1 && (
                        <span className="text-xs text-ink-500">
                          × {p.quantity}
                        </span>
                      )}
                      {p.merchant && (
                        <Link
                          to={`/s/${encodeURIComponent(p.merchant.brandKey)}`}
                          className="text-xs text-rose-600 hover:underline dark:text-rose-300"
                          title={`Open ${p.merchant.name}`}
                        >
                          {p.merchant.name}
                        </Link>
                      )}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-ink-500">
                      <span>
                        {p.purchasedAt
                          ? new Date(p.purchasedAt).toLocaleDateString()
                          : '—'}
                      </span>
                      {p.page && (
                        <Link
                          to={`/p/${p.page.slug}`}
                          className="hover:underline"
                        >
                          see receipt
                        </Link>
                      )}
                      <span
                        className={
                          'rounded-full px-1.5 py-0.5 text-[10px] uppercase tracking-widest ' +
                          (p.extractedBy === 'structured'
                            ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200'
                            : 'bg-ink-100 text-ink-600 dark:bg-ink-800 dark:text-ink-300')
                        }
                        title={
                          p.extractedBy === 'structured'
                            ? 'Read directly from the email’s schema.org markup — zero LLM cost.'
                            : 'Inferred by the LLM from the email’s prose.'
                        }
                      >
                        {p.extractedBy === 'structured' ? 'schema.org' : 'llm'}
                      </span>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn-ghost text-red-600"
                    onClick={() => {
                      if (confirm('Remove this purchase row?')) {
                        remove.mutate(p._id);
                      }
                    }}
                    aria-label="Remove"
                    title="Remove (extraction will re-run on regenerate)"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <aside className="space-y-4">
          <div className="card">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-widest text-ink-500">
              Spend summary
            </h3>
            <dl className="space-y-1 text-sm">
              <div className="flex justify-between">
                <dt className="text-ink-500">Total spent</dt>
                <dd className="font-semibold">
                  {formatMoney(summary.totalAmount, summary.currency)}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-ink-500">Purchases</dt>
                <dd>{summary.purchaseCount}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-ink-500">Units</dt>
                <dd>{summary.totalQuantity}</dd>
              </div>
              {summary.firstPurchasedAt && (
                <div className="flex justify-between">
                  <dt className="text-ink-500">First</dt>
                  <dd>
                    {new Date(summary.firstPurchasedAt).toLocaleDateString()}
                  </dd>
                </div>
              )}
              {summary.lastPurchasedAt && (
                <div className="flex justify-between">
                  <dt className="text-ink-500">Last</dt>
                  <dd>
                    {new Date(summary.lastPurchasedAt).toLocaleDateString()}
                  </dd>
                </div>
              )}
            </dl>
          </div>
          {product.summary && (
            <div className="card">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-widest text-ink-500">
                About this product
              </h3>
              <p className="text-sm">{product.summary}</p>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
