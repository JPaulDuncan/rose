import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Upload,
  FileText,
  Inbox,
  Flame,
  ShieldAlert,
  Megaphone,
  TrendingUp,
  Users,
  Tag as TagIcon,
  Calendar,
  ChevronRight,
  ChevronLeft,
  Star,
  Plus,
  X,
  MapPin,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useApi } from '../lib/api';

type DigestPage = {
  _id: string;
  slug: string;
  title: string;
  summary: string;
  tags: string[];
  priority: 'high' | 'normal' | 'low';
  spamScore: number;
  flags: { hasLikelySpam?: boolean; hasMassMailing?: boolean; isSparse?: boolean };
  sourceEmailIds: string[];
  senderAddresses: string[];
  topics: string[];
  heroImageUrl?: string | null;
  updatedAt: string;
  createdAt: string;
  version: number;
};

type Digest = {
  edition: { date: string; label: string };
  stats: {
    totalPages: number;
    totalEmails: number;
    newToday: number;
    spam: number;
    highPriority: number;
  };
  lead: DigestPage | null;
  buckets: { label: string; pages: DigestPage[] }[];
  topSenders: { address: string; pageCount: number }[];
  topTopics: { topic: string; count: number }[];
  featuredTags: string[];
  featuredSections: { tag: string; pageCount: number; pages: DigestPage[] }[];
};

