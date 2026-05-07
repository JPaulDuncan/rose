import { createContext, useContext, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  FileText,
  Inbox,
  Flame,
  ShieldAlert,
  Megaphone,
  Tag as TagIcon,
  Calendar,
  ChevronRight,
  ChevronLeft,
  Star,
  Plus,
  X,
  MapPin as MapPinIcon,
  CloudSun,
  Flag,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useApi } from '../lib/api';
import { MapInset, type MapPin } from '../components/MapInset';

type DigestPage = {
  _id: string;
  slug: string;
  title: string;
  summary: string;
  tags: string[];
  priority: 'high' | 'normal' | 'low';
  spamScore: number;
  flags: {
    hasLikelySpam?: boolean;
    hasMassMailing?: boolean;
    isSparse?: boolean;
    isNotificationStream?: boolean;
  };
  sourceEmailIds: string[];
  senderAddresses: string[];
  topics: string[];
  heroImageUrl?: string | null;
  groupingMode?: string;
  primaryTopic?: string | null;
  updatedAt: string;
  createdAt: string;
  articleDate?: string | null;
  version: number;
  wordCount?: number;
  pullQuote?: string | null;
};

type SenderBrand = {
  brandKey: string;
  name: string;
  domain: string | null;
  logoUrl: string | null;
};

/**
 * Co-located context that lets every PageCard / FeatureLead reach into
 * the sender-brand index returned with the digest, without prop-drilling
 * through every section + bucket level of the newsletter layout.
 */
const BrandIndexContext = createContext<Record<string, SenderBrand>>({});

