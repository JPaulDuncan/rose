import { Worker, type Job, Queue } from 'bullmq';
import { Types } from 'mongoose';
import { createHash } from 'node:crypto';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';

type DomDocument = {
  querySelector(selector: string): { getAttribute?(name: string): string | null; textContent?: string | null } | null;
};
import { Email } from '@rose/db';
import { priorityForDate } from '@rose/shared';
import { senderDomainTag } from '@rose/email-parser';
import { detectPromoCodesForEmail } from '@rose/promo-codes';
import { detectShipmentsForEmail } from '@rose/shipments';
import { safeFetch, UnsafeUrlError } from '../lib/safeFetch.js';
import { redis, bullConnection } from '../lib/redis.js';
import { logger } from '../lib/logger.js';

const QUEUE = 'rose.fetch-and-parse';
const generateQueue = new Queue('rose.generate-page', { connection: bullConnection() });

type FetchJobData =
  | {
      kind: 'url';
      userId: string;
      url: string;
      tags?: string[];
      note?: string;
    }
  | {
      kind: 'document';
      userId: string;
      filename: string;
      contentType: string;
      bytesBase64: string;
      tags?: string[];
      note?: string;
    };

const turndown = new TurndownService({
  headingStyle: 'atx',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  emDelimiter: '*',
});
turndown.remove(['script', 'style', 'iframe', 'noscript']);

/** Pull OG / Twitter card metadata + canonical URL from a document. */
function pickMeta(doc: DomDocument): {
  title: string | null;
  description: string | null;
  siteName: string | null;
  image: string | null;
  publishedAt: string | null;
} {
  const meta = (sel: string) =>
    doc.querySelector(sel)?.getAttribute?.('content') ?? null;
  const title =
    meta('meta[property="og:title"]') ??
    meta('meta[name="twitter:title"]') ??
    doc.querySelector('title')?.textContent?.trim() ??
    null;
  const description =
    meta('meta[property="og:description"]') ??
    meta('meta[name="twitter:description"]') ??
    meta('meta[name="description"]');
  const siteName =
    meta('meta[property="og:site_name"]') ?? meta('meta[name="application-name"]');
  const image =
    meta('meta[property="og:image"]') ?? meta('meta[name="twitter:image"]');
  const publishedAt =
    meta('meta[property="article:published_time"]') ??
    meta('meta[name="date"]') ??
    null;
  return { title, description, siteName, image, publishedAt };
}

function senderForUrl(url: string, siteName: string | null): {
  name: string;
  address: string;
} {
  let host = url;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    // pass through
  }
  return { name: siteName ?? host, address: `web@${host}` };
}

