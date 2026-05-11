import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  GitBranch,
  ChevronLeft,
  ArrowUp,
  ArrowDown,
  Link as LinkIcon,
  Users,
  Mail,
  Hash,
} from 'lucide-react';
import { useApi } from '../lib/api';

type LineagePage = {
  _id: string;
  slug: string;
  title: string;
  summary: string;
  articleDate: string | null;
  updatedAt: string;
  reasons: ('cited' | 'cited-by' | 'shared-entity' | 'shared-source' | 'shared-tag')[];
};

type LineageResponse = {
  center: {
    _id: string;
    slug: string;
    title: string;
    summary: string;
    articleDate: string | null;
    updatedAt: string;
  };
  upstream: LineagePage[];
  downstream: LineagePage[];
};

const REASON_META: Record<
  LineagePage['reasons'][number],
  { label: string; icon: typeof LinkIcon; cls: string }
> = {
  cited: {
    label: 'cited in body',
    icon: LinkIcon,
    cls: 'bg-rose-100 text-rose-800 dark:bg-rose-950/40 dark:text-rose-200',
  },
  'cited-by': {
    label: 'cites this page',
    icon: LinkIcon,
    cls: 'bg-rose-100 text-rose-800 dark:bg-rose-950/40 dark:text-rose-200',
  },
  'shared-entity': {
    label: 'shared subject',
    icon: Users,
    cls: 'bg-sky-100 text-sky-800 dark:bg-sky-950/40 dark:text-sky-200',
  },
  'shared-source': {
    label: 'shared mail',
    icon: Mail,
    cls: 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200',
  },
  'shared-tag': {
    label: 'shared tag',
    icon: Hash,
    cls: 'bg-ink-100 text-ink-700 dark:bg-ink-800 dark:text-ink-200',
  },
};

/**
 * /p/:slug/lineage — the concept-lineage view. Renders a small
 * upstream / center / downstream layout for one page, with each
 * sibling tagged by the signal(s) that surfaced it. See the API
 * route for the full ranking model.
 */
export default function LineagePage() {
  const { slug } = useParams<{ slug: string }>();
  const api = useApi();

  // Resolve slug → id, then load the lineage. The two queries run
  // sequentially because the second depends on the first.
  const { data: page } = useQuery({
    queryKey: ['page-by-slug', slug],
    queryFn: () =>
      api.get<{ _id: string; title: string; slug: string }>(
        `/api/pages/by-slug/${encodeURIComponent(slug ?? '')}`,
      ),
    enabled: !!slug,
  });
  const { data, isLoading } = useQuery({
    queryKey: ['lineage', page?._id],
    queryFn: () =>
      api.get<LineageResponse>(`/api/pages/${page?._id}/lineage`),
    enabled: !!page?._id,
  });

  if (!slug) return null;
  if (isLoading || !data) {
    return (
      <div className="mx-auto w-full max-w-5xl px-6 py-10 text-ink-500">
        Loading lineage…
      </div>
    );
  }
  const { center, upstream, downstream } = data;

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-10">
      <Link
        to={`/p/${center.slug}`}
        className="mb-4 inline-flex items-center gap-1 text-xs text-ink-500 hover:text-ink-900 dark:hover:text-ink-100"
      >
        <ChevronLeft className="h-3 w-3" /> Back to page
      </Link>

      <div className="mb-6 flex items-center gap-3">
        <GitBranch className="h-6 w-6 text-rose-500" />
        <div>
          <div className="text-xs uppercase tracking-widest text-rose-500">
            Concept lineage
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {center.title}
          </h1>
        </div>
      </div>

      <div className="space-y-6">
        {/* Upstream */}
        <section>
          <h2 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-ink-500">
            <ArrowUp className="h-3.5 w-3.5" />
            Influences ({upstream.length})
          </h2>
          {upstream.length === 0 ? (
            <p className="text-sm italic text-ink-500">
              No older pages reference the same subjects or sources.
            </p>
          ) : (
            <ul className="space-y-2">
              {upstream.map((p) => (
                <LineageRow key={p._id} page={p} />
              ))}
            </ul>
          )}
        </section>

        {/* Center */}
        <section className="rounded-lg border-2 border-rose-300 bg-rose-50/40 p-4 dark:border-rose-700 dark:bg-rose-950/20">
          <div className="text-[10px] uppercase tracking-widest text-rose-700 dark:text-rose-300">
            This page
          </div>
          <div className="mt-1 text-lg font-semibold">{center.title}</div>
          {center.summary && (
            <p className="mt-1 text-sm italic text-ink-600 dark:text-ink-300">
              {center.summary}
            </p>
          )}
          <div className="mt-2 text-[11px] text-ink-500">
            {center.articleDate
              ? new Date(center.articleDate).toLocaleDateString()
              : new Date(center.updatedAt).toLocaleDateString()}
          </div>
        </section>

        {/* Downstream */}
        <section>
          <h2 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-ink-500">
            <ArrowDown className="h-3.5 w-3.5" />
            Descendants ({downstream.length})
          </h2>
          {downstream.length === 0 ? (
            <p className="text-sm italic text-ink-500">
              No newer pages descend from this one yet.
            </p>
          ) : (
            <ul className="space-y-2">
              {downstream.map((p) => (
                <LineageRow key={p._id} page={p} />
              ))}
            </ul>
          )}
        </section>
      </div>

      <p className="mt-8 text-[11px] italic text-ink-500">
        Lineage is approximated from explicit page-to-page links plus
        overlap on entities, source emails, and tags. Pages older than
        this one with shared signals are filed upstream; newer ones
        downstream.
      </p>
    </div>
  );
}

function LineageRow({ page }: { page: LineagePage }) {
  return (
    <li>
      <Link
        to={`/p/${page.slug}`}
        className="block rounded-lg border border-ink-200 px-3 py-2 transition-colors hover:border-rose-300 dark:border-ink-800 dark:hover:border-rose-700"
      >
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="font-medium leading-tight">{page.title}</div>
            {page.summary && (
              <p className="mt-0.5 line-clamp-2 text-xs text-ink-500">
                {page.summary}
              </p>
            )}
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
              {page.reasons.map((r) => {
                const meta = REASON_META[r];
                const Icon = meta.icon;
                return (
                  <span
                    key={r}
                    className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 ${meta.cls}`}
                    title={meta.label}
                  >
                    <Icon className="h-3 w-3" />
                    {meta.label}
                  </span>
                );
              })}
              <span className="ml-auto text-ink-400">
                {page.articleDate
                  ? new Date(page.articleDate).toLocaleDateString()
                  : new Date(page.updatedAt).toLocaleDateString()}
              </span>
            </div>
          </div>
        </div>
      </Link>
    </li>
  );
}