function useBrandFor(address: string | undefined | null): SenderBrand | null {
  const idx = useContext(BrandIndexContext);
  if (!address) return null;
  return idx[address.toLowerCase()] ?? null;
}

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
  topStories: { lead: DigestPage | null; secondaries: DigestPage[] };
  mostRead: DigestPage[];
  buckets: { label: string; pages: DigestPage[] }[];
  topSenders: { address: string; pageCount: number }[];
  topTopics: { topic: string; count: number }[];
  featuredTags: string[];
  featuredSections: {
    tag: string;
    pageCount: number;
    pages: DigestPage[];
    digest: {
      headline: string;
      dek: string;
      bodyMd: string;
      generatedAt: string | null;
      dayKey: string;
    } | null;
  }[];
  senderBrands: Record<string, SenderBrand>;
  showMoonPhases?: boolean;
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
              Connect a mail source to get started. Each email flows
              through the worker into an article, and Today's Edition
              assembles them here.
            </p>
          </div>
          <Link to="/settings/sources" className="btn-primary">
            Connect a source
          </Link>
        </div>
      </div>
    );
  }

  const populated = data.buckets.filter((b) => b.pages.length > 0);
  const brandIndex = data.senderBrands ?? {};
  // Pages already shown as the Top Story or in the "Most Read" rail
  // get suppressed from downstream sections so we don't repeat the
  // same headline. Secondaries are no longer rendered as part of Top
  // Stories — they flow naturally into Breaking News / Most Read /
  // More News, so we don't pre-suppress them.
  const suppressIds = new Set<string>(
    [
      data.topStories?.lead?._id,
      ...(data.mostRead ?? []).map((p) => p._id),
    ].filter(Boolean) as string[],
  );

  // Pool of pages the BreakingNews card scans for today's high-
  // priority dispatches. The lead is excluded so the lead headline
  // doesn't also appear under Breaking — it's already prominent in
  // the middle column. Secondaries DO flow in: they're prime
  // breaking-news candidates.
  const breakingPool: DigestPage[] = [
    ...(data.topStories?.secondaries ?? []),
    ...populated.flatMap((b) => b.pages),
  ];

  return (
    <BrandIndexContext.Provider value={brandIndex}>
    <div className="mx-auto w-full max-w-7xl px-6 py-10">
      <Masthead edition={data.edition} stats={data.stats} />

      {/* Two-panel layout: main column flexes, right rail is a fixed
          300 px so the moon / weather / upcoming widgets stay
          legible regardless of viewport. (Pure 90/10 was tried and
          left the rail too narrow to fit the weather card.) Stacks
          to a single column at <lg so the rail flows naturally
          below the body on mobile. The right rail is `sticky` from
          below the top bar, so the left column scrolls independently
          while pinned widgets stay visible. items-start prevents the
          grid from stretching the aside to match the main column's
          height. */}
      <div className="mt-10 grid items-start gap-6 lg:grid-cols-[1fr_300px]">
        <div className="min-w-0 space-y-10">
          {data.topStories && data.topStories.lead && (
            <TopStories lead={data.topStories.lead} />
          )}
          <BreakingCarousel pages={breakingPool} />
          {data.featuredSections.length > 0 && (
            <FeaturedSections
              sections={data.featuredSections}
              suppressIds={suppressIds}
            />
          )}
          <MoreNews buckets={populated} suppressIds={suppressIds} />
        </div>

        {/* Sticky from below the top bar so pinned widgets stay
            visible while the main column scrolls. No max-height /
            overflow on purpose — when the rail's content fits the
            viewport it pins; when it's taller than the viewport it
            naturally scrolls with the page (sticky has nothing to
            stick against at that point). Either way: no second
            scrollbar. */}
        <aside className="space-y-6 lg:sticky lg:top-20">
          <MoonPhaseCard show={!!data.showMoonPhases} />
          <WeatherCard compact />
          <UpcomingEvents />
          <Sidebar topTopics={data.topTopics} />
        </aside>
      </div>

      {data.stats.spam > 0 && (
        <div className="card mt-8 flex items-center gap-3 text-sm">
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
    </BrandIndexContext.Provider>
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

// ── Newsroom building blocks ────────────────────────────────────────

/**
 * The label that sits above a headline in real online newsrooms — small
 * caps, letter-spaced, sometimes colored (red for breaking, neutral for
 * analysis). Driven by the page's flags + priority + primary tag, with
 * a stable precedence so the same page always gets the same eyebrow.
 */
function eyebrowFor(page: DigestPage): { label: string; tone: 'breaking' | 'feature' | 'analysis' | 'opinion' | 'brief' | 'topic' } {
  if (page.flags?.isNotificationStream) return { label: 'Live · Stream', tone: 'breaking' };
  if (page.priority === 'high') return { label: 'Breaking', tone: 'breaking' };
  if (page.flags?.hasMassMailing) return { label: 'Newsletter', tone: 'brief' };
  if (page.groupingMode === 'topic' && page.primaryTopic) {
    return { label: page.primaryTopic, tone: 'topic' };
  }
  if ((page.wordCount ?? 0) > 600) return { label: 'Feature', tone: 'feature' };
  if ((page.sourceEmailIds?.length ?? 0) > 5) return { label: 'Analysis', tone: 'analysis' };
  return { label: 'Brief', tone: 'brief' };
}

function Eyebrow({ page, size = 'sm' }: { page: DigestPage; size?: 'sm' | 'md' }) {
  const { label, tone } = eyebrowFor(page);
  const toneCls =
    tone === 'breaking'
      ? 'text-red-600 dark:text-red-400'
      : tone === 'feature'
        ? 'text-rose-600 dark:text-rose-300'
        : tone === 'opinion'
          ? 'text-amber-700 dark:text-amber-300'
          : tone === 'topic'
            ? 'text-rose-700 dark:text-rose-200'
            : 'text-ink-500';
  const sizeCls = size === 'md' ? 'text-[11px]' : 'text-[10px]';
  return (
    <div
      className={`flex items-center gap-2 font-semibold uppercase tracking-[0.25em] ${sizeCls} ${toneCls}`}
    >
      {tone === 'breaking' && (
        <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-red-500" />
      )}
      <span>{label}</span>
    </div>
  );
}

/**
 * Approximate read time using ~220 wpm. Skipped when wordCount is
 * missing (e.g. older payloads without the new field). For very short
 * pages we say "~1 min" rather than "0 min".
 */
function readTime(wordCount: number | undefined): string | null {
  if (!wordCount || wordCount < 30) return null;
  const minutes = Math.max(1, Math.round(wordCount / 220));
  return `${minutes} min read`;
}

function Byline({
  page,
  size = 'sm',
}: {
  page: DigestPage;
  size?: 'sm' | 'md';
}) {
  const navigate = useNavigate();
  const primary = page.senderAddresses?.[0];
  const brand = useBrandFor(primary);
  const senderLabel = brand?.name ?? primary;
  const senderHref = brand ? `/s/${encodeURIComponent(brand.brandKey)}` : null;
  const rt = readTime(page.wordCount);
  const sizeCls = size === 'md' ? 'text-xs' : 'text-[11px]';
  if (!senderLabel && !rt) return null;
  return (
    <div
      className={`flex flex-wrap items-center gap-2 uppercase tracking-widest text-ink-500 ${sizeCls}`}
    >
      {senderHref && senderLabel ? (
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            navigate(senderHref);
          }}
          className="inline-flex items-center gap-1.5 rounded hover:text-rose-700 dark:hover:text-rose-300"
          title={`Open ${senderLabel}'s page`}
        >
          {primary && <BrandChip address={primary} size={size === 'md' ? 'lg' : 'sm'} />}
          <span className="truncate">By {senderLabel}</span>
        </button>
      ) : senderLabel ? (
        <span className="inline-flex items-center gap-1.5">
          {primary && <BrandChip address={primary} size={size === 'md' ? 'lg' : 'sm'} />}
          <span className="truncate">By {senderLabel}</span>
        </span>
      ) : null}
      {rt && <span className="text-ink-400">· {rt}</span>}
    </div>
  );
}

/**
 * The "Top Stories" hero block — lead headline (left, ~60%) plus a
 * stacked column of ranked secondary stories (right, ~40%) and a small
 * "Most Read" rail beneath. Mirrors NYT/WaPo/Atlantic above-the-fold.
 */
/**
 * Single Top Story at the top of the middle column. Replaces the
 * previous full-width hero block; secondaries are gone since the
 * other "breaking" stories surface naturally in the Breaking News
 * card (col 1), Most Read (col 1), and the latest-stories rivers
 * (MoreNews, col 2). Newspaper-style nameplate above the lede so it
 * still reads as the day's marquee story.
 */
function TopStories({ lead }: { lead: DigestPage }) {
  return (
    <section className="border-t-4 border-double border-ink-900 pt-6 dark:border-ink-100">
      <div className="mb-4 flex items-baseline justify-between gap-4 border-b border-ink-300 pb-2 dark:border-ink-700">
        <h2 className="font-serif text-xl font-black uppercase tracking-[0.2em]">
          Top Story
        </h2>
        <span className="text-[10px] uppercase tracking-widest text-ink-500">
          The Edition
        </span>
      </div>
      <HeroLead page={lead} />
    </section>
  );
}

function HeroLead({ page }: { page: DigestPage }) {
  return (
    <Link to={`/p/${page.slug}`} className="group block">
      <Eyebrow page={page} size="md" />
      <h1 className="mt-2 font-serif text-5xl font-black leading-[1.05] tracking-tight text-ink-900 group-hover:text-rose-700 dark:text-ink-50 dark:group-hover:text-rose-300">
        {page.title}
      </h1>
      <div className="mt-3">
        <Byline page={page} size="md" />
      </div>
      {/* Float the hero left so the lede prose wraps around it like a
          newspaper article. Native aspect ratio preserved (no
          object-cover crop, no forced 16:9). On the smallest screens
          we drop the float so the image stacks above the text. */}
      {page.heroImageUrl ? (
        <SafeImage
          src={page.heroImageUrl}
          alt={page.title}
          className="mt-4 block w-full max-w-full rounded-md border border-ink-200 bg-ink-50 transition-transform duration-300 group-hover:scale-[1.01] dark:border-ink-800 dark:bg-ink-900 sm:float-left sm:mr-5 sm:mt-1 sm:w-1/2 sm:max-w-[420px]"
        />
      ) : null}
      <p className="mt-3 text-lg leading-relaxed text-ink-700 first-letter:font-serif first-letter:text-4xl first-letter:font-bold first-letter:leading-none first-letter:mr-1.5 first-letter:float-left first-letter:mt-1 dark:text-ink-200">
        {page.summary}
      </p>
      {page.pullQuote && (
        <blockquote className="mt-5 border-l-4 border-rose-500 pl-4 font-serif text-xl italic leading-snug text-ink-800 dark:border-rose-400 dark:text-ink-100">
          “{page.pullQuote}”
        </blockquote>
      )}
      {/* Clear the float so any sibling sections below don't tuck under
          the still-flowing image when the summary is short. */}
      <div className="clear-both" />
    </Link>
  );
}

/**
 * "Breaking News" left-rail card — surfaces high-priority pages
 * updated within the last 24 hours so the reader sees what's
 * urgent right now. Drawn from the union of TopStories' secondaries
 * + every bucket's pages so the card never misses an important
 * page just because it landed outside the lead.
 *
 * Hidden when nothing's actually high-priority today — keeps the
 * left rail visually quiet on slow days instead of showing an
 * empty "Breaking" box.
 */
/**
 * Breaking-news carousel. Sits between the Top Story and the deeper
 * sections. Horizontal scroll with CSS scroll-snap so it feels
 * carousel-y on touch + scroll, and pager arrows for mouse users.
 * Filters to high-priority pages updated in the last 24h.
 */
function BreakingCarousel({ pages }: { pages: DigestPage[] }) {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const seen = new Set<string>();
  const breaking = pages
    .filter((p) => {
      if (p.priority !== 'high') return false;
      // Article date wins over updatedAt — a high-priority email
      // received yesterday should still surface as "breaking" for
      // 24h after its actual receipt, not 24h after we generated it.
      const when = p.articleDate ?? p.updatedAt;
      const upd = when ? new Date(when).getTime() : 0;
      if (upd < cutoff) return false;
      if (seen.has(p._id)) return false;
      seen.add(p._id);
      return true;
    })
    .sort((a, b) => {
      const at = new Date(a.articleDate ?? a.updatedAt ?? 0).getTime();
      const bt = new Date(b.articleDate ?? b.updatedAt ?? 0).getTime();
      return bt - at;
    })
    .slice(0, 12);
  const scroller = useRef<HTMLDivElement>(null);
  if (breaking.length === 0) return null;

  function scrollBy(dir: 1 | -1) {
    const el = scroller.current;
    if (!el) return;
    // One "card width" plus the gap. The cards are min-w-[280px], so
    // 296 (280 + 16) covers a full step on most layouts.
    el.scrollBy({ left: dir * 296, behavior: 'smooth' });
  }

  return (
    <section className="relative border-y-2 border-double border-red-500/60 py-3 dark:border-red-400/50">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.25em] text-red-600 dark:text-red-400">
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-red-500" />
          Breaking
          <span className="ml-1 text-ink-400">{breaking.length}</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="btn-ghost rounded-full p-1"
            onClick={() => scrollBy(-1)}
            aria-label="Previous"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            className="btn-ghost rounded-full p-1"
            onClick={() => scrollBy(1)}
            aria-label="Next"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div
        ref={scroller}
        className="flex snap-x snap-mandatory gap-4 overflow-x-auto scroll-smooth pb-1"
        style={{ scrollbarWidth: 'thin' }}
      >
        {breaking.map((p) => (
          <Link
            key={p._id}
            to={`/p/${p.slug}`}
            className="group flex min-w-[280px] max-w-[320px] shrink-0 snap-start flex-col overflow-hidden rounded-lg border border-ink-200 bg-white transition-colors hover:border-red-300 dark:border-ink-800 dark:bg-ink-900 dark:hover:border-red-800"
          >
            {p.heroImageUrl && (
              <SafeImage
                src={p.heroImageUrl}
                alt={p.title}
                // Native aspect ratio — no forced crop. Capped via
                // max-h so a portrait photo doesn't dominate the
                // card; centered horizontally, top-aligned so the
                // headline still anchors the bottom.
                className="block w-full max-h-[200px] object-contain bg-ink-50 dark:bg-ink-950"
              />
            )}
            <div className="p-3">
              <div className="flex items-center gap-1.5 text-[9px] uppercase tracking-widest text-red-600 dark:text-red-400">
                <span className="inline-block h-1 w-1 rounded-full bg-red-500" />
                {timeAgo(p.articleDate ?? p.updatedAt)}
              </div>
              <h4 className="mt-1.5 font-serif text-base font-bold leading-snug group-hover:text-rose-700 dark:group-hover:text-rose-300">
                {p.title}
              </h4>
              {p.summary && (
                <p className="mt-1 line-clamp-3 text-xs leading-snug text-ink-600 dark:text-ink-300">
                  {p.summary}
                </p>
              )}
            </div>
          </Link>
        ))}
      </div>
    </section>
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

/**
 * The dense 3-column "More News" grid that lives below the fold. Each
 * date-bucket becomes a section ribbon (TODAY / YESTERDAY / EARLIER /
 * OLDER) with a thin rule across the page; entries below render as
 * compact MiniHeadlines stacked into 3 columns the way newspaper
 * homepages handle their long tail.
 */
function MoreNews({
  buckets,
  suppressIds,
}: {
  buckets: { label: string; pages: DigestPage[] }[];
  suppressIds: Set<string>;
}) {
  const sections = buckets
    .map((b) => ({ label: b.label, pages: b.pages.filter((p) => !suppressIds.has(p._id)) }))
    .filter((b) => b.pages.length > 0);
  if (sections.length === 0) return null;
  return (
    <section className="border-t-4 border-double border-ink-900 pt-8 dark:border-ink-100">
      <div className="mb-6 flex items-baseline justify-between gap-4 border-b border-ink-300 pb-2 dark:border-ink-700">
        <h2 className="font-serif text-xl font-black uppercase tracking-[0.2em]">
          More News
        </h2>
        <span className="text-[10px] uppercase tracking-widest text-ink-500">
          The long tail
        </span>
      </div>
      <div className="space-y-8">
        {sections.map((b) => (
          <BucketRibbon key={b.label} bucket={b} />
        ))}
      </div>
    </section>
  );
}

function BucketRibbon({
  bucket,
}: {
  bucket: { label: string; pages: DigestPage[] };
}) {
  const pages = bucket.pages;
  return (
    <div id={`bucket-${slugifyAnchor(bucket.label)}`}>
      <div className="mb-3 flex items-center gap-3">
        <span className="text-[10px] font-semibold uppercase tracking-[0.3em] text-ink-500">
          {bucket.label}
        </span>
        <div className="h-px flex-1 bg-ink-300 dark:bg-ink-700" />
        <span className="text-[10px] uppercase tracking-widest text-ink-400">
          {pages.length}
        </span>
      </div>
      <ul className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
        {pages.map((p) => (
          <li key={p._id} className="break-inside-avoid border-l border-ink-200 pl-3 dark:border-ink-800">
            <MiniHeadline page={p} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function MiniHeadline({ page }: { page: DigestPage }) {
  return (
    <Link to={`/p/${page.slug}`} className="group block">
      <Eyebrow page={page} />
      <h3 className="mt-1 font-serif text-base font-semibold leading-snug group-hover:text-rose-700 dark:group-hover:text-rose-300">
        {page.title}
      </h3>
      {page.summary && (
        <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-ink-600 dark:text-ink-300">
          {page.summary}
        </p>
      )}
      <div className="mt-1">
        <Byline page={page} />
      </div>
    </Link>
  );
}

function BrandChip({ address, size = 'sm' }: { address: string; size?: 'sm' | 'lg' }) {
  const brand = useBrandFor(address);
  const className = size === 'lg' ? 'h-6 w-6' : 'h-4 w-4';
  if (brand?.logoUrl) {
    return (
      <SafeImage
        src={brand.logoUrl}
        alt={brand.name}
        className={`${className} shrink-0 rounded-sm bg-white object-contain ring-1 ring-ink-200 dark:ring-ink-700`}
      />
    );
  }
  // Fallback initial bubble keeps the row aligned even when we have no logo.
  const initial = (brand?.name ?? address).charAt(0).toUpperCase();
  return (
    <span
      className={`${className} inline-flex shrink-0 items-center justify-center rounded-sm bg-ink-100 text-[10px] font-semibold text-ink-600 ring-1 ring-ink-200 dark:bg-ink-800 dark:text-ink-200 dark:ring-ink-700`}
    >
      {initial}
    </span>
  );
}

function PageCard({ page }: { page: DigestPage }) {
  const navigate = useNavigate();
  const primaryAddress = page.senderAddresses?.[0];
  const brand = useBrandFor(primaryAddress);
  const senderLabel = brand?.name ?? primaryAddress;
  const senderHref = brand
    ? `/s/${encodeURIComponent(brand.brandKey)}`
    : null;
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
          {(senderLabel || page.sourceEmailIds.length > 0) && (
            <div className="mt-0.5 flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-ink-500">
              {senderHref && senderLabel ? (
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    navigate(senderHref);
                  }}
                  className="inline-flex items-center gap-1.5 truncate rounded hover:text-rose-700 dark:hover:text-rose-300"
                  title={`Open ${senderLabel}'s page`}
                >
                  {primaryAddress && <BrandChip address={primaryAddress} />}
                  <span className="truncate">By {senderLabel}</span>
                </button>
              ) : (
                <>
                  {primaryAddress && <BrandChip address={primaryAddress} />}
                  {senderLabel && <span className="truncate">By {senderLabel}</span>}
                </>
              )}
              {page.senderAddresses && page.senderAddresses.length > 1 && (
                <span className="text-ink-400">+{page.senderAddresses.length - 1}</span>
              )}
              {page.sourceEmailIds.length > 0 && (
                <span className="text-ink-400">
                  · {page.sourceEmailIds.length} msg
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
          {timeAgo(page.articleDate ?? page.updatedAt)}
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
  topTopics,
}: {
  topTopics: Digest['topTopics'];
}) {
  const api = useApi();
  // Hide the "Connect a source" CTA once the user has at least one
  // source connected; it's a first-run nudge, not a permanent slot.
  const { data: sources } = useQuery({
    queryKey: ['sources-count'],
    queryFn: () => api.get<{ sources: { _id: string }[] }>('/api/sources'),
  });
  const hasAnySource = (sources?.sources?.length ?? 0) > 0;
  return (
    <>
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

      {!hasAnySource && (
        <div className="card">
          <Link to="/settings/sources" className="btn-primary w-full justify-center">
            <Plus className="h-4 w-4" /> Connect a source
          </Link>
        </div>
      )}
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

type FeaturedSectionDigest = {
  headline: string;
  dek: string;
  bodyMd: string;
  generatedAt: string | null;
  dayKey: string;
};

function FeaturedSections({
  sections,
  suppressIds,
}: {
  sections: {
    tag: string;
    pageCount: number;
    pages: DigestPage[];
    digest?: FeaturedSectionDigest | null;
  }[];
  suppressIds: Set<string>;
}) {
  return (
    <div className="space-y-12 border-t-4 border-double border-ink-900 pt-8 dark:border-ink-100">
      {sections.map((s) => {
        const pages = s.pages.filter((p) => !suppressIds.has(p._id));
        // When a tag-digest exists, it becomes the section's lede —
        // a newspaper section editor's brief, headline + dek + body
        // — and the articles live under it as a carousel of
        // related entries. When there's no digest yet, fall back to
        // the prior lead-page card so the section never empties.
        const digest = s.digest ?? null;
        const lead = pages[0];
        const rest = digest ? pages : pages.slice(1);
        const dayLabel = digest?.generatedAt
          ? new Date(digest.generatedAt).toLocaleDateString(undefined, {
              weekday: 'short',
              month: 'short',
              day: 'numeric',
            })
          : null;
        return (
          <section
            key={s.tag}
            id={`featured-${slugifyAnchor(s.tag)}`}
            className="space-y-5"
          >
            {/* Newspaper-style section nameplate — eyebrow, masthead-style
                heading, "see all" affordance. The digest-driven lede
                replaces the previous "first matching page wins" lead. */}
            <div className="border-b-2 border-ink-900 pb-2 dark:border-ink-100">
              <div className="flex items-baseline justify-between gap-4">
                <div>
                  <div className="text-[10px] uppercase tracking-[0.25em] text-ink-500">
                    The #{s.tag} Brief
                  </div>
                  <Link
                    to={`/t/${encodeURIComponent(s.tag)}`}
                    className="mt-0.5 block font-serif text-3xl font-black leading-tight tracking-tight hover:text-rose-700 dark:hover:text-rose-300"
                  >
                    {digest?.headline || `#${s.tag}`}
                  </Link>
                </div>
                <Link
                  to={`/t/${encodeURIComponent(s.tag)}`}
                  className="shrink-0 text-[11px] uppercase tracking-widest text-ink-500 hover:text-ink-900 dark:hover:text-ink-100"
                  title={dayLabel ? `Section brief for ${dayLabel}` : 'Open the section'}
                >
                  {s.pageCount} {s.pageCount === 1 ? 'story' : 'stories'}
                  {dayLabel && (
                    <>
                      {' '}· <span className="text-ink-400">{dayLabel}</span>
                    </>
                  )}
                  {' '}·{' '}
                  <span className="font-medium text-rose-600 dark:text-rose-300">
                    See all →
                  </span>
                </Link>
              </div>
              {digest?.dek && (
                <p className="mt-2 font-serif text-base italic leading-snug text-ink-700 dark:text-ink-200">
                  {digest.dek}
                </p>
              )}
            </div>

            {digest?.bodyMd ? (
              <div className="md:columns-2 md:gap-8">
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-700 first-letter:font-serif first-letter:text-3xl first-letter:font-bold first-letter:leading-none first-letter:mr-1 first-letter:float-left first-letter:mt-1 dark:text-ink-200">
                  {digest.bodyMd}
                </p>
              </div>
            ) : pages.length === 0 ? (
              <p className="text-xs italic text-ink-500">
                No recent dispatches in this section.
              </p>
            ) : (
              lead && <FeatureLead page={lead} />
            )}

            {rest.length > 0 && (
              <>
                <div className="border-t border-ink-200 dark:border-ink-800" />
                <SectionCarousel pages={rest.slice(0, 12)} />
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
  const navigate = useNavigate();
  const primaryAddress = page.senderAddresses?.[0];
  const brand = useBrandFor(primaryAddress);
  const senderLabel = brand?.name ?? primaryAddress;
  const senderHref = brand
    ? `/s/${encodeURIComponent(brand.brandKey)}`
    : null;
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
        {(senderLabel || page.sourceEmailIds.length > 0) && (
          <div className="mt-2 flex items-center gap-2 text-[11px] uppercase tracking-widest text-ink-500">
            {senderHref && senderLabel ? (
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  navigate(senderHref);
                }}
                className="inline-flex items-center gap-2 hover:text-rose-700 dark:hover:text-rose-300"
                title={`Open ${senderLabel}'s page`}
              >
                {primaryAddress && <BrandChip address={primaryAddress} size="lg" />}
                <span>By {senderLabel}</span>
              </button>
            ) : (
              <>
                {primaryAddress && <BrandChip address={primaryAddress} size="lg" />}
                {senderLabel && <span>By {senderLabel}</span>}
              </>
            )}
            {page.senderAddresses && page.senderAddresses.length > 1 && (
              <span className="text-ink-400">+{page.senderAddresses.length - 1}</span>
            )}
            {page.sourceEmailIds.length > 0 && (
              <span className="text-ink-400">
                · {page.sourceEmailIds.length} message
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

type WeatherSavedLocation = {
  id: string;
  lat: number;
  lon: number;
  label: string;
  primary: boolean;
};
type WeatherOk = {
  configured: true;
  location: WeatherSavedLocation;
  /** Every saved location for this user — drives the switcher chips. */
  locations: WeatherSavedLocation[];
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

type MoonResp = {
  phase: string;
  label: string;
  illumination: number;
  source: 'usno' | 'local';
};

/**
 * Tiny "Moon Phase: xxx" card. Lives above the WeatherCard in the
 * right rail when the user's `showMoonPhases` setting is on. Calls
 * /api/moon, which the API caches (6h TTL) and resolves from USNO
 * with a local-calc fallback so the box always has *something* to
 * show even when USNO is having one of its outages.
 */
function MoonPhaseCard({ show }: { show: boolean }) {
  const api = useApi();
  const { data } = useQuery({
    queryKey: ['moon-phase'],
    queryFn: () => api.get<MoonResp>('/api/moon'),
    refetchInterval: 60 * 60_000,
    staleTime: 30 * 60_000,
    enabled: show,
  });
  if (!show || !data) return null;
  return (
    <Link
      to="/moon"
      className="block rounded-xl border border-ink-200 px-3 py-2 text-sm transition-colors hover:border-rose-300 hover:bg-rose-50/40 dark:border-ink-800 dark:hover:border-rose-800 dark:hover:bg-rose-950/20"
      title={`${Math.round(data.illumination * 100)}% illuminated · source: ${
        data.source === 'usno' ? 'U.S. Naval Observatory' : 'local approximation'
      }`}
    >
      <span className="text-[10px] uppercase tracking-widest text-ink-500">
        Moon Phase:
      </span>{' '}
      <span className="font-medium text-ink-800 dark:text-ink-100">{data.label}</span>
    </Link>
  );
}

function WeatherCard({ compact = false }: { compact?: boolean }) {
  const api = useApi();
  // Selected location id; null = use the user's primary (server picks).
  const [activeId, setActiveId] = useState<string | null>(null);
  const { data } = useQuery({
    queryKey: ['weather', activeId ?? 'primary'],
    queryFn: () =>
      api.get<Weather>(
        activeId ? `/api/weather?id=${encodeURIComponent(activeId)}` : '/api/weather',
      ),
    refetchInterval: 30 * 60_000,
    staleTime: 5 * 60_000,
  });

  // The right-rail "compact" variant drops the wide-format margins and
  // the side-by-side icon layout — everything stacks vertically in a
  // narrow column. The full-bleed variant is preserved for callers
  // that still want it (none today, but the prop keeps the option).
  const wrapper = compact
    ? 'overflow-hidden rounded-xl border border-ink-200 bg-gradient-to-br from-sky-50 via-white to-rose-50 dark:border-ink-800 dark:from-sky-950/30 dark:via-ink-900 dark:to-rose-950/20'
    : '-mt-4 mb-8 overflow-hidden rounded-xl border border-ink-200 bg-gradient-to-r from-sky-50 via-white to-rose-50 dark:border-ink-800 dark:from-sky-950/30 dark:via-ink-900 dark:to-rose-950/20';

  if (!data || data.configured === false) {
    return (
      <div className={
        compact
          ? 'rounded-xl border border-dashed border-ink-300 px-3 py-2.5 text-xs text-ink-500 dark:border-ink-700'
          : '-mt-4 mb-8 rounded-xl border border-dashed border-ink-300 px-4 py-3 text-xs text-ink-500 dark:border-ink-700'
      }>
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
      <div className={
        compact
          ? 'rounded-xl border border-amber-300 bg-amber-50 px-3 py-2.5 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100'
          : '-mt-4 mb-8 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100'
      }>
        Weather temporarily unavailable: {err.message ?? err.error}
      </div>
    );
  }

  const ok = data as WeatherOk;
  const cur = ok.current;

  if (compact) {
    return (
      <section className={wrapper}>
        {/* The card body is a Link to the full weather page. The
            location-switcher chips below are siblings (not children
            of the link) so chip clicks don't trigger navigation. */}
        <Link
          to={`/weather?id=${encodeURIComponent(ok.location.id)}`}
          className="block p-3 transition-colors hover:bg-white/40 dark:hover:bg-ink-900/40"
          title="Open the full weather page"
        >
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-ink-500">
            <CloudSun className="h-3.5 w-3.5 text-rose-500" />
            <span className="truncate">Weather · {ok.location.label}</span>
          </div>
          {cur && (
            <div className="mt-2 flex items-center gap-2">
              {cur.icon && (
                <img
                  src={cur.icon}
                  alt={cur.shortForecast}
                  className="h-10 w-10 shrink-0 rounded border border-ink-200 bg-white object-cover dark:border-ink-700"
                  referrerPolicy="no-referrer"
                />
              )}
              <div className="min-w-0 flex-1">
                <div className="font-serif text-2xl font-bold leading-none tracking-tight">
                  {cur.temperature}°{cur.temperatureUnit}
                </div>
                <div className="mt-0.5 break-words text-xs leading-snug text-ink-700 dark:text-ink-200">
                  {cur.shortForecast}
                </div>
              </div>
            </div>
          )}
          {ok.periods.length > 1 && (
            <ul className="mt-2 space-y-0.5 text-xs text-ink-500">
              {ok.periods.slice(1, 4).map((p: WeatherPeriod) => (
                <li key={p.number} className="flex items-baseline justify-between gap-2">
                  <span className="truncate font-medium text-ink-700 dark:text-ink-200">
                    {p.name}
                  </span>
                  <span className="shrink-0 tabular-nums">
                    {p.temperature}°
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Link>
        {ok.locations && ok.locations.length > 1 && (
          <div className="flex flex-wrap gap-1 px-3 pb-3">
            {ok.locations.map((l) => {
              const isActive = l.id === ok.location.id;
              return (
                <button
                  key={l.id}
                  type="button"
                  onClick={() => setActiveId(l.id)}
                  className={
                    'rounded-full px-2 py-0.5 text-[10px] transition-colors ' +
                    (isActive
                      ? 'bg-rose-600 text-white'
                      : 'bg-white/70 text-ink-700 hover:bg-white dark:bg-ink-900/70 dark:text-ink-200 dark:hover:bg-ink-900')
                  }
                  title={l.label}
                >
                  {l.label.split(',')[0]}
                </button>
              );
            })}
          </div>
        )}
      </section>
    );
  }

  return (
    <section className={wrapper}>
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
          {ok.locations && ok.locations.length > 1 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {ok.locations.map((l) => {
                const isActive = l.id === ok.location.id;
                return (
                  <button
                    key={l.id}
                    type="button"
                    onClick={() => setActiveId(l.id)}
                    className={
                      'rounded-full px-2.5 py-0.5 text-xs transition-colors ' +
                      (isActive
                        ? 'bg-rose-600 text-white'
                        : 'bg-white/70 text-ink-700 hover:bg-white dark:bg-ink-900/70 dark:text-ink-200 dark:hover:bg-ink-900')
                    }
                    title={l.label}
                  >
                    {l.label.split(',')[0]}
                  </button>
                );
              })}
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
  /** "event" = something happening at a time/place; "deadline" = a
   *  due date / cutoff. The widget shows a flag for deadlines. */
  kind?: 'event' | 'deadline';
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
  /** Geocoded coordinates from plan 11 — only present when the
   *  user has Settings → Maps enabled AND the location string
   *  resolved to a Nominatim hit. Null lat/lon means we either
   *  haven't tried or the lookup failed. */
  geocoded?: {
    lat: number | null;
    lon: number | null;
    displayName: string | null;
    at: string | null;
  };
};

/**
 * Compact sidebar widget — was a hero-sized "Datebook" newspaper
 * spread on the main column, but pushed the actual articles too far
 * down on every render. Now lives in the right rail next to the
 * other reference widgets, capped at the next ~7 events with a
 * "See calendar →" link for the full list.
 */
function UpcomingEvents() {
  const api = useApi();
  const { data } = useQuery({
    queryKey: ['events-upcoming-newsletter'],
    queryFn: () =>
      api.get<{ events: UpcomingEvent[] }>('/api/events/upcoming?limit=20'),
    refetchInterval: 5 * 60_000,
  });

  if (!data || data.events.length === 0) return null;

  // Group events by calendar day. The sidebar is narrow so we render
  // a tight stacked list rather than the side-by-side date column the
  // newspaper version had.
  const byDay = new Map<string, { date: Date; events: UpcomingEvent[] }>();
  for (const e of data.events) {
    const d = new Date(e.start);
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    const bucket = byDay.get(key);
    if (bucket) bucket.events.push(e);
    else byDay.set(key, { date: d, events: [e] });
  }
  const groups = [...byDay.values()].sort((a, b) => +a.date - +b.date);

  // Cap visible events at ~7 so the sidebar stays a sidebar.
  const VISIBLE_CAP = 7;
  let shown = 0;
  const limited: { date: Date; events: UpcomingEvent[] }[] = [];
  for (const g of groups) {
    if (shown >= VISIBLE_CAP) break;
    const remaining = VISIBLE_CAP - shown;
    const slice = g.events.slice(0, remaining);
    limited.push({ date: g.date, events: slice });
    shown += slice.length;
  }
  const more = data.events.length - shown;

  // Geocoded events for the inset map. Plan 11. The map is hidden
  // when no events have coordinates (Settings → Maps off, or
  // every location string failed to geocode), so the existing
  // text-only sidebar renders fine for users without maps.
  const pins: MapPin[] = data.events
    .filter((e) => e.geocoded?.lat != null && e.geocoded?.lon != null)
    .slice(0, 12)
    .map((e) => ({
      lat: e.geocoded!.lat as number,
      lon: e.geocoded!.lon as number,
      label: e.title,
      href: e.pageSlug ? `/p/${e.pageSlug}` : `/e/${e.sourceEmailId}`,
    }));

  return (
    <div className="card">
      <div className="mb-3 flex items-center justify-between gap-2 text-xs uppercase tracking-widest text-ink-500">
        <span className="flex items-center gap-1.5">
          <Calendar className="h-3.5 w-3.5" />
          Upcoming
        </span>
        <Link
          to="/calendar"
          className="text-[10px] font-medium text-rose-600 hover:underline dark:text-rose-300"
        >
          See all →
        </Link>
      </div>
      {pins.length > 0 && (
        <MapInset
          pins={pins}
          height="160px"
          className="mb-3 overflow-hidden rounded-md border border-ink-200 dark:border-ink-800"
        />
      )}
      <ul className="divide-y divide-ink-200 dark:divide-ink-800">
        {limited.map((g) => (
          <li key={g.date.toISOString()} className="py-2 first:pt-0 last:pb-0">
            <div className="text-[10px] font-semibold uppercase tracking-widest text-rose-600 dark:text-rose-300">
              {g.date.toLocaleDateString(undefined, {
                weekday: 'short',
                month: 'short',
                day: 'numeric',
              })}
            </div>
            <ul className="mt-1 space-y-1.5">
              {g.events.map((e) => (
                <UpcomingEventRow key={e._id} e={e} />
              ))}
            </ul>
          </li>
        ))}
      </ul>
      {more > 0 && (
        <Link
          to="/calendar"
          className="mt-2 block text-center text-[11px] text-ink-500 hover:text-rose-600 dark:hover:text-rose-300"
        >
          +{more} more on the calendar
        </Link>
      )}
    </div>
  );
}

function UpcomingEventRow({ e }: { e: UpcomingEvent }) {
  const start = new Date(e.start);
  const isDeadline = e.kind === 'deadline';
  const time = isDeadline
    ? e.allDay
      ? 'Due'
      : `Due ${start.toLocaleTimeString(undefined, {
          hour: 'numeric',
          minute: start.getMinutes() === 0 ? undefined : '2-digit',
        })}`
    : e.allDay
      ? 'All day'
      : start.toLocaleTimeString(undefined, {
          hour: 'numeric',
          minute: start.getMinutes() === 0 ? undefined : '2-digit',
        });
  // Prefer the article link when one exists — that's where the
  // user gets the full context. Fall back to the source email so the
  // row is always actionable.
  const href = e.pageSlug ? `/p/${e.pageSlug}` : `/e/${e.sourceEmailId}`;
  return (
    <li className="min-w-0">
      <Link to={href} className="group block">
        <div className="flex items-start gap-2">
          <span
            className={
              'mt-0.5 inline-flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wider ' +
              (isDeadline
                ? 'bg-amber-100 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200'
                : 'bg-rose-100 text-rose-800 dark:bg-rose-950/40 dark:text-rose-200')
            }
            title={isDeadline ? 'Deadline' : undefined}
          >
            {isDeadline && <Flag className="h-2.5 w-2.5" />}
            {time}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm leading-snug group-hover:text-rose-700 dark:group-hover:text-rose-300">
            {e.title}
          </span>
        </div>
        {e.location && (
          <div className="mt-0.5 truncate pl-1 text-[10px] text-ink-500">
            <MapPinIcon className="mr-0.5 inline h-2.5 w-2.5" />
            {e.location}
          </div>
        )}
      </Link>
    </li>
  );
}