async function ingestUrl(
  userId: Types.ObjectId,
  url: string,
  tags: string[],
  note?: string,
): Promise<Types.ObjectId> {
  await safeFetch.bind(null); // type-only ref
  const fetched = await safeFetch(url, { maxBytes: 5 * 1024 * 1024, timeoutMs: 15_000 });
  const ct = fetched.contentType.toLowerCase();
  const bytes = fetched.buffer;
  const finalUrl = fetched.finalUrl;

  // PDF served at a URL — fork to the document branch.
  if (ct.includes('application/pdf')) {
    return ingestDocument(userId, {
      filename: new URL(finalUrl).pathname.split('/').pop() || 'document.pdf',
      contentType: 'application/pdf',
      buffer: bytes,
      sourceUrl: finalUrl,
      tags,
      note,
    });
  }
  if (!ct.includes('text/html') && !ct.includes('application/xhtml+xml')) {
    throw new Error(`Unsupported content-type: ${ct}`);
  }

  const html = bytes.toString('utf-8');
  const { document } = parseHTML(html);
  const meta = pickMeta(document);
  const article = new Readability(document as unknown as never).parse();
  const articleHtml = article?.content ?? '';
  const title = (article?.title || meta.title || finalUrl).trim().slice(0, 200);
  const md = turndown.turndown(articleHtml).trim();
  const fallbackText = (article?.textContent ?? '').trim();
  const text = md || fallbackText;
  if (!text) throw new Error('No readable content extracted from page');
  const date = meta.publishedAt ? new Date(meta.publishedAt) : new Date();

  const sender = senderForUrl(finalUrl, meta.siteName);
  const brand = senderDomainTag(sender.address);
  const topics: string[] = [];
  if (brand) topics.push(brand.toLowerCase());
  if (tags.length) topics.push(...tags.map((t) => t.toLowerCase()));

  const rawHash = createHash('sha256').update(finalUrl).update(' ').update(text).digest('hex');

  // Dedup by URL — idempotent saves don't create duplicates.
  const exists = await Email.findOne({ userId, sourceUrl: finalUrl })
    .select('_id pageId')
    .lean();
  if (exists) {
    logger.info({ url: finalUrl, emailId: String(exists._id) }, 'url-save: dedup hit');
    return exists._id as Types.ObjectId;
  }

  const created = await Email.create({
    userId,
    kind: 'url',
    sourceUrl: finalUrl,
    siteName: meta.siteName ?? null,
    messageId: `url:${finalUrl}`,
    rawHash,
    from: sender,
    to: [],
    cc: [],
    subject: title,
    date,
    text: text.slice(0, 60_000),
    rawText: text.slice(0, 60_000),
    html: articleHtml || null,
    attachments: [],
    priority: 'normal',
    topics,
    links: [],
    images: meta.image ? [{ url: meta.image, alt: title }] : [],
    spamScore: 0,
    spamSignals: [],
    isMassMailing: false,
    promotionalScore: 0,
    isPromotional: false,
    promotionalSignals: [],
    authResults: { spf: 'unknown', dkim: 'unknown', dmarc: 'unknown' },
    unsubscribeUrls: [],
    ingestStatus: 'parsed',
  });
  await generateQueue.add(
    'generate',
    { emailId: String(created._id), userId: String(userId) },
    {
      attempts: 3,
      removeOnComplete: 500,
      removeOnFail: 500,
      priority: priorityForDate(new Date()),
    },
  );
  try {
    await detectPromoCodesForEmail(String(created._id));
  } catch (err) {
    logger.warn({ err, emailId: String(created._id) }, 'promo-code detection failed');
  }
  try {
    await detectShipmentsForEmail(String(created._id));
  } catch (err) {
    logger.warn({ err, emailId: String(created._id) }, 'shipment detection failed');
  }
  return created._id as Types.ObjectId;
}

