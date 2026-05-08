import { Worker, type Job, Queue } from 'bullmq';
import { Types } from 'mongoose';
import { createHash } from 'node:crypto';
import { Source, Email } from '@rose/db';
import { priorityForDate, type WebsiteConfig } from '@rose/shared';
import { detectPromoCodesForEmail } from '@rose/promo-codes';
import { detectShipmentsForEmail } from '@rose/shipments';
import { senderDomainTag } from '@rose/email-parser';
import { decryptJson } from '../lib/crypto.js';
import { emitRecipeEvent } from '../lib/recipeEmit.js';
import { assertSafeHttpUrl, UnsafeUrlError } from '../lib/safeFetch.js';
import { redis, bullConnection } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { extractArticle } from '../services/extractArticle.js';

const QUEUE = 'rose.website-sync';
const generateQueue = new Queue('rose.generate-page', { connection: bullConnection() });

type WebsiteJobData = { sourceId: string; userId: string };

type FetchOutcome =
  | { kind: 'unchanged' }
  | {
      kind: 'fetched';
      finalUrl: string;
      bodyHtml: string;
      etag: string | null;
      lastModified: string | null;
    };

/**
 * Fetch with SSRF guard, manual redirect-and-revalidate (mirrors safeFetch),
 * a 5MB cap, and conditional-GET headers. Returns `{kind: 'unchanged'}` on a
 * 304 response so the caller can short-circuit page generation.
 */
async function conditionalFetchHtml(
  rawUrl: string,
  cache: { etag: string | null; lastModified: string | null },
): Promise<FetchOutcome> {
  const maxBytes = 5 * 1024 * 1024;
  const timeoutMs = 15_000;
  let current = rawUrl;
  for (let hop = 0; hop < 6; hop += 1) {
    await assertSafeHttpUrl(current);
    const headers: Record<string, string> = {
      'User-Agent': 'Rose/1.0 (+https://rose.local)',
      Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
    };
    if (cache.etag) headers['If-None-Match'] = cache.etag;
    if (cache.lastModified) headers['If-Modified-Since'] = cache.lastModified;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(current, { headers, redirect: 'manual', signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 304) return { kind: 'unchanged' };
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new UnsafeUrlError('Redirect without Location header');
      current = new URL(loc, current).toString();
      continue;
    }
    if (!res.ok) {
      throw new Error(`Upstream responded ${res.status} ${res.statusText}`);
    }
    const ct = (res.headers.get('content-type') ?? '').toLowerCase();
    if (!ct.includes('text/html') && !ct.includes('application/xhtml+xml')) {
      throw new Error(`Unsupported content-type: ${ct || 'unknown'}`);
    }
    const reader = res.body?.getReader();
    if (!reader) throw new Error('Empty response body');
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          ctrl.abort();
          throw new Error(`Body exceeded ${maxBytes} byte cap`);
        }
        chunks.push(value);
      }
    }
    return {
      kind: 'fetched',
      finalUrl: current,
      bodyHtml: Buffer.concat(chunks).toString('utf-8'),
      etag: res.headers.get('etag'),
      lastModified: res.headers.get('last-modified'),
    };
  }
  throw new Error('Too many redirects');
}

function senderForUrl(url: string, siteName: string | null): { name: string; address: string } {
  let host = url;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    // pass through
  }
  return { name: siteName ?? host, address: `web@${host}` };
}

