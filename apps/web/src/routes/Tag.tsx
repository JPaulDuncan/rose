import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Hash,
  FileText,
  Users,
  Network,
  Flame,
  Megaphone,
  ChevronLeft,
  Star,
  Sparkles,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useApi } from '../lib/api';

type TagPage = {
  _id: string;
  slug: string;
  title: string;
  summary: string;
  tags: string[];
  topics: string[];
  priority: 'high' | 'normal' | 'low';
  flags?: { hasMassMailing?: boolean; hasLikelySpam?: boolean; isSparse?: boolean };
  sourceEmailIds: string[];
  senderAddresses: string[];
  heroImageUrl?: string | null;
  updatedAt: string;
};

type TagDigestSummary = {
  headline: string;
  dek: string;
  bodyMd: string;
  topPageIds: string[];
  pageCount: number;
  model: string | null;
  dayKey: string;
  generatedAt: string | null;
};

type TagPageResponse = {
  /** The joined slug for digest lookup. Single-tag => the tag
   *  itself; multi-tag => parts joined by `+`, e.g. "receipt+anthropic". */
  tag: string;
  /** The constituent tags. Length > 1 indicates an intersection
   *  view ("Receipt:Anthropic"). */
  tags?: string[];
  pageCount: number;
  totalEmails: number;
  dateRange: { from: string; to: string } | null;
  topSenders: {
    address: string;
    pageCount: number;
    brandKey: string | null;
    name: string;
  }[];
  relatedTags: { tag: string; count: number }[];
  digest: TagDigestSummary | null;
  pages: TagPage[];
};

