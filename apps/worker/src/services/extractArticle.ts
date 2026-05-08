import { createHash } from 'node:crypto';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
import { logger } from '../lib/logger.js';

/**
 * Shared HTML→article extraction. Replaces the copy-pasted parse-and-
 * extract logic that previously lived in `fetchAndParse.ts` and
 * `websiteSync.ts`. Two callers, identical heuristic, now identical
 * code.
 *
 * Pipeline:
 *   1. Quick sniff against the raw HTML string — reject obviously
 *      empty or login-wall responses without paying for full parse.
 *   2. linkedom parseHTML (fast, no jsdom).
 *   3. <meta> harvest for title / description / publishedAt /
 *      siteName / canonical / og:image.
 *   4. Mozilla Readability for main-content extraction.
 *   5. Turndown for HTML→Markdown so the prompt sees prose-shaped
 *      text rather than bare textContent or stripped tags.
 *
 * Returns null when the page yields nothing usable. The caller decides
 * whether to surface a link-only entry (web research) or fail (manual
 * fetch-and-parse).
 *
 * Phase B perf-roadmap target: this is the function that should run
 * inside a worker_threads pool once we wire one up. Today it runs on
 * the main event loop; linkedom is fast enough that this is tolerable
 * but the pool conversion is a single change-of-call-site away.
 */

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  emDelimiter: '_',
});
turndown.remove(['script', 'style', 'iframe', 'noscript']);

export type ExtractedArticle = {
  /** Cleaned page title. */
  title: string;
  /** Markdown body (turndown of Readability's main content). */
  contentMd: string;
  /** Plain text fallback when markdown is empty. */
  textContent: string;
  /** Stable hash over the cleaned text — useful for dedupe. */
  contentHash: string;
  /** Best-guess publication date (ISO). null if not in the head. */
  publishedAt: string | null;
  /** og:site_name or `<meta name="application-name">`. */
  siteName: string | null;
  /** og:description / meta description. */
  description: string | null;
  /** Canonical URL if the page declares one. */
  canonicalUrl: string | null;
  /** og:image / twitter:image. */
  imageUrl: string | null;
};

/**
 * Cheap upfront filter — runs against the raw HTML string without
 * parsing. Catches obvious thin / error / paywall pages so we don't
 * waste a Readability pass on them. The thresholds are conservative:
 * a real article will always have many more characters than these
 * floors.
 */
function quickSniff(html: string): { thin: boolean; reason?: string } {
  if (!html || html.length < 200) return { thin: true, reason: 'too-short' };
  // Login walls / 403 pages tend to be tiny and mention sign-in
  // prominently. We deliberately don't reject anything that just
  // contains the word "subscribe" — that's too aggressive for sites
  // that have a footer subscribe form on every page.
  if (html.length < 1500 && /sign\s*in|please\s+log\s*in|access\s+denied/i.test(html)) {
    return { thin: true, reason: 'login-wall' };
  }
  return { thin: false };
}

type DomDocument = {
  querySelector(selector: string): {
    getAttribute?(name: string): string | null;
    textContent?: string | null;
    href?: string | null;
  } | null;
  querySelectorAll?(selector: string): Iterable<{ getAttribute?(name: string): string | null }>;
};

function pickMeta(doc: DomDocument): Omit<ExtractedArticle, 'contentMd' | 'textContent' | 'contentHash' | 'title'> & { title: string | null } {
  const meta = (sel: string): string | null =>
    doc.querySelector(sel)?.getAttribute?.('content') ?? null;
  const title =
    meta('meta[property="og:title"]') ??
    doc.querySelector('title')?.textContent?.trim() ??
    null;
  const description =
    meta('meta[property="og:description"]') ?? meta('meta[name="description"]');
  const publishedAt =
    meta('meta[property="article:published_time"]') ??
    meta('meta[name="pubdate"]') ??
    meta('meta[name="date"]') ??
    null;
  const siteName =
    meta('meta[property="og:site_name"]') ??
    meta('meta[name="application-name"]') ??
    null;
  const canonicalUrl =
    (doc.querySelector('link[rel="canonical"]') as { getAttribute?(n: string): string | null } | null)?.getAttribute?.(
      'href',
    ) ?? null;
  const imageUrl =
    meta('meta[property="og:image"]') ?? meta('meta[name="twitter:image"]');
  return {
    title,
    description,
    publishedAt,
    siteName,
    canonicalUrl,
    imageUrl,
  };
}

/**
 * Run the full extraction pipeline against an HTML string. Returns
 * null when the result is too thin to be useful (caller can still
 * surface the URL with a title-only treatment).
 */
export function extractArticle(html: string): ExtractedArticle | null {
  const sniff = quickSniff(html);
  if (sniff.thin) {
    logger.debug({ reason: sniff.reason, len: html.length }, 'extractArticle: skipped thin page');
    return null;
  }
  let document: DomDocument;
  try {
    const parsed = parseHTML(html);
    document = parsed.document as unknown as DomDocument;
  } catch (err) {
    logger.warn({ err }, 'extractArticle: parseHTML failed');
    return null;
  }
  const meta = pickMeta(document);
  let articleHtml = '';
  let articleText = '';
  let articleTitle: string | null = null;
  try {
    const article = new Readability(document as unknown as never).parse();
    articleHtml = article?.content ?? '';
    articleText = article?.textContent ?? '';
    articleTitle = article?.title ?? null;
  } catch (err) {
    logger.warn({ err }, 'extractArticle: Readability threw');
    // Continue with empty article — we still might get usable
    // content from the meta description as a last resort.
  }
  const contentMd = articleHtml ? turndown.turndown(articleHtml).trim() : '';
  const textContent = articleText.trim();
  const text = contentMd || textContent;
  if (!text || text.length < 100) {
    logger.debug({ len: text.length }, 'extractArticle: post-Readability text too short');
    return null;
  }
  const title = (articleTitle || meta.title || '').trim().slice(0, 200);
  const contentHash = createHash('sha256').update(text).digest('hex');
  return {
    title,
    contentMd,
    textContent,
    contentHash,
    publishedAt: meta.publishedAt,
    siteName: meta.siteName,
    description: meta.description,
    canonicalUrl: meta.canonicalUrl,
    imageUrl: meta.imageUrl,
  };
}
