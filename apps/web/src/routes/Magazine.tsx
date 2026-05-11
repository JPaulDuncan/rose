import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Newspaper,
  Printer,
  ChevronLeft,
  CalendarDays,
} from 'lucide-react';
import { useApi } from '../lib/api';

/**
 * Magazine layout for the daily/weekly digest — rendered as a
 * print-ready newsprint spread instead of the home-page card
 * stack. Reads the same `/api/digest` payload the Home view does,
 * so what you see in the magazine IS what landed in this morning's
 * edition.
 *
 * Print stylesheet at the bottom collapses the app chrome via the
 * `:has(.rose-magazine)` selector and switches to serif typography
 * + page breaks, so Cmd+P / Ctrl+P produces a usable PDF without
 * a separate route.
 */

type DigestPage = {
  _id: string;
  slug: string;
  title: string;
  summary: string;
  tags: string[];
  priority: 'high' | 'normal' | 'low';
  sourceEmailIds: string[];
  senderAddresses: string[];
  topics: string[];
  heroImageUrl?: string | null;
  updatedAt: string;
  articleDate?: string | null;
  wordCount?: number;
  pullQuote?: string | null;
};

type SenderBrand = {
  brandKey: string;
  name: string;
  domain: string | null;
  logoUrl: string | null;
};

type FeaturedSection = {
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
  topStories: { lead: DigestPage | null; secondaries: DigestPage[] };
  mostRead: DigestPage[];
  topSenders: { address: string; pageCount: number }[];
  topTopics: { topic: string; count: number }[];
  featuredSections: FeaturedSection[];
  senderBrands: Record<string, SenderBrand>;
};

function bylineFor(p: DigestPage, brands: Record<string, SenderBrand>): string {
  const first = (p.senderAddresses ?? [])[0];
  if (!first) return '—';
  const brand = brands[first.toLowerCase()];
  return brand?.name ?? first;
}