export default function HomePage() {
  const api = useApi();
  const { data, isLoading } = useQuery({
    queryKey: ['digest'],
    queryFn: () => api.get<Digest>('/api/digest'),
    refetchInterval: 30_000,
  });

  if (isLoading) {
    return <div className="px-6 py-10 text-ink-500">Loading edition…</div>;
  }
  if (!data || data.stats.totalPages === 0) {
    return (
      <div className="mx-auto w-full max-w-6xl px-6 py-10">
        <div className="card flex flex-col items-center justify-center gap-3 py-16 text-center">
          <Inbox className="h-10 w-10 text-rose-500" />
          <div>
            <h3 className="font-semibold">No edition yet</h3>
            <p className="text-sm text-ink-500">
              Upload an email or connect a source. Each pass through the worker
              produces a wiki entry, and Today's Edition assembles them here.
            </p>
          </div>
          <div className="flex gap-2">
            <Link to="/inbox?upload=1" className="btn-primary">
              <Upload className="h-4 w-4" /> Upload email
            </Link>
            <Link to="/settings/sources" className="btn-secondary">
              Connect a source
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const populated = data.buckets.filter((b) => b.pages.length > 0);

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-10">
      <Masthead edition={data.edition} stats={data.stats} />
      <WeatherCard />

      <div className="grid gap-8 lg:grid-cols-[1fr_280px]">
        <div className="min-w-0 space-y-10">
          {data.lead && <LeadStory page={data.lead} />}
          <UpcomingEvents />
          {data.featuredSections.length > 0 && (
            <FeaturedSections sections={data.featuredSections} excludeId={data.lead?._id} />
          )}
          <TableOfContents buckets={populated} />
          {populated.map((b) => (
            <BucketSection key={b.label} bucket={b} excludeId={data.lead?._id} />
          ))}
          {data.stats.spam > 0 && (
            <div className="card flex items-center gap-3 text-sm">
              <ShieldAlert className="h-5 w-5 shrink-0 text-red-500" />
              <span className="flex-1">
                <strong>{data.stats.spam}</strong> page
                {data.stats.spam === 1 ? ' was' : 's were'} flagged as likely spam and
                hidden from this edition.
              </span>
              <Link
                to="/search?q=spam"
                className="btn-ghost text-xs"
                title="Open in search"
              >
                review
              </Link>
            </div>
          )}
        </div>

        <aside className="space-y-6">
          <FeaturedTagsWidget featuredTags={data.featuredTags} />
          <Sidebar
            topSenders={data.topSenders}
            topTopics={data.topTopics}
            stats={data.stats}
          />
        </aside>
      </div>
    </div>
  );
}

function Masthead({
  edition,
  stats,
}: {
  edition: Digest['edition'];
  stats: Digest['stats'];
}) {
  return (
    <header className="mb-8 border-b border-ink-200 pb-6 dark:border-ink-800">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-xs uppercase tracking-widest text-rose-500">
            Today's Edition
          </div>
          <h1 className="mt-1 text-4xl font-bold tracking-tight">The Rose Digest</h1>
          <div className="mt-1 flex items-center gap-1 text-sm text-ink-500">
            <Calendar className="h-3.5 w-3.5" />
            {edition.label}
          </div>
        </div>
        <div className="flex flex-wrap gap-4 text-xs text-ink-500">
          <Stat label="pages" value={stats.totalPages} />
          <Stat label="emails" value={stats.totalEmails} />
          <Stat label="new today" value={stats.newToday} accent={stats.newToday > 0} />
          {stats.highPriority > 0 && (
            <Stat label="urgent" value={stats.highPriority} tone="rose" />
          )}
        </div>
      </div>
    </header>
  );
}

function Stat({
  label,
  value,
  accent,
  tone,
}: {
  label: string;
  value: number;
  accent?: boolean;
  tone?: 'rose';
}) {
  const cls =
    tone === 'rose'
      ? 'text-rose-600 dark:text-rose-400'
      : accent
        ? 'text-ink-900 dark:text-ink-50'
        : 'text-ink-500';
  return (
    <div className="text-right">
      <div className={`text-lg font-semibold ${cls}`}>{value}</div>
      <div className="uppercase tracking-wide">{label}</div>
    </div>
  );
}

function LeadStory({ page }: { page: DigestPage }) {
  return (
    <Link
      to={`/p/${page.slug}`}
      className="group block overflow-hidden rounded-2xl border border-rose-200 bg-gradient-to-br from-rose-50 to-white shadow-soft transition-all hover:border-rose-400 hover:shadow-lg dark:border-rose-900/50 dark:from-rose-950/20 dark:to-ink-900"
    >
      {page.heroImageUrl && (
        <SafeImage
          src={page.heroImageUrl}
          alt={page.title}
          className="block max-h-72 w-full object-cover"
        />
      )}
      <div className={page.heroImageUrl ? 'p-6' : 'p-6'}>
      <div className="mb-2 flex items-center gap-2 text-xs uppercase tracking-widest text-rose-600 dark:text-rose-300">
        <Flame className="h-3.5 w-3.5" />
        Top story
      </div>
      <h2 className="font-serif text-3xl font-bold leading-tight tracking-tight group-hover:text-rose-700 dark:group-hover:text-rose-300">
        {page.title}
      </h2>
      {page.senderAddresses[0] && (
        <div className="mt-1 text-[11px] uppercase tracking-wide text-ink-500">
          By {page.senderAddresses[0]}
          {page.senderAddresses.length > 1 && (
            <span className="text-ink-400"> · +{page.senderAddresses.length - 1} other senders</span>
          )}
        </div>
      )}
      <p className="mt-3 text-base leading-relaxed text-ink-700 dark:text-ink-200">
        {page.summary}
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
        <PageBadges page={page} />
        <span className="text-ink-500">
          {page.sourceEmailIds.length} source email
          {page.sourceEmailIds.length === 1 ? '' : 's'}
        </span>
        {page.senderAddresses[0] && (
          <span className="text-ink-500">· from {page.senderAddresses[0]}</span>
        )}
        <span className="ml-auto inline-flex items-center gap-1 font-medium text-rose-600 group-hover:gap-2 dark:text-rose-300">
          Read <ChevronRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" />
        </span>
      </div>
      </div>
    </Link>
  );
}

function SafeImage({
  src,
  alt,
  className,
}: {
  src: string;
  alt: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <img
      src={src}
      alt={alt}
      className={className}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}

function TableOfContents({ buckets }: { buckets: Digest['buckets'] }) {
  if (!buckets.length) return null;
  return (
    <nav className="rounded-xl border border-ink-200 bg-white p-4 text-sm dark:border-ink-800 dark:bg-ink-900">
      <div className="mb-2 flex items-center gap-2 text-xs uppercase tracking-widest text-ink-500">
        <FileText className="h-3.5 w-3.5" />
        In this edition
      </div>
      <ul className="grid gap-1 sm:grid-cols-2">
        {buckets.map((b) => (
          <li key={b.label}>
            <a
              href={`#bucket-${slugifyAnchor(b.label)}`}
              className="flex items-center justify-between rounded-md px-2 py-1 hover:bg-ink-100 dark:hover:bg-ink-800"
            >
              <span>{b.label}</span>
              <span className="text-xs text-ink-500">{b.pages.length}</span>
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function BucketSection({
  bucket,
  excludeId,
}: {
  bucket: { label: string; pages: DigestPage[] };
  excludeId?: string;
}) {
  const pages = bucket.pages.filter((p) => p._id !== excludeId);
  if (pages.length === 0) return null;
  return (
    <section id={`bucket-${slugifyAnchor(bucket.label)}`}>
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-widest text-ink-500">
          {bucket.label}
        </h2>
        <div className="h-px flex-1 bg-ink-200 dark:bg-ink-800" />
        <span className="text-xs text-ink-400">{pages.length}</span>
      </div>
      <div className="gap-3 sm:columns-2 xl:columns-3 [&>*]:mb-3">
        {pages.map((p) => (
          <div key={p._id} className="break-inside-avoid">
            <PageCard page={p} />
          </div>
        ))}
      </div>
    </section>
  );
}

function PageCard({ page }: { page: DigestPage }) {
  const navigate = useNavigate();
  return (
    <Link
      to={`/p/${page.slug}`}
      className="group flex flex-col overflow-hidden rounded-xl border border-ink-200 bg-white transition-colors hover:border-rose-300 dark:border-ink-800 dark:bg-ink-900 dark:hover:border-rose-800"
    >
      {page.heroImageUrl && (
        <SafeImage
          src={page.heroImageUrl}
          alt={page.title}
          className="block aspect-[16/8] w-full object-cover"
        />
      )}
      <div className="flex flex-col p-4">
      <div className="flex items-start gap-2">
        {!page.heroImageUrl && <FileText className="mt-0.5 h-4 w-4 shrink-0 text-ink-400" />}
        <div className="min-w-0 flex-1">
          <h3 className="font-serif text-base font-semibold leading-snug group-hover:text-rose-700 dark:group-hover:text-rose-300">
            {page.title}
          </h3>
          {(page.senderAddresses?.[0] || page.sourceEmailIds.length > 0) && (
            <div className="mt-0.5 text-[11px] uppercase tracking-wide text-ink-500">
              {page.senderAddresses?.[0] && (
                <span>By {page.senderAddresses[0]}</span>
              )}
              {page.senderAddresses && page.senderAddresses.length > 1 && (
                <span className="text-ink-400"> +{page.senderAddresses.length - 1}</span>
              )}
              {page.sourceEmailIds.length > 0 && (
                <span className="text-ink-400">
                  {' '}· {page.sourceEmailIds.length} msg
                  {page.sourceEmailIds.length === 1 ? '' : 's'}
                </span>
              )}
            </div>
          )}
          <p className="mt-1.5 line-clamp-3 text-sm text-ink-600 dark:text-ink-300">
            {page.summary}
          </p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs">
        <PageBadges page={page} compact />
        {page.tags.slice(0, 2).map((t) => (
          <button
            key={t}
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              navigate(`/t/${encodeURIComponent(t)}`);
            }}
            className="pill text-[10px] hover:bg-rose-100 hover:text-rose-800 dark:hover:bg-rose-950/40 dark:hover:text-rose-300"
          >
            #{t}
          </button>
        ))}
        <span className="ml-auto text-ink-400">
          {timeAgo(page.updatedAt)}
        </span>
      </div>
      </div>
    </Link>
  );
}

function PageBadges({ page, compact }: { page: DigestPage; compact?: boolean }) {
  const size = compact ? 'h-3 w-3' : 'h-3.5 w-3.5';
  return (
    <>
      {page.priority === 'high' && (
        <span className="inline-flex items-center gap-1 rounded bg-rose-100 px-1.5 py-0.5 font-medium text-rose-800 dark:bg-rose-950/40 dark:text-rose-300">
          <Flame className={size} /> high
        </span>
      )}
      {page.flags?.hasMassMailing && !page.flags?.hasLikelySpam && (
        <span className="inline-flex items-center gap-1 rounded bg-ink-100 px-1.5 py-0.5 text-ink-600 dark:bg-ink-800 dark:text-ink-300">
          <Megaphone className={size} /> bulk
        </span>
      )}
      {page.sourceEmailIds.length >= 3 && (
        <span className="rounded bg-ink-100 px-1.5 py-0.5 text-ink-600 dark:bg-ink-800 dark:text-ink-300">
          {page.sourceEmailIds.length}× messages
        </span>
      )}
    </>
  );
}

function Sidebar({
  topSenders,
  topTopics,
  stats,
}: {
  topSenders: Digest['topSenders'];
  topTopics: Digest['topTopics'];
  stats: Digest['stats'];
}) {
  return (
    <>
      <div className="card">
        <div className="mb-3 flex items-center gap-2 text-xs uppercase tracking-widest text-ink-500">
          <TrendingUp className="h-3.5 w-3.5" />
          At a glance
        </div>
        <ul className="space-y-1.5 text-sm">
          <li className="flex justify-between">
            <span className="text-ink-500">Wiki pages</span>
            <span className="font-medium">{stats.totalPages}</span>
          </li>
          <li className="flex justify-between">
            <span className="text-ink-500">Source emails</span>
            <span className="font-medium">{stats.totalEmails}</span>
          </li>
          <li className="flex justify-between">
            <span className="text-ink-500">Updated today</span>
            <span className="font-medium">{stats.newToday}</span>
          </li>
          <li className="flex justify-between">
            <span className="text-ink-500">High priority</span>
            <span className="font-medium">{stats.highPriority}</span>
          </li>
          <li className="flex justify-between text-red-600 dark:text-red-400">
            <span>Spam (hidden)</span>
            <span className="font-medium">{stats.spam}</span>
          </li>
        </ul>
      </div>

      {topSenders.length > 0 && (
        <div className="card">
          <div className="mb-3 flex items-center gap-2 text-xs uppercase tracking-widest text-ink-500">
            <Users className="h-3.5 w-3.5" />
            Top senders
          </div>
          <ul className="space-y-1.5 text-sm">
            {topSenders.map((s) => (
              <li key={s.address} className="flex items-center justify-between gap-2">
                <code
                  className="truncate text-xs text-ink-700 dark:text-ink-200"
                  title={s.address}
                >
                  {s.address}
                </code>
                <span className="shrink-0 text-xs text-ink-500">
                  {s.pageCount} page{s.pageCount === 1 ? '' : 's'}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {topTopics.length > 0 && (
        <div className="card">
          <div className="mb-3 flex items-center gap-2 text-xs uppercase tracking-widest text-ink-500">
            <TagIcon className="h-3.5 w-3.5" />
            Trending topics
          </div>
          <div className="flex flex-wrap gap-1.5">
            {topTopics.map((t) => (
              <Link
                key={t.topic}
                to={`/t/${encodeURIComponent(t.topic)}`}
                className="pill text-[11px] hover:bg-rose-100 hover:text-rose-800 dark:hover:bg-rose-950/40 dark:hover:text-rose-300"
              >
                {t.topic}
                <span className="ml-1 text-ink-400">{t.count}</span>
              </Link>
            ))}
          </div>
        </div>
      )}

      <div className="card">
        <Link to="/inbox?upload=1" className="btn-primary w-full justify-center">
          <Upload className="h-4 w-4" /> Upload email
        </Link>
      </div>
    </>
  );
}

function timeAgo(iso: string): string {
  const t = new Date(iso).getTime();
  const diff = Date.now() - t;
  const m = Math.round(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

function slugifyAnchor(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function FeaturedSections({
  sections,
  excludeId,
}: {
  sections: { tag: string; pageCount: number; pages: DigestPage[] }[];
  excludeId?: string;
}) {
  return (
    <div className="space-y-12 border-t-4 border-double border-ink-900 pt-8 dark:border-ink-100">
      {sections.map((s) => {
        const pages = s.pages.filter((p) => p._id !== excludeId);
        const lead = pages[0];
        const rest = pages.slice(1);
        return (
          <section
            key={s.tag}
            id={`featured-${slugifyAnchor(s.tag)}`}
            className="space-y-5"
          >
            {/* Newspaper-style section nameplate */}
            <div className="border-b-2 border-ink-900 pb-2 dark:border-ink-100">
              <div className="text-[10px] uppercase tracking-[0.25em] text-ink-500">
                Section
              </div>
              <div className="mt-0.5 flex items-baseline justify-between gap-4">
                <Link
                  to={`/t/${encodeURIComponent(s.tag)}`}
                  className="font-serif text-4xl font-black leading-none tracking-tight hover:text-rose-700 dark:hover:text-rose-300"
                >
                  #{s.tag}
                </Link>
                <Link
                  to={`/t/${encodeURIComponent(s.tag)}`}
                  className="shrink-0 text-[11px] uppercase tracking-widest text-ink-500 hover:text-ink-900 dark:hover:text-ink-100"
                >
                  {s.pageCount} {s.pageCount === 1 ? 'story' : 'stories'} ·{' '}
                  <span className="font-medium text-rose-600 dark:text-rose-300">
                    See all →
                  </span>
                </Link>
              </div>
            </div>

            {pages.length === 0 ? (
              <p className="text-xs italic text-ink-500">No recent dispatches in this section.</p>
            ) : (
              <>
                {lead && <FeatureLead page={lead} />}
                {rest.length > 0 && (
                  <>
                    <div className="border-t border-ink-200 dark:border-ink-800" />
                    <SectionCarousel pages={rest.slice(0, 12)} />
                  </>
                )}
              </>
            )}
          </section>
        );
      })}
    </div>
  );
}

function SectionCarousel({ pages }: { pages: DigestPage[] }) {
  const trackRef = useRef<HTMLDivElement>(null);

  function scrollByCard(direction: -1 | 1) {
    const el = trackRef.current;
    if (!el) return;
    // Scroll by ~ one card width so each click advances by one item.
    const card = el.querySelector<HTMLElement>('[data-carousel-item]');
    const step = card ? card.offsetWidth + 16 /* gap */ : el.clientWidth * 0.8;
    el.scrollBy({ left: direction * step, behavior: 'smooth' });
  }

  return (
    <div className="relative">
      <div
        ref={trackRef}
        className="flex snap-x snap-mandatory gap-4 overflow-x-auto pb-2 scrollbar-thin"
        style={{ scrollbarWidth: 'thin' }}
      >
        {pages.map((p) => (
          <div
            key={p._id}
            data-carousel-item
            className="w-[280px] shrink-0 snap-start sm:w-[320px]"
          >
            <PageCard page={p} />
          </div>
        ))}
      </div>
      {pages.length > 1 && (
        <>
          <button
            type="button"
            onClick={() => scrollByCard(-1)}
            aria-label="Previous"
            className="absolute -left-3 top-1/2 hidden -translate-y-1/2 rounded-full border border-ink-200 bg-white p-1.5 text-ink-700 shadow-sm hover:bg-rose-50 hover:text-rose-700 sm:flex dark:border-ink-700 dark:bg-ink-900 dark:text-ink-200 dark:hover:bg-rose-950/30 dark:hover:text-rose-300"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => scrollByCard(1)}
            aria-label="Next"
            className="absolute -right-3 top-1/2 hidden -translate-y-1/2 rounded-full border border-ink-200 bg-white p-1.5 text-ink-700 shadow-sm hover:bg-rose-50 hover:text-rose-700 sm:flex dark:border-ink-700 dark:bg-ink-900 dark:text-ink-200 dark:hover:bg-rose-950/30 dark:hover:text-rose-300"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </>
      )}
    </div>
  );
}

function FeatureLead({ page }: { page: DigestPage }) {
  return (
    <Link
      to={`/p/${page.slug}`}
      className="group grid gap-5 md:grid-cols-[3fr_2fr]"
    >
      {page.heroImageUrl ? (
        <div className="overflow-hidden rounded-md border border-ink-200 bg-ink-50 dark:border-ink-800 dark:bg-ink-900">
          <SafeImage
            src={page.heroImageUrl}
            alt={page.title}
            className="aspect-[4/3] w-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
          />
        </div>
      ) : null}
      <div className={page.heroImageUrl ? '' : 'md:col-span-2'}>
        <h3 className="font-serif text-3xl font-bold leading-tight tracking-tight text-ink-900 group-hover:text-rose-700 dark:text-ink-50 dark:group-hover:text-rose-300">
          {page.title}
        </h3>
        {(page.senderAddresses?.[0] || page.sourceEmailIds.length > 0) && (
          <div className="mt-2 text-[11px] uppercase tracking-widest text-ink-500">
            {page.senderAddresses?.[0] && <span>By {page.senderAddresses[0]}</span>}
            {page.senderAddresses && page.senderAddresses.length > 1 && (
              <span className="text-ink-400"> +{page.senderAddresses.length - 1}</span>
            )}
            {page.sourceEmailIds.length > 0 && (
              <span className="text-ink-400">
                {' '}· {page.sourceEmailIds.length} message
                {page.sourceEmailIds.length === 1 ? '' : 's'}
              </span>
            )}
          </div>
        )}
        <p className="mt-3 text-base leading-relaxed text-ink-700 first-letter:font-serif first-letter:text-3xl first-letter:font-bold first-letter:leading-none first-letter:mr-1 first-letter:float-left first-letter:mt-1 dark:text-ink-200">
          {page.summary}
        </p>
      </div>
    </Link>
  );
}

function FeaturedTagsWidget({ featuredTags }: { featuredTags: string[] }) {
  const api = useApi();
  const qc = useQueryClient();
  const [input, setInput] = useState('');

  const { data: directory } = useQuery({
    queryKey: ['tag-directory'],
    queryFn: () => api.get<{ tags: { tag: string; pageCount: number }[] }>('/api/tags'),
  });

  const add = useMutation({
    mutationFn: async (tag: string) =>
      api.post<{ tags: string[] }>('/api/featured-tags', { tag }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['digest'] });
      setInput('');
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: async (tag: string) =>
      api.del<{ tags: string[] }>(`/api/featured-tags/${encodeURIComponent(tag)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['digest'] }),
  });

  const suggestions =
    directory?.tags
      ?.filter((d) => !featuredTags.includes(d.tag))
      ?.slice(0, 8) ?? [];

  return (
    <div className="card">
      <div className="mb-3 flex items-center gap-2 text-xs uppercase tracking-widest text-ink-500">
        <Star className="h-3.5 w-3.5" /> Featured topics
      </div>
      <p className="mb-2 text-xs text-ink-500">
        Pin the tags you care about. Each becomes a section in your edition.
      </p>

      {featuredTags.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {featuredTags.map((t) => (
            <span
              key={t}
              className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2 py-0.5 text-xs font-medium text-rose-800 dark:bg-rose-950/40 dark:text-rose-200"
            >
              #{t}
              <button
                type="button"
                onClick={() => remove.mutate(t)}
                aria-label={`Unpin ${t}`}
                className="-mr-1 ml-0.5 rounded-full p-0.5 hover:bg-rose-200 dark:hover:bg-rose-900/60"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          const v = input.trim().toLowerCase();
          if (!v) return;
          if (featuredTags.includes(v)) {
            toast.error('Already featured');
            return;
          }
          add.mutate(v);
        }}
        className="flex gap-1"
      >
        <input
          className="input text-xs"
          list="featured-tag-suggestions"
          placeholder="add a tag…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <datalist id="featured-tag-suggestions">
          {suggestions.map((s) => (
            <option key={s.tag} value={s.tag}>
              {s.pageCount} page{s.pageCount === 1 ? '' : 's'}
            </option>
          ))}
        </datalist>
        <button
          className="btn-primary text-xs"
          type="submit"
          disabled={add.isPending || !input.trim()}
          aria-label="Pin tag"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </form>

      {suggestions.length > 0 && featuredTags.length < 3 && (
        <div className="mt-3">
          <div className="mb-1 text-[10px] uppercase tracking-widest text-ink-400">
            Suggestions
          </div>
          <div className="flex flex-wrap gap-1">
            {suggestions.slice(0, 6).map((s) => (
              <button
                key={s.tag}
                type="button"
                onClick={() => add.mutate(s.tag)}
                className="pill text-[10px] hover:bg-rose-100 hover:text-rose-800 dark:hover:bg-rose-950/40 dark:hover:text-rose-300"
                title={`${s.pageCount} pages`}
              >
                #{s.tag}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

type WeatherPeriod = {
  number: number;
  name: string;
  temperature: number;
  temperatureUnit: string;
  shortForecast: string;
  windSpeed: string;
  icon?: string;
  isDaytime: boolean;
};

type WeatherOk = {
  configured: true;
  location: { lat: number; lon: number; label: string };
  current: WeatherPeriod | null;
  periods: WeatherPeriod[];
  brief: string;
  fetchedAt: string;
  cached: boolean;
  error?: undefined;
};
type WeatherErr = { configured: true; error: string; message?: string };
type WeatherUnconfigured = { configured: false };
type Weather = WeatherUnconfigured | WeatherOk | WeatherErr;

function WeatherCard() {
  const api = useApi();
  const { data } = useQuery({
    queryKey: ['weather'],
    queryFn: () => api.get<Weather>('/api/weather'),
    refetchInterval: 30 * 60_000,
    staleTime: 5 * 60_000,
  });

  if (!data || data.configured === false) {
    return (
      <div className="-mt-4 mb-8 rounded-xl border border-dashed border-ink-300 px-4 py-3 text-xs text-ink-500 dark:border-ink-700">
        Set your location in{' '}
        <Link
          to="/settings/newsletter"
          className="font-medium text-rose-600 hover:underline dark:text-rose-300"
        >
          Settings → Newsletter
        </Link>{' '}
        to see today's weather here.
      </div>
    );
  }

  if (data.error) {
    const err = data as WeatherErr;
    return (
      <div className="-mt-4 mb-8 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100">
        Weather temporarily unavailable: {err.message ?? err.error}
      </div>
    );
  }

  const ok = data as WeatherOk;
  const cur = ok.current;
  return (
    <section className="-mt-4 mb-8 overflow-hidden rounded-xl border border-ink-200 bg-gradient-to-r from-sky-50 via-white to-rose-50 dark:border-ink-800 dark:from-sky-950/30 dark:via-ink-900 dark:to-rose-950/20">
      <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
        {cur?.icon && (
          <img
            src={cur.icon}
            alt={cur.shortForecast}
            className="h-16 w-16 shrink-0 rounded-lg border border-ink-200 bg-white object-cover dark:border-ink-700"
            referrerPolicy="no-referrer"
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="text-[10px] uppercase tracking-widest text-ink-500">
            Forecast for {ok.location.label}
          </div>
          {cur && (
            <div className="mt-0.5 flex items-baseline gap-2">
              <span className="font-serif text-3xl font-bold tracking-tight">
                {cur.temperature}°{cur.temperatureUnit}
              </span>
              <span className="text-sm text-ink-700 dark:text-ink-200">
                {cur.shortForecast}
              </span>
              <span className="text-xs text-ink-500">· {cur.windSpeed}</span>
            </div>
          )}
          {ok.brief && (
            <p className="mt-2 text-sm leading-relaxed text-ink-700 dark:text-ink-200">
              {ok.brief}
            </p>
          )}
          {ok.periods.length > 1 && (
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-500">
              {ok.periods.slice(1, 4).map((p: WeatherPeriod) => (
                <span key={p.number}>
                  <span className="font-medium text-ink-700 dark:text-ink-200">{p.name}</span>{' '}
                  {p.temperature}°{p.temperatureUnit} · {p.shortForecast}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

type UpcomingEvent = {
  _id: string;
  title: string;
  start: string;
  end: string | null;
  allDay: boolean;
  location: string | null;
  description: string;
  pageSlug: string | null;
  pageId: string | null;
  sourceEmailId: string;
  sourceFromName: string | null;
  sourceFromAddress: string | null;
  sourceSubject: string | null;
  sourceKind: 'email' | 'rss' | null;
};

function UpcomingEvents() {
  const api = useApi();
  const { data } = useQuery({
    queryKey: ['events-upcoming-newsletter'],
    queryFn: () =>
      api.get<{ events: UpcomingEvent[] }>('/api/events/upcoming?limit=20'),
    refetchInterval: 5 * 60_000,
  });

  if (!data || data.events.length === 0) return null;

  // Group events by calendar day so a single day with N events renders one
  // date header + N stacked rows instead of N repeated date columns.
  const byDay = new Map<string, { date: Date; events: UpcomingEvent[] }>();
  for (const e of data.events) {
    const d = new Date(e.start);
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    const bucket = byDay.get(key);
    if (bucket) bucket.events.push(e);
    else byDay.set(key, { date: d, events: [e] });
  }
  const groups = [...byDay.values()].sort((a, b) => +a.date - +b.date);

  return (
    <section className="space-y-4 border-t-4 border-double border-ink-900 pt-8 dark:border-ink-100">
      <div className="border-b-2 border-ink-900 pb-2 dark:border-ink-100">
        <div className="text-[10px] uppercase tracking-[0.25em] text-ink-500">
          Datebook
        </div>
        <div className="mt-0.5 flex items-baseline justify-between gap-4">
          <h2 className="font-serif text-4xl font-black leading-none tracking-tight">
            The Week Ahead
          </h2>
          <Link
            to="/calendar"
            className="shrink-0 text-[11px] uppercase tracking-widest text-ink-500 hover:text-ink-900 dark:hover:text-ink-100"
          >
            {data.events.length} upcoming ·{' '}
            <span className="font-medium text-rose-600 dark:text-rose-300">
              See calendar →
            </span>
          </Link>
        </div>
      </div>

      <div className="divide-y divide-ink-200 dark:divide-ink-800">
        {groups.map((g) => (
          <DatebookDay key={g.date.toISOString()} date={g.date} events={g.events} />
        ))}
      </div>
    </section>
  );
}

function DatebookDay({ date, events }: { date: Date; events: UpcomingEvent[] }) {
  const dateLabel = date
    .toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    .toUpperCase();
  const weekday = date.toLocaleDateString(undefined, { weekday: 'short' });
  return (
    <div className="grid gap-4 py-4 sm:grid-cols-[120px_1fr]">
      <div className="text-center sm:border-r sm:border-ink-200 sm:pr-4 sm:text-right sm:dark:border-ink-800">
        <div className="font-serif text-2xl font-bold leading-none tracking-tight">
          {dateLabel}
        </div>
        <div className="mt-1 text-[10px] uppercase tracking-widest text-ink-500">
          {weekday}
        </div>
        <div className="mt-1 text-[10px] uppercase tracking-widest text-ink-400">
          {events.length} {events.length === 1 ? 'event' : 'events'}
        </div>
      </div>
      <ul className="min-w-0 space-y-3">
        {events.map((e) => (
          <DatebookRow key={e._id} e={e} />
        ))}
      </ul>
    </div>
  );
}

function DatebookRow({ e }: { e: UpcomingEvent }) {
  const start = new Date(e.start);
  const time = e.allDay
    ? 'All day'
    : start.toLocaleTimeString(undefined, {
        hour: 'numeric',
        minute: start.getMinutes() === 0 ? undefined : '2-digit',
      });
  const senderLabel =
    e.sourceFromName || e.sourceFromAddress || e.sourceSubject || null;
  return (
    <li className="min-w-0">
      <div className="flex items-baseline gap-2">
        <span className="rounded bg-rose-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-rose-800 dark:bg-rose-950/40 dark:text-rose-200">
          {time}
        </span>
        <h3 className="min-w-0 flex-1 truncate font-serif text-lg font-semibold leading-snug">
          {e.title}
        </h3>
      </div>
      {senderLabel && (
        <div className="mt-0.5 truncate text-[11px] uppercase tracking-widest text-ink-500">
          via {senderLabel}
          {e.sourceKind === 'rss' && (
            <span className="ml-1 text-ink-400">· RSS</span>
          )}
        </div>
      )}
      {e.location && (
        <div className="mt-1 inline-flex items-center gap-1 text-xs text-ink-500">
          <MapPin className="h-3 w-3" /> {e.location}
        </div>
      )}
      {e.description && (
        <p className="mt-1 text-sm text-ink-600 line-clamp-2 dark:text-ink-300">
          {e.description}
        </p>
      )}
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs">
        {e.pageSlug && (
          <Link
            to={`/p/${e.pageSlug}`}
            className="font-medium text-rose-600 hover:underline dark:text-rose-300"
          >
            Open wiki page →
          </Link>
        )}
        <Link
          to={`/e/${e.sourceEmailId}`}
          className="text-ink-500 hover:text-ink-900 dark:hover:text-ink-100"
        >
          Source
        </Link>
      </div>
    </li>
  );
}