export default function TagPage() {
  const { tag: rawTag } = useParams<{ tag: string }>();
  const tag = (rawTag ?? '').toLowerCase();
  const api = useApi();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['tag', tag],
    queryFn: () => api.get<TagPageResponse>(`/api/tags/${encodeURIComponent(tag)}`),
    enabled: !!tag,
  });
  const regenDigest = useMutation({
    mutationFn: async () =>
      api.post<{ jobId: string }>(
        `/api/tags/${encodeURIComponent(tag)}/digest/regenerate`,
      ),
    onSuccess: () => {
      toast.success("Today's brief queued — refresh in a few seconds.");
      void setTimeout(() => qc.invalidateQueries({ queryKey: ['tag', tag] }), 4000);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const { data: featured } = useQuery({
    queryKey: ['featured-tags'],
    queryFn: () => api.get<{ tags: string[] }>('/api/featured-tags'),
  });
  const isFeatured = !!featured?.tags?.includes(tag);

  const pin = useMutation({
    mutationFn: async () =>
      api.post<{ tags: string[] }>('/api/featured-tags', { tag }),
    onSuccess: () => {
      toast.success(`Pinned #${tag} to your newsletter.`);
      qc.invalidateQueries({ queryKey: ['featured-tags'] });
      qc.invalidateQueries({ queryKey: ['digest'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const unpin = useMutation({
    mutationFn: async () =>
      api.del<{ tags: string[] }>(`/api/featured-tags/${encodeURIComponent(tag)}`),
    onSuccess: () => {
      toast.success(`Unpinned #${tag}.`);
      qc.invalidateQueries({ queryKey: ['featured-tags'] });
      qc.invalidateQueries({ queryKey: ['digest'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (isLoading || !data) {
    return <div className="px-6 py-10 text-ink-500">Loading…</div>;
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-10">
      <Link
        to="/"
        className="mb-4 inline-flex items-center gap-1 text-xs text-ink-500 hover:text-ink-900 dark:hover:text-ink-100"
      >
        <ChevronLeft className="h-3 w-3" /> Home
      </Link>

      {data.pageCount === 0 ? (
        <>
          <TagNameplate
            tag={data.tag}
            tags={data.tags}
            description={
              (data.tags?.length ?? 0) > 1
                ? 'No articles match this combination yet. As pages pick up all of these tags, they will land here.'
                : 'No articles yet. As emails matching this tag arrive, they will land here.'
            }
            isFeatured={isFeatured}
            onPin={() => pin.mutate()}
            onUnpin={() => unpin.mutate()}
            pinPending={pin.isPending}
            unpinPending={unpin.isPending}
          />
          <div className="card mt-6 text-center text-ink-500">No pages match this combination.</div>
        </>
      ) : (
        <div className="grid gap-8 lg:grid-cols-[1fr_260px]">
          <div className="min-w-0 space-y-6">
            <DigestNameplate
              tag={tag}
              digest={data.digest}
              onRegen={() => regenDigest.mutate()}
              regenPending={regenDigest.isPending}
            />
            <div className="space-y-3">
              {data.pages.map((p) => (
                <PageRow key={p._id} page={p} />
              ))}
            </div>
          </div>

          <aside className="space-y-4">
            <TagNameplate
              tag={data.tag}
              tags={data.tags}
              description={
                (data.tags?.length ?? 0) > 1
                  ? `${data.pageCount} page${data.pageCount === 1 ? '' : 's'} carry every one of these tags, aggregated from ${data.totalEmails} source email${data.totalEmails === 1 ? '' : 's'}.`
                  : `Articles tagged or extracted with #${data.tag}, aggregated from ${data.totalEmails} source email${data.totalEmails === 1 ? '' : 's'}.`
              }
              isFeatured={isFeatured}
              onPin={() => pin.mutate()}
              onUnpin={() => unpin.mutate()}
              pinPending={pin.isPending}
              unpinPending={unpin.isPending}
            />
            {data.topSenders.length > 0 && (
              <div className="card">
                <div className="mb-3 flex items-center gap-2 text-xs uppercase tracking-widest text-ink-500">
                  <Users className="h-3.5 w-3.5" /> Top senders
                </div>
                <ul className="space-y-1.5 text-sm">
                  {data.topSenders.map((s) => {
                    const inner = (
                      <>
                        <span
                          className="truncate font-medium text-ink-800 dark:text-ink-100"
                          title={s.address}
                        >
                          {s.name}
                        </span>
                        <span className="shrink-0 text-xs text-ink-500">
                          {s.pageCount}
                        </span>
                      </>
                    );
                    return (
                      <li key={s.address}>
                        {s.brandKey ? (
                          <Link
                            to={`/s/${encodeURIComponent(s.brandKey)}`}
                            className="flex items-center justify-between gap-2 rounded px-1 py-0.5 hover:bg-ink-100 hover:text-rose-700 dark:hover:bg-ink-800 dark:hover:text-rose-300"
                          >
                            {inner}
                          </Link>
                        ) : (
                          <div className="flex items-center justify-between gap-2 px-1 py-0.5">
                            {inner}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            {data.relatedTags.length > 0 && (
              <div className="card">
                <div className="mb-3 flex items-center gap-2 text-xs uppercase tracking-widest text-ink-500">
                  <Network className="h-3.5 w-3.5" /> Co-occurring tags
                </div>
                <p className="mb-2 text-[11px] text-ink-500">
                  Click <strong>+</strong> to combine with the current view
                  ({(data.tags ?? [data.tag]).map((t) => `#${t}`).join(' + ')}).
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {data.relatedTags.map((t) => {
                    const current = data.tags ?? [data.tag];
                    const intersect = [...new Set([...current, t.tag])].join('+');
                    return (
                      <span
                        key={t.tag}
                        className="inline-flex items-center overflow-hidden rounded-full"
                      >
                        <Link
                          to={`/t/${encodeURIComponent(t.tag)}`}
                          className="pill rounded-r-none text-[11px] hover:bg-rose-100 hover:text-rose-800 dark:hover:bg-rose-950/40 dark:hover:text-rose-300"
                          title={`Open #${t.tag} on its own`}
                        >
                          #{t.tag}
                          <span className="ml-1 text-ink-400">{t.count}</span>
                        </Link>
                        <Link
                          to={`/t/${encodeURIComponent(intersect)}`}
                          className="border-l border-ink-200 bg-rose-50 px-2 text-[11px] font-bold text-rose-700 hover:bg-rose-100 dark:border-ink-800 dark:bg-rose-950/30 dark:text-rose-200 dark:hover:bg-rose-950/50"
                          title={`Combine: pages tagged with all of ${[...current, t.tag].map((x) => `#${x}`).join(' + ')}`}
                        >
                          +
                        </Link>
                      </span>
                    );
                  })}
                </div>
              </div>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}

/** Title-case a kebab-style tag for the nameplate heading. */
function titleCaseKebab(s: string): string {
  return s
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function TagNameplate({
  tag,
  tags,
  description,
  isFeatured,
  onPin,
  onUnpin,
  pinPending,
  unpinPending,
}: {
  tag: string;
  /** When length > 1, render as an intersection nameplate. */
  tags?: string[];
  description: string;
  isFeatured: boolean;
  onPin: () => void;
  onUnpin: () => void;
  pinPending: boolean;
  unpinPending: boolean;
}) {
  const isMulti = (tags?.length ?? 0) > 1;
  const heading = isMulti
    ? (tags as string[]).map(titleCaseKebab).join(':')
    : `#${tag}`;
  return (
    <div className="card">
      <div className="flex items-center gap-2 text-xs uppercase tracking-widest text-rose-500">
        <Hash className="h-3.5 w-3.5" />
        {isMulti ? 'Combined view' : 'Tag'}
      </div>
      <h1 className="mt-1 text-2xl font-bold tracking-tight">{heading}</h1>
      {isMulti && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-ink-500">
          <span>Pages tagged with all of:</span>
          {(tags as string[]).map((t) => (
            <Link
              key={t}
              to={`/t/${encodeURIComponent(t)}`}
              className="rounded-full bg-rose-50 px-2 py-0.5 text-rose-700 hover:bg-rose-100 dark:bg-rose-950/30 dark:text-rose-200 dark:hover:bg-rose-950/50"
              title={`Open #${t} on its own`}
            >
              #{t}
            </Link>
          ))}
        </div>
      )}
      {/* Feature-in-newsletter is single-tag only — combined views
          are read-only intersections, not pinnable as a section. */}
      {!isMulti && (
        <div className="mt-2">
          {isFeatured ? (
            <button
              type="button"
              onClick={onUnpin}
              disabled={unpinPending}
              className="inline-flex items-center gap-1.5 rounded-full border border-rose-300 bg-rose-50 px-3 py-1 text-xs font-medium text-rose-800 transition-colors hover:bg-rose-100 disabled:opacity-50 dark:border-rose-800 dark:bg-rose-950/30 dark:text-rose-200 dark:hover:bg-rose-950/50"
              title="Click to unpin from your newsletter"
            >
              <Star className="h-3.5 w-3.5" fill="currentColor" />
              Featured · click to unpin
            </button>
          ) : (
            <button
              type="button"
              onClick={onPin}
              disabled={pinPending}
              className="inline-flex items-center gap-1.5 rounded-full border border-ink-300 px-3 py-1 text-xs font-medium text-ink-700 transition-colors hover:border-rose-400 hover:bg-rose-50 hover:text-rose-700 disabled:opacity-50 dark:border-ink-700 dark:text-ink-200 dark:hover:border-rose-700 dark:hover:bg-rose-950/30 dark:hover:text-rose-200"
              title="Pin this tag as a section in your newsletter"
            >
              <Star className="h-3.5 w-3.5" />
              Feature in newsletter
            </button>
          )}
        </div>
      )}
      <p className="mt-2 text-sm text-ink-500">{description}</p>
    </div>
  );
}

function DigestNameplate({
  tag,
  digest,
  onRegen,
  regenPending,
}: {
  tag: string;
  digest: TagDigestSummary | null;
  onRegen: () => void;
  regenPending: boolean;
}) {
  const dayLabel = digest?.generatedAt
    ? new Date(digest.generatedAt).toLocaleDateString(undefined, {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric',
      })
    : null;

  return (
    <section className="border-t-4 border-double border-ink-900 pt-4 dark:border-ink-100">
      {/* Section nameplate — tiny eyebrow + serif headline + dek. */}
      <div className="border-b-2 border-ink-900 pb-3 dark:border-ink-100">
        <div className="flex items-baseline justify-between gap-3">
          <div className="text-[10px] uppercase tracking-[0.25em] text-ink-500">
            The #{tag} Brief
          </div>
          {dayLabel && (
            <div className="text-[10px] uppercase tracking-widest text-ink-400">
              {dayLabel}
            </div>
          )}
        </div>
        <h2 className="mt-1 font-serif text-3xl font-black leading-tight tracking-tight">
          {digest?.headline || `Quiet day on #${tag}`}
        </h2>
        {digest?.dek && (
          <p className="mt-2 font-serif text-base italic leading-snug text-ink-700 dark:text-ink-200">
            {digest.dek}
          </p>
        )}
      </div>

      {digest?.bodyMd && (
        <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-ink-700 first-letter:font-serif first-letter:text-3xl first-letter:font-bold first-letter:leading-none first-letter:mr-1 first-letter:float-left first-letter:mt-1 dark:text-ink-200">
          {digest.bodyMd}
        </p>
      )}

      {!digest && (
        <p className="mt-3 text-xs italic text-ink-500">
          No section brief written yet today.
        </p>
      )}

      <div className="mt-3 flex items-center justify-end gap-2 text-xs">
        <button
          type="button"
          onClick={onRegen}
          disabled={regenPending}
          className="inline-flex items-center gap-1 text-ink-500 hover:text-rose-700 dark:hover:text-rose-300"
          title="Regenerate today's section brief"
        >
          <Sparkles className={`h-3.5 w-3.5 ${regenPending ? 'animate-pulse' : ''}`} />
          {regenPending ? 'Regenerating…' : "Regenerate today's brief"}
        </button>
      </div>
    </section>
  );
}

function PageRow({ page }: { page: TagPage }) {
  return (
    <Link
      to={`/p/${page.slug}`}
      className="card group block hover:border-rose-300 dark:hover:border-rose-800"
    >
      <div className="flex items-start gap-3">
        {page.heroImageUrl ? (
          <img
            src={page.heroImageUrl}
            alt=""
            className="h-16 w-16 flex-shrink-0 rounded-lg object-cover"
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = 'none';
            }}
          />
        ) : (
          <FileText className="mt-1 h-4 w-4 shrink-0 text-ink-400" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate font-medium group-hover:text-rose-700 dark:group-hover:text-rose-300">
              {page.title}
            </h3>
            {page.priority === 'high' && (
              <Flame className="h-3.5 w-3.5 shrink-0 text-rose-500" />
            )}
            {page.flags?.hasMassMailing && (
              <Megaphone className="h-3.5 w-3.5 shrink-0 text-ink-400" />
            )}
          </div>
          <p className="mt-1 line-clamp-2 text-sm text-ink-500">{page.summary}</p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-ink-500">
            <span>
              {page.sourceEmailIds.length} email{page.sourceEmailIds.length === 1 ? '' : 's'}
            </span>
            {page.senderAddresses[0] && <span>· {page.senderAddresses[0]}</span>}
            {page.senderAddresses.length > 1 && (
              <span className="text-ink-400">+{page.senderAddresses.length - 1} more</span>
            )}
            <span className="ml-auto">{new Date(page.updatedAt).toLocaleDateString()}</span>
          </div>
        </div>
      </div>
    </Link>
  );
}