export function startWebsiteSyncWorker() {
  const worker = new Worker<WebsiteJobData>(
    QUEUE,
    async (job: Job<WebsiteJobData>) => {
      const userId = new Types.ObjectId(job.data.userId);
      const source = await Source.findOne({ _id: job.data.sourceId, userId }).select(
        '+encryptedConfig',
      );
      if (!source || source.type !== 'website' || !source.encryptedConfig) return;

      const cfg = decryptJson<WebsiteConfig>(source.encryptedConfig);

      let outcome: FetchOutcome;
      try {
        outcome = await conditionalFetchHtml(cfg.url, {
          etag: source.websiteEtag ?? null,
          lastModified: source.websiteLastModified ?? null,
        });
      } catch (err) {
        source.lastError = (err as Error).message;
        source.status = 'error';
        await source.save();
        throw err;
      }

      if (outcome.kind === 'unchanged') {
        source.lastSyncAt = new Date();
        source.lastError = null;
        source.status = 'active';
        await source.save();
        logger.info({ sourceId: String(source._id) }, 'website-sync: 304 not modified');
        return;
      }

      const article = extractArticle(outcome.bodyHtml);
      if (!article) {
        const msg = 'No readable content extracted from page';
        source.lastError = msg;
        source.status = 'error';
        await source.save();
        throw new Error(msg);
      }
      const title = (article.title || outcome.finalUrl).trim().slice(0, 200);
      const text = article.contentMd || article.textContent;
      const contentHash = article.contentHash;

      // Cache validators always update (even when content matches), so the
      // next conditional GET still gets to short-circuit at HTTP layer.
      if (outcome.etag) source.websiteEtag = outcome.etag;
      if (outcome.lastModified) source.websiteLastModified = outcome.lastModified;
      source.websiteUrl = cfg.url;
      source.websiteTitle = title;

      if (contentHash === source.websiteContentHash) {
        source.lastSyncAt = new Date();
        source.lastError = null;
        source.status = 'active';
        await source.save();
        logger.info(
          { sourceId: String(source._id) },
          'website-sync: content hash unchanged, skipping page generation',
        );
        return;
      }

      // Content changed (or first sync). Persist a snapshot Email row,
      // queue page generation, and remember the new hash.
      const messageId = `website:${String(source._id)}:${contentHash.slice(0, 16)}`;
      const rawHash = createHash('sha256')
        .update(outcome.finalUrl)
        .update(' ')
        .update(contentHash)
        .digest('hex');

      const sender = senderForUrl(outcome.finalUrl, article.siteName);
      const brand = senderDomainTag(sender.address);
      const topics: string[] = [];
      if (brand) topics.push(brand.toLowerCase());

      const date = article.publishedAt ? new Date(article.publishedAt) : new Date();

      const dup = await Email.findOne({ userId, $or: [{ messageId }, { rawHash }] })
        .select('_id')
        .lean();
      if (dup) {
        // Should be rare — content hash changed but we already had this exact
        // (URL, body) tuple. Bump lastSyncAt and bail.
        source.websiteContentHash = contentHash;
        source.lastSyncAt = new Date();
        source.lastError = null;
        source.status = 'active';
        await source.save();
        logger.info(
          { sourceId: String(source._id), emailId: String(dup._id) },
          'website-sync: dedup hit on existing snapshot',
        );
        return;
      }

      const created = await Email.create({
        userId,
        sourceId: source._id,
        kind: 'url',
        sourceUrl: outcome.finalUrl,
        siteName: article.siteName ?? null,
        messageId,
        rawHash,
        from: sender,
        to: [],
        cc: [],
        subject: title,
        date,
        text: text.slice(0, 60_000),
        rawText: text.slice(0, 60_000),
        html: null,
        attachments: [],
        priority: 'normal',
        topics,
        links: [],
        images: article.imageUrl ? [{ url: article.imageUrl, alt: title }] : [],
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
      await emitRecipeEvent({
        kind: 'email.ingested',
        userId: String(userId),
        emailId: String(created._id),
        from: sender.address,
        subject: title,
        brandKey: brand ? brand.toLowerCase() : null,
        priority: 'normal',
        tags: topics,
      });
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

      source.websiteContentHash = contentHash;
      source.lastSyncAt = new Date();
      source.lastError = null;
      source.status = 'active';
      await source.save();

      logger.info(
        { sourceId: String(source._id), emailId: String(created._id), title },
        'website-sync: ingested updated snapshot',
      );
    },
    { connection: bullConnection(), concurrency: 4 },
  );
  worker.on('failed', (job, err) =>
    logger.error({ jobId: job?.id, err }, 'website-sync failed'),
  );
  return worker;
}