async function ingestDocument(
  userId: Types.ObjectId,
  input: {
    filename: string;
    contentType: string;
    buffer: Buffer;
    sourceUrl?: string;
    tags?: string[];
    note?: string;
  },
): Promise<Types.ObjectId> {
  const { filename, contentType, buffer, sourceUrl } = input;
  const tags = input.tags ?? [];
  let title = filename.replace(/\.[a-z0-9]+$/i, '').slice(0, 200);
  let text = '';
  let pageCount: number | null = null;
  let html: string | null = null;

  if (contentType === 'application/pdf' || /\.pdf$/i.test(filename)) {
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    try {
      const txt = await parser.getText();
      text = (txt.text ?? '').trim();
      pageCount = txt.total ?? null;
      const info = await parser.getInfo();
      const meta = (info?.info ?? {}) as { Title?: string };
      if (meta.Title) title = String(meta.Title).slice(0, 200);
    } finally {
      await parser.destroy?.();
    }
  } else if (
    contentType.includes('officedocument.wordprocessingml') ||
    /\.docx$/i.test(filename)
  ) {
    const html2 = await mammoth.convertToHtml({ buffer });
    html = html2.value;
    text = turndown.turndown(html2.value).trim();
  } else if (contentType.startsWith('text/markdown') || /\.md$/i.test(filename)) {
    text = buffer.toString('utf-8');
  } else if (contentType.startsWith('text/plain') || /\.txt$/i.test(filename)) {
    text = buffer.toString('utf-8');
  } else if (contentType.includes('text/html') || /\.html?$/i.test(filename)) {
    const { document } = parseHTML(buffer.toString('utf-8'));
    const article = new Readability(document as unknown as never).parse();
    html = article?.content ?? null;
    text = (turndown.turndown(article?.content ?? '') || article?.textContent || '').trim();
    if (article?.title) title = article.title.slice(0, 200);
  } else {
    throw new Error(`Unsupported document type: ${contentType}`);
  }

  if (!text) {
    // Image-only PDF or a parse failure. We still create a sparse page
    // so the user has the original on file.
    text = `(no text could be extracted from ${filename})`;
  }

  const sender = sourceUrl
    ? senderForUrl(sourceUrl, null)
    : { name: 'You', address: 'you@local' };
  const topics: string[] = [];
  for (const t of tags) topics.push(t.toLowerCase());

  const rawHash = createHash('sha256').update(buffer).digest('hex');
  const dedup = await Email.findOne({ userId, rawHash }).select('_id').lean();
  if (dedup) {
    logger.info({ filename, emailId: String(dedup._id) }, 'doc-save: dedup hit');
    return dedup._id as Types.ObjectId;
  }

  const created = await Email.create({
    userId,
    kind: 'document',
    sourceUrl: sourceUrl ?? null,
    documentMeta: {
      filename,
      contentType,
      size: buffer.byteLength,
      pageCount,
    },
    messageId: `doc:${rawHash.slice(0, 32)}`,
    rawHash,
    from: sender,
    to: [],
    cc: [],
    subject: title,
    date: new Date(),
    text: text.slice(0, 200_000),
    rawText: text.slice(0, 200_000),
    html,
    attachments: [],
    priority: 'normal',
    topics,
    links: [],
    images: [],
    spamScore: 0,
    spamSignals: [],
    isMassMailing: false,
    promotionalScore: 0,
    isPromotional: false,
    promotionalSignals: [],
    authResults: { spf: 'unknown', dkim: 'unknown', dmarc: 'unknown' },
    unsubscribeUrls: [],
    ingestStatus: 'parsed',
  });
  await generateQueue.add(
    'generate',
    { emailId: String(created._id), userId: String(userId) },
    {
      attempts: 3,
      removeOnComplete: 500,
      removeOnFail: 500,
      priority: priorityForDate(new Date()),
    },
  );
  try {
    await detectPromoCodesForEmail(String(created._id));
  } catch (err) {
    logger.warn({ err, emailId: String(created._id) }, 'promo-code detection failed');
  }
  try {
    await detectShipmentsForEmail(String(created._id));
  } catch (err) {
    logger.warn({ err, emailId: String(created._id) }, 'shipment detection failed');
  }
  return created._id as Types.ObjectId;
}

export function startFetchAndParseWorker() {
  const worker = new Worker<FetchJobData>(
    QUEUE,
    async (job: Job<FetchJobData>) => {
      const userId = new Types.ObjectId(job.data.userId);
      try {
        if (job.data.kind === 'url') {
          await ingestUrl(
            userId,
            job.data.url,
            job.data.tags ?? [],
            job.data.note,
          );
        } else {
          const buffer = Buffer.from(job.data.bytesBase64, 'base64');
          await ingestDocument(userId, {
            filename: job.data.filename,
            contentType: job.data.contentType,
            buffer,
            tags: job.data.tags,
            note: job.data.note,
          });
        }
      } catch (err) {
        if (err instanceof UnsafeUrlError) {
          logger.warn({ err: err.message, data: job.data }, 'fetch-and-parse: unsafe URL');
        }
        throw err;
      }
    },
    { connection: bullConnection(), concurrency: 4 },
  );
  worker.on('failed', (job, err) =>
    logger.error({ jobId: job?.id, err }, 'fetch-and-parse failed'),
  );
  return worker;
}
