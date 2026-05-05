import { webFetch } from '../web/index.js';
import type { AdapterContext, DaydreamAdapter, DaydreamSnippet } from './types.js';

const UA = 'Rose/1.0 (+https://rose.local; daydream)';

/**
 * Tiny Atom-feed parser scoped to the fields arXiv emits.
 * arXiv responds with Atom XML and we don't want to pull a full XML
 * parser into @rose/llm just for one adapter — the response shape is
 * stable enough that block-walking with regex covers it.
 */
type ArxivEntry = {
  title: string;
  summary: string;
  published: string;
  authors: string[];
  abs: string;
  pdf: string;
  id: string;
};

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function tagText(block: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const m = block.match(re);
  if (!m?.[1]) return '';
  return decodeEntities(m[1].replace(/\s+/g, ' ').trim());
}

function parseAtom(xml: string): ArxivEntry[] {
  const out: ArxivEntry[] = [];
  // Each <entry>…</entry> is one paper.
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(xml)) !== null) {
    const body = m[1] ?? '';
    const title = tagText(body, 'title');
    const summary = tagText(body, 'summary');
    const published = tagText(body, 'published');
    const id = tagText(body, 'id');
    const authors: string[] = [];
    const authorRe = /<author>([\s\S]*?)<\/author>/g;
    let a: RegExpExecArray | null;
    while ((a = authorRe.exec(body)) !== null) {
      const name = tagText(a[1] ?? '', 'name');
      if (name) authors.push(name);
    }
    // <link rel="alternate" type="text/html" href="…" />  (abstract page)
    // <link title="pdf" href="…" />
    let abs = '';
    let pdf = '';
    const linkRe = /<link\b([^/]*?)\/>/g;
    let l: RegExpExecArray | null;
    while ((l = linkRe.exec(body)) !== null) {
      const attrs = l[1] ?? '';
      const href = /\bhref="([^"]+)"/.exec(attrs)?.[1] ?? '';
      const type = /\btype="([^"]+)"/.exec(attrs)?.[1] ?? '';
      const titleAttr = /\btitle="([^"]+)"/.exec(attrs)?.[1] ?? '';
      if (titleAttr === 'pdf') pdf = href;
      else if (type === 'text/html') abs = href;
    }
    out.push({ title, summary, published, authors, abs, pdf, id });
  }
  return out;
}

/**
 * arXiv adapter. Pre-prints across math, CS, physics, statistics,
 * and adjacent fields. Free, no key. Their fair-use guideline is
 * "1 query / 3 sec sustained" — the worker's daydream concurrency=1
 * already enforces this since one fetch is in flight at a time.
 */
export class ArxivAdapter implements DaydreamAdapter {
  readonly id = 'arxiv';
  readonly label = 'arXiv';
  readonly enabledByDefault = false;

  async fetch(query: string, ctx: AdapterContext): Promise<DaydreamSnippet[]> {
    const cache = (ctx.options?.cache as
      | import('../web/index.js').WebFetchCache
      | undefined) ?? undefined;
    const url =
      `http://export.arxiv.org/api/query` +
      `?search_query=${encodeURIComponent(`all:${query}`)}` +
      `&start=0&max_results=3` +
      `&sortBy=relevance&sortOrder=descending`;

    const r = await webFetch(url, {
      userAgent: UA,
      timeoutMs: ctx.timeoutMs,
      cache,
      cacheTtlSec: 60 * 60 * 24 * 30,
      caller: 'daydream.arxiv',
      headers: { accept: 'application/atom+xml' },
    });
    if (!r.ok || !r.body) return [];
    const entries = parseAtom(r.body);
    if (entries.length === 0) return [];

    return entries.slice(0, 2).map((e, idx) => {
      const summary = e.summary.length > 4000 ? `${e.summary.slice(0, 4000)}…` : e.summary;
      const lines: string[] = [e.title];
      if (summary) {
        lines.push('');
        lines.push(summary);
      }
      const meta: string[] = [];
      if (e.authors.length) meta.push(e.authors.slice(0, 4).join(', '));
      if (e.published) meta.push(e.published.slice(0, 10));
      if (meta.length) {
        lines.push('');
        lines.push(`— ${meta.join(' · ')}`);
      }
      // Confidence: top hit gets a high score; subsequent slightly
      // lower since arXiv's "relevance" sort is noisy on broad queries.
      const confidence = idx === 0 ? 0.8 : 0.6;
      return {
        title: e.title,
        url: e.abs || e.id,
        content: lines.join('\n'),
        confidence,
        fetchedAt: new Date(),
      };
    });
  }
}