export default function MagazinePage() {
  const api = useApi();
  const { data, isLoading } = useQuery({
    queryKey: ['digest'],
    queryFn: () => api.get<Digest>('/api/digest'),
  });

  // Mark a `data-magazine` flag on <html> while this route is
  // mounted so the print stylesheet at the bottom can hide the
  // surrounding app chrome (top bar, nav). Cleaned up on unmount.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add('magazine-mode');
    return () => root.classList.remove('magazine-mode');
  }, []);

  if (isLoading || !data) {
    return (
      <div className="mx-auto max-w-4xl px-6 py-10 text-ink-500">
        Loading the morning edition…
      </div>
    );
  }

  const { edition, topStories, mostRead, topSenders, topTopics, featuredSections, senderBrands, stats } = data;
  const lead = topStories?.lead;

  return (
    <article className="rose-magazine mx-auto w-full max-w-[8.5in] bg-paper px-6 py-8 text-ink-900 print:max-w-none print:p-0 print:text-black">
      <NoPrintControls />

      {/* ── Masthead ────────────────────────────────────────── */}
      <header className="border-b-4 border-double border-ink-900 pb-3 print:border-black">
        <div className="flex items-baseline justify-between text-[10px] uppercase tracking-[0.3em] text-ink-500">
          <span>Volume I · Edition of the {edition.label}</span>
          <span>{stats.totalPages.toLocaleString()} pages in the archive</span>
        </div>
        <h1 className="font-serif text-7xl font-black tracking-tight">
          ROSE
        </h1>
        <div className="mt-1 flex items-baseline justify-between text-xs italic text-ink-500">
          <span>Personal Wiki of Record</span>
          <span>“All the news your inbox saw fit to file.”</span>
        </div>
      </header>

      {/* ── Lead story ──────────────────────────────────────── */}
      {lead && (
        <section className="magazine-page mt-6 grid gap-6 md:grid-cols-[minmax(0,5fr)_minmax(0,2fr)]">
          <div>
            <div className="text-[10px] uppercase tracking-[0.25em] text-rose-700 print:text-black">
              Lead story
            </div>
            <h2 className="mt-1 font-serif text-5xl font-bold leading-[1.05]">
              <Link
                to={`/p/${lead.slug}`}
                className="text-ink-900 hover:underline print:text-black"
              >
                {lead.title}
              </Link>
            </h2>
            {lead.summary && (
              <p className="mt-3 font-serif text-lg italic leading-snug text-ink-600 print:text-black">
                {lead.summary}
              </p>
            )}
            {lead.heroImageUrl && (
              <figure className="mt-4">
                <img
                  src={lead.heroImageUrl}
                  alt=""
                  className="w-full rounded-sm object-cover"
                  loading="lazy"
                  referrerPolicy="no-referrer"
                  onError={(e) => {
                    (e.currentTarget as HTMLImageElement).style.display = 'none';
                  }}
                />
                <figcaption className="mt-1 text-[10px] italic text-ink-500">
                  Image filed alongside this dispatch.
                </figcaption>
              </figure>
            )}
            <div className="mt-4 columns-1 gap-6 font-serif text-base leading-relaxed sm:columns-2">
              <p className="break-inside-avoid">
                <span className="mr-1 float-left text-6xl font-bold leading-[0.85]">
                  {(lead.summary || lead.title).charAt(0).toUpperCase()}
                </span>
                {(lead.summary || lead.title).slice(1) ||
                  'A story is filed here.'}
              </p>
              {lead.pullQuote && (
                <blockquote className="my-3 break-inside-avoid border-l-4 border-rose-500 pl-3 font-serif text-xl italic leading-snug text-ink-700 print:border-black print:text-black">
                  “{lead.pullQuote}”
                </blockquote>
              )}
              <p className="mt-3 break-inside-avoid text-sm text-ink-500">
                Filed by {bylineFor(lead, senderBrands)}
                {lead.sourceEmailIds.length > 0 && (
                  <>
                    {' · '}
                    {lead.sourceEmailIds.length} contributing dispatch
                    {lead.sourceEmailIds.length === 1 ? '' : 'es'}
                  </>
                )}
                {lead.wordCount ? ` · ${lead.wordCount.toLocaleString()} words` : ''}
                {' · '}
                <Link to={`/p/${lead.slug}`} className="underline">
                  read on the wiki
                </Link>
              </p>
            </div>
          </div>

          <aside className="border-l border-ink-300 pl-6 print:border-black">
            <div className="text-[10px] uppercase tracking-[0.25em] text-ink-500">
              In this edition
            </div>
            <ol className="mt-2 space-y-2 font-serif text-sm">
              {topStories.secondaries.map((p, i) => (
                <li
                  key={p._id}
                  className="border-b border-dotted border-ink-300 pb-2 print:border-black"
                >
                  <span className="mr-2 font-bold text-rose-700 print:text-black">
                    {String(i + 2).padStart(2, '0')}
                  </span>
                  <Link
                    to={`/p/${p.slug}`}
                    className="font-semibold leading-tight text-ink-900 hover:underline print:text-black"
                  >
                    {p.title}
                  </Link>
                  <div className="ml-6 mt-1 text-[11px] italic text-ink-500">
                    {bylineFor(p, senderBrands)}
                  </div>
                </li>
              ))}
            </ol>
            {topTopics.length > 0 && (
              <div className="mt-6">
                <div className="text-[10px] uppercase tracking-[0.25em] text-ink-500">
                  Trending
                </div>
                <p className="mt-1 font-serif text-sm leading-relaxed">
                  {topTopics.slice(0, 10).map((t, i) => (
                    <span key={t.topic}>
                      {i > 0 && ' · '}
                      <Link
                        to={`/t/${encodeURIComponent(t.topic)}`}
                        className="hover:underline"
                      >
                        {t.topic}
                      </Link>
                      <span className="text-ink-500"> {t.count}</span>
                    </span>
                  ))}
                </p>
              </div>
            )}
          </aside>
        </section>
      )}

      {/* ── Featured sections ───────────────────────────────── */}
      {featuredSections.length > 0 && (
        <section className="magazine-page mt-12 break-before-page border-t-2 border-ink-900 pt-6 print:border-black">
          <h2 className="font-serif text-3xl font-bold tracking-tight">
            Sections
          </h2>
          <div className="mt-4 space-y-10">
            {featuredSections.map((s) => (
              <FeaturedSpread
                key={s.tag}
                section={s}
                brands={senderBrands}
              />
            ))}
          </div>
        </section>
      )}

      {/* ── Most read ───────────────────────────────────────── */}
      {mostRead.length > 0 && (
        <section className="magazine-page mt-10 grid gap-6 md:grid-cols-[minmax(0,5fr)_minmax(0,2fr)]">
          <div>
            <h2 className="font-serif text-2xl font-bold tracking-tight border-b border-ink-300 pb-1 print:border-black">
              Most read
            </h2>
            <ol className="mt-3 space-y-3 font-serif">
              {mostRead.map((p, i) => (
                <li key={p._id} className="flex gap-3">
                  <span className="w-7 shrink-0 text-3xl font-bold leading-none text-rose-700 print:text-black">
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1 border-b border-dotted border-ink-300 pb-3 print:border-black">
                    <Link
                      to={`/p/${p.slug}`}
                      className="font-semibold leading-tight hover:underline"
                    >
                      {p.title}
                    </Link>
                    {p.summary && (
                      <p className="mt-0.5 text-sm italic text-ink-600 print:text-black">
                        {p.summary}
                      </p>
                    )}
                    <p className="mt-1 text-[11px] text-ink-500">
                      {bylineFor(p, senderBrands)}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          </div>

          {topSenders.length > 0 && (
            <aside className="border-l border-ink-300 pl-6 print:border-black">
              <h3 className="font-serif text-lg font-bold tracking-tight">
                Sender register
              </h3>
              <ul className="mt-2 space-y-1 font-serif text-sm">
                {topSenders.map((s) => {
                  const brand = senderBrands[s.address.toLowerCase()];
                  return (
                    <li
                      key={s.address}
                      className="flex items-baseline justify-between"
                    >
                      <span className="truncate">
                        {brand?.name ?? s.address}
                      </span>
                      <span className="ml-2 text-ink-500">{s.pageCount}</span>
                    </li>
                  );
                })}
              </ul>
            </aside>
          )}
        </section>
      )}

      {/* ── Colophon ─────────────────────────────────────────── */}
      <footer className="magazine-page mt-12 border-t-4 border-double border-ink-900 pt-3 text-center text-[11px] italic text-ink-500 print:border-black">
        <p>
          {stats.totalPages.toLocaleString()} pages ·{' '}
          {stats.totalEmails.toLocaleString()} dispatches ·{' '}
          {stats.newToday} filed today · {stats.highPriority} on the high desk
        </p>
        <p className="mt-1">
          Set in serif; printed at your convenience. Edition closes daily;
          past editions live in the archive.
        </p>
      </footer>

      {/* Print + serif styles — scoped via the .rose-magazine
          ancestor so the rest of the SPA stays unaffected. */}
      <style>{`
        .rose-magazine {
          font-family: 'Iowan Old Style', 'Palatino Linotype', 'Palatino',
            'Hoefler Text', Georgia, serif;
        }
        .rose-magazine .font-serif {
          font-family: 'Iowan Old Style', 'Palatino Linotype', 'Palatino',
            'Hoefler Text', Georgia, serif;
        }
        .bg-paper { background-color: #fcfaf3; }
        @media (prefers-color-scheme: dark) {
          .rose-magazine.bg-paper { background-color: #1b1816; color: #f6ecd9; }
        }
        @media print {
          @page { size: letter; margin: 0.6in; }
          html.magazine-mode body { background: white; }
          html.magazine-mode .rose-no-print { display: none !important; }
          html.magazine-mode nav,
          html.magazine-mode header[role="banner"],
          html.magazine-mode aside[role="complementary"] {
            display: none !important;
          }
          .rose-magazine .magazine-page {
            break-inside: avoid-page;
          }
          .rose-magazine .break-before-page {
            break-before: page;
          }
          .rose-magazine a { color: black; text-decoration: none; }
          .rose-magazine a[href^="/"]::after,
          .rose-magazine a[href^="http"]::after {
            content: '';
          }
        }
      `}</style>
    </article>
  );
}

function NoPrintControls() {
  return (
    <div className="rose-no-print mb-3 flex items-center gap-2 text-xs">
      <Link
        to="/"
        className="inline-flex items-center gap-1 text-ink-500 hover:text-ink-900 dark:hover:text-ink-100"
      >
        <ChevronLeft className="h-3 w-3" /> Home
      </Link>
      <span className="text-ink-300">·</span>
      <span className="inline-flex items-center gap-1 text-ink-500">
        <Newspaper className="h-3 w-3" /> Magazine layout
      </span>
      <button
        type="button"
        className="ml-auto inline-flex items-center gap-1 rounded border border-ink-300 px-2 py-1 hover:bg-ink-100 dark:border-ink-700 dark:hover:bg-ink-800"
        onClick={() => window.print()}
        title="Print or save as PDF"
      >
        <Printer className="h-3 w-3" /> Print / save PDF
      </button>
    </div>
  );
}

function FeaturedSpread({
  section,
  brands,
}: {
  section: FeaturedSection;
  brands: Record<string, SenderBrand>;
}) {
  const headline = section.digest?.headline ?? `Section: #${section.tag}`;
  const dek = section.digest?.dek ?? '';
  const body = section.digest?.bodyMd ?? '';
  const pages = section.pages;
  return (
    <article className="magazine-page break-inside-avoid">
      <header className="mb-2 flex items-baseline justify-between border-b border-ink-300 pb-1 print:border-black">
        <Link
          to={`/t/${encodeURIComponent(section.tag)}`}
          className="font-serif text-2xl font-bold tracking-tight hover:underline"
        >
          {headline}
        </Link>
        <span className="text-[11px] italic text-ink-500">
          #{section.tag} · {section.pageCount} page
          {section.pageCount === 1 ? '' : 's'}
          {section.digest?.generatedAt && (
            <>
              {' · '}
              <CalendarDays className="inline h-3 w-3" />{' '}
              {new Date(section.digest.generatedAt).toLocaleDateString()}
            </>
          )}
        </span>
      </header>
      {dek && (
        <p className="mb-3 font-serif text-base italic text-ink-600 print:text-black">
          {dek}
        </p>
      )}
      <div className="grid gap-6 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="font-serif text-base leading-relaxed">
          {body
            ? body
                .split(/\n{2,}/)
                .map((para, i) => <p key={i} className="mb-2">{para}</p>)
            : (
              <p className="italic text-ink-500">
                No editor's brief filed for this section today.
              </p>
            )}
        </div>
        <ul className="space-y-2 border-l border-ink-300 pl-4 font-serif text-sm print:border-black">
          {pages.slice(0, 6).map((p) => (
            <li key={p._id} className="border-b border-dotted border-ink-300 pb-2 print:border-black">
              <Link
                to={`/p/${p.slug}`}
                className="font-semibold leading-tight hover:underline"
              >
                {p.title}
              </Link>
              {p.summary && (
                <p className="mt-0.5 text-[12px] italic leading-snug text-ink-600 print:text-black">
                  {p.summary}
                </p>
              )}
              <p className="mt-0.5 text-[10px] uppercase tracking-widest text-ink-500">
                {bylineFor(p, brands)}
              </p>
            </li>
          ))}
        </ul>
      </div>
    </article>
  );
}
