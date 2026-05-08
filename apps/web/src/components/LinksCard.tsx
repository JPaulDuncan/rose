import type { ReactNode } from 'react';
import { ChevronDown, ExternalLink, Link as LinkIcon } from 'lucide-react';

/**
 * Shared "Links" card used on the article view AND the email view.
 * Same visual contract: a CountedSection that auto-collapses past
 * `collapseAt`, two buckets (content / tracking-utility), grouped
 * by hostname, with the noisy buckets demoted into a `<details>` so
 * the actual content URLs surface first.
 *
 * Pulled out of Page.tsx so the email view can render the same
 * card without duplicating the host-grouping / tracking-filter
 * heuristics.
 */

export type LinkRow = { url: string; text?: string | null; count?: number };

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export function CountedSection({
  icon,
  title,
  count,
  collapseAt,
  children,
}: {
  icon: ReactNode;
  title: string;
  count: number;
  collapseAt: number;
  children: ReactNode;
}) {
  const collapsed = count > collapseAt;
  const header = (
    <span className="flex items-center gap-2 text-sm font-semibold">
      {icon}
      {title} ({count})
    </span>
  );
  if (!collapsed) {
    return (
      <section className="card">
        <h2 className="mb-3">{header}</h2>
        {children}
      </section>
    );
  }
  return (
    <section className="card">
      <details>
        <summary className="flex cursor-pointer items-center justify-between text-sm font-semibold hover:text-rose-700 dark:hover:text-rose-300">
          {header}
          <ChevronDown className="h-4 w-4 transition-transform [details[open]_&]:rotate-180" />
        </summary>
        <div className="mt-3">{children}</div>
      </details>
    </section>
  );
}

const TRACKING_HOST_PATTERNS: RegExp[] = [
  /^t\.co$/,
  /^bit\.ly$/,
  /^tinyurl\.com$/,
  /^lnkd\.in$/,
  /^ow\.ly$/,
  /^buff\.ly$/,
  /^mailchi\.mp$/,
  /^mandrillapp\.com$/,
  /(^|\.)sendgrid\.net$/,
  /(^|\.)sg\.send$/,
  /(^|\.)mktoresp\.com$/,
  /(^|\.)hsforms\.com$/,
  /(^|\.)hubspotemail\.net$/,
  /^r\..+\..+/,
  /^link\..+\..+/,
  /^click\..+\..+/,
  /^track(ing)?\..+\..+/,
  /^ct\..+\..+/,
  /^email\..+\..+/,
  /^e\..+\..+/,
];

export function isTrackingHost(host: string): boolean {
  const h = host.toLowerCase();
  return TRACKING_HOST_PATTERNS.some((re) => re.test(h));
}

export function isUnsubscribeUrl(url: string): boolean {
  return /\b(unsubscribe|opt[-_]?out|preferences|email[-_]?settings)\b/i.test(url);
}

function groupByHost(
  links: LinkRow[],
): { host: string; total: number; rows: LinkRow[] }[] {
  const map = new Map<string, LinkRow[]>();
  for (const l of links) {
    const h = hostOf(l.url);
    const arr = map.get(h) ?? [];
    arr.push(l);
    map.set(h, arr);
  }
  return [...map.entries()]
    .map(([host, rows]) => ({
      host,
      total: rows.reduce((s, r) => s + (r.count ?? 1), 0),
      rows: rows.sort((a, b) => (b.count ?? 1) - (a.count ?? 1)),
    }))
    .sort((a, b) => b.total - a.total);
}

function truncateLinkLabel(s: string, max = 48): string {
  if (!s) return s;
  if (s.length <= max) return s;
  return s.slice(0, max - 2) + ' …';
}

function LinkLi({ link }: { link: LinkRow }) {
  const label = link.text || link.url;
  const count = link.count ?? 1;
  return (
    <li className="flex items-start gap-2">
      <ExternalLink className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-400" />
      <a
        href={link.url}
        target="_blank"
        rel="noreferrer"
        className="min-w-0 flex-1 truncate text-rose-600 hover:underline dark:text-rose-400"
        title={link.url}
      >
        {truncateLinkLabel(label)}
      </a>
      {count > 1 && (
        <span
          className="shrink-0 rounded bg-ink-100 px-1 text-[10px] text-ink-600 dark:bg-ink-800 dark:text-ink-300"
          title={`Appeared in ${count} source emails`}
        >
          ×{count}
        </span>
      )}
    </li>
  );
}

export function LinksCard({ links }: { links: LinkRow[] }) {
  if (!links.length) return null;
  const content: LinkRow[] = [];
  const utility: LinkRow[] = [];
  for (const l of links) {
    const host = hostOf(l.url);
    if (isTrackingHost(host) || isUnsubscribeUrl(l.url)) utility.push(l);
    else content.push(l);
  }
  const contentGroups = groupByHost(content);

  return (
    <CountedSection
      icon={<LinkIcon className="h-4 w-4 text-rose-500" />}
      title="Links"
      count={links.length}
      collapseAt={5}
    >
      <ul className="space-y-3 text-sm">
        {contentGroups.map((g) => (
          <li key={g.host}>
            <div className="mb-1 flex items-center gap-2 text-xs uppercase tracking-wider text-ink-500">
              <span>{g.host}</span>
              {g.rows.length > 1 && (
                <span className="rounded bg-ink-100 px-1 text-[10px] dark:bg-ink-800">
                  {g.rows.length} link{g.rows.length === 1 ? '' : 's'}
                </span>
              )}
            </div>
            <ul className="space-y-1 pl-1">
              {g.rows.slice(0, 8).map((r) => (
                <LinkLi key={r.url} link={r} />
              ))}
              {g.rows.length > 8 && (
                <li className="pl-5 text-xs italic text-ink-500">
                  +{g.rows.length - 8} more on {g.host}
                </li>
              )}
            </ul>
          </li>
        ))}
      </ul>

      {utility.length > 0 && (
        <details className="mt-4 border-t border-ink-200 pt-3 dark:border-ink-800">
          <summary className="cursor-pointer text-xs text-ink-500 hover:text-rose-600 dark:hover:text-rose-300">
            Tracking & utility links ({utility.length})
          </summary>
          <ul className="mt-2 space-y-1 text-xs">
            {utility.slice(0, 50).map((l) => (
              <LinkLi key={l.url} link={l} />
            ))}
          </ul>
        </details>
      )}
    </CountedSection>
  );
}
