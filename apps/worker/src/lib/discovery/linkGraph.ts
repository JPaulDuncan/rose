import { Types } from 'mongoose';
import { Page } from '@rose/db';
import type { AdapterContext, DaydreamAdapter, DaydreamSnippet } from '@rose/llm';

/**
 * Hosts that almost always represent tracking, click-redirects, or
 * unsubscribe plumbing — copied from the page-view's LinksBlock
 * heuristic so we don't surface them as "discovery". Match is on
 * hostname.
 */
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
];

const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'and', 'or', 'in', 'on', 'at', 'to', 'for',
  'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been', 'as',
  'this', 'that', 'these', 'those', 'it', 'its',
]);

function tokenise(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function isTrackingHost(host: string): boolean {
  return TRACKING_HOST_PATTERNS.some((re) => re.test(host));
}

/**
 * Discovery adapter that walks the user's own ingested email link
 * graph. The signal: a URL that's been linked from multiple wiki
 * pages — especially if those pages share topics with the query —
 * is something the user's corpus has already vouched for.
 *
 * No external HTTP. The snippet content is metadata-only ("linked
 * from N pages titled …"); the LLM uses this as a hint that a URL
 * is worth attention, not as factual content for the synthesis.
 *
 * Configurable via `options.minHostCount` — only return URLs whose
 * host appears on at least N distinct pages, which filters the
 * "marketing newsletter linked once to xyz.com" noise. Defaults to
 * 2.
 */
export class LinkGraphAdapter implements DaydreamAdapter {
  readonly id = 'linkGraph';
  readonly label = 'Your link graph';
  readonly enabledByDefault = false;

  constructor(private readonly userId: Types.ObjectId) {}

  async fetch(query: string, ctx: AdapterContext): Promise<DaydreamSnippet[]> {
    const tokens = tokenise(query);
    if (tokens.length === 0) return [];
    const minHostCount = (ctx.options?.minHostCount as number | undefined) ?? 2;

    // Build a token-matching regex used both for link.text and
    // link.url. Match is case-insensitive substring on any token.
    const tokenRe = new RegExp(
      tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
      'i',
    );

    // Aggregation: unwind pageLinks, match on link text/url or page
    // topics, group by URL, count distinct contributing pages,
    // collect link text + page titles. We bound everything: pages
    // table can be large, so the $match clauses run first to use
    // indexes on userId + topics where possible.
    const rows = await Page.aggregate<{
      _id: string;
      url: string;
      count: number;
      pageCount: number;
      pageTitles: string[];
      texts: string[];
    }>([
      {
        $match: {
          userId: this.userId,
          'pageLinks.0': { $exists: true },
        },
      },
      {
        $project: {
          title: 1,
          pageLinks: 1,
          topics: 1,
          tags: 1,
        },
      },
      { $unwind: '$pageLinks' },
      {
        $match: {
          $or: [
            { 'pageLinks.url': tokenRe },
            { 'pageLinks.text': tokenRe },
            { topics: { $in: tokens } },
            { tags: { $in: tokens } },
          ],
        },
      },
      {
        $group: {
          _id: '$pageLinks.url',
          count: { $sum: { $ifNull: ['$pageLinks.count', 1] } },
          pageCount: { $addToSet: '$_id' },
          pageTitles: { $addToSet: '$title' },
          texts: { $addToSet: '$pageLinks.text' },
        },
      },
      {
        $project: {
          url: '$_id',
          count: 1,
          pageCount: { $size: '$pageCount' },
          pageTitles: 1,
          texts: 1,
        },
      },
      { $match: { pageCount: { $gte: minHostCount } } },
      { $sort: { count: -1, pageCount: -1 } },
      { $limit: 6 },
    ]);

    const out: DaydreamSnippet[] = [];
    for (const r of rows) {
      const host = hostOf(r.url);
      if (!host || isTrackingHost(host)) continue;
      const linkText = (r.texts ?? []).find((t) => t && t.length > 0) ?? '';
      const titles = (r.pageTitles ?? []).filter(Boolean).slice(0, 4);
      const lines: string[] = [];
      lines.push(`${linkText || host} (${r.url})`);
      lines.push(
        `Linked from ${r.pageCount} of your wiki page${r.pageCount === 1 ? '' : 's'}` +
          (titles.length
            ? `: ${titles.map((t) => `"${t}"`).join(', ')}`
            : ''),
      );
      // Confidence: the more pages reference it, the more weight.
      // Cap at 0.7 — even strong link-graph signal should rarely
      // outrank a real Wikipedia/Wikidata snippet for the LLM.
      const confidence = Math.min(0.7, 0.3 + Math.log10(r.pageCount + 1) * 0.3);
      out.push({
        title: linkText || host,
        url: r.url,
        content: lines.join('\n'),
        confidence,
        fetchedAt: new Date(),
      });
      if (out.length >= 4) break;
    }
    return out;
  }
}
