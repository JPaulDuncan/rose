import { Worker, type Job, Queue } from 'bullmq';
import { Types } from 'mongoose';
import { createHash } from 'node:crypto';
import Parser from 'rss-parser';
import { Source, Email, type SourceDoc } from '@rose/db';
import { priorityForDate, type WebsiteConfig } from '@rose/shared';
import { detectPromoCodesForEmail } from '@rose/promo-codes';
import { detectShipmentsForEmail } from '@rose/shipments';
import { senderDomainTag } from '@rose/email-parser';
import {
  resilientFetchHtml,
  browserFeedHeaders,
  type ResilientFetchOutcome,
} from '@rose/llm';
import { decryptJson } from '../lib/crypto.js';
import { emitRecipeEvent } from '../lib/recipeEmit.js';
import { assertSafeHttpUrl, UnsafeUrlError } from '../lib/safeFetch.js';
import { redis, bullConnection } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { extractArticle } from '../services/extractArticle.js';

const QUEUE = 'rose.website-sync';
const generateQueue = new Queue('rose.generate-page', { connection: bullConnection() });
// Sitemap-mode reuses the existing fetchAndParse worker — every
// URL surfaced from sitemap.xml goes through the same path as a
// user's manual "save URL" so the dedup + content-extract +
// page-generation pipeline stays one canonical flow.
const fetchAndParseQueue = new Queue('rose.fetch-and-parse', {
  connection: bullConnection(),
});

type WebsiteJobData = { sourceId: string; userId: string };

/**
 * Sitemap.xml URL extractor. Pulls every `<loc>...</loc>` value
 * via regex — the format is well-specified and we don't need full
 * XML semantics for this. Honours `<lastmod>` to skip URLs unchanged
 * since the source's last sync (so repeated polls don't re-queue
 * stable archives).
 *
 * Sitemap *index* files (where `<loc>` points to another sitemap.xml
 * rather than a content URL) are detected by the extension and one
 * level of nesting is followed. Beyond one level we stop — that's
 * the realistic shape; nested sitemaps deeper than that are rare
 * and would risk runaway recursion against a hostile sitemap.
 */
async function fetchSitemapUrls(
  url: string,
  since: Date | null,
  cap: number,
  depth = 0,
): Promise<string[]> {
  if (depth > 1) return [];
  let xml: string;
  try {
    await assertSafeHttpUrl(url);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20_000);
    let resp: Response;
    try {
      resp = await fetch(url, {
        headers: browserFeedHeaders(url),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!resp.ok) {
      throw new Error(`sitemap fetch returned ${resp.status}`);
    }
    xml = await resp.text();
  } catch (err) {
    if (err instanceof UnsafeUrlError) throw err;
    throw new Error(`sitemap fetch failed: ${(err as Error).message}`);
  }

  const isIndex = /<sitemapindex\b/i.test(xml);
  const out: string[] = [];

  // Extract <url><loc>...</loc>...<lastmod>...</lastmod></url> blocks.
  // The capture group below grabs the whole inner content of each
  // <url> or <sitemap> entry so we can pick out loc + lastmod.
  const blockRe = isIndex
    ? /<sitemap\b[\s\S]*?<\/sitemap>/gi
    : /<url\b[\s\S]*?<\/url>/gi;
  const locRe = /<loc>\s*([^<\s][^<]*?)\s*<\/loc>/i;
  const lastmodRe = /<lastmod>\s*([^<\s][^<]*?)\s*<\/lastmod>/i;

  for (const block of xml.match(blockRe) ?? []) {
    if (out.length >= cap) break;
    const loc = block.match(locRe)?.[1];
    if (!loc) continue;
    if (isIndex) {
      // Recurse one level into the referenced sitemap.
      const inner = await fetchSitemapUrls(
        loc,
        since,
        cap - out.length,
        depth + 1,
      ).catch(() => [] as string[]);
      for (const u of inner) {
        if (out.length >= cap) break;
        out.push(u);
      }
      continue;
    }
    // Skip URLs unchanged since the last sync, when both sides are
    // present + parseable. lastmod can be a full ISO datetime or
    // just a date — Date constructor handles both.
    if (since) {
      const lm = block.match(lastmodRe)?.[1];
      if (lm) {
        const lmDate = new Date(lm);
        if (Number.isFinite(lmDate.getTime()) && lmDate < since) continue;
      }
    }
    out.push(loc);
  }
  return out;
}

/**
 * Discover URLs from a sitemap, skip ones we already have an Email
 * for, and enqueue the rest through fetchAndParse. Returns the
 * count actually enqueued (post-dedup).
 */
async function syncSitemap(
  userId: Types.ObjectId,
  sitemapUrl: string,
  cap: number,
  since: Date | null,
): Promise<number> {
  const urls = await fetchSitemapUrls(sitemapUrl, since, cap);
  if (urls.length === 0) return 0;

  // Dedup against existing url-kind Email rows for this user. The
  // unique index on (userId, sourceUrl) is the ground truth, but a
  // pre-check avoids a queue full of jobs that will all skip on
  // insert. We pull just the URLs we'd otherwise re-enqueue.
  const existing = await Email.find({
    userId,
    kind: 'url',
    sourceUrl: { $in: urls },
  })
    .select('sourceUrl')
    .lean();
  const seen = new Set(existing.map((e) => String(e.sourceUrl)));

  let enqueued = 0;
  for (const url of urls) {
    if (seen.has(url)) continue;
    try {
      await fetchAndParseQueue.add(
        'sitemap-url',
        {
          kind: 'url',
          userId: String(userId),
          url,
          tags: [],
        },
        {
          attempts: 2,
          removeOnComplete: 200,
          removeOnFail: 200,
          // Sitemap discovery is bulk; let user-initiated saves
          // jump the queue ahead of these. Higher number = lower
          // priority in BullMQ.
          priority: 200,
        },
      );
      enqueued += 1;
    } catch (err) {
      logger.debug(
        { err: (err as Error).message, url },
        'sitemap: enqueue failed (continuing)',
      );
    }
  }
  return enqueued;
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

/**
 * Fetch + parse + ingest items from an RSS/Atom feed that we
 * discovered as the fallback path for a "watch a website" source.
 * Mirrors the per-item shape rssSync uses (kind: 'rss', feed sender,
 * categories → topics) so a feed-fallback page is indistinguishable
 * downstream from a native RSS source. Cap at 25 items per sync to
 * avoid flooding generate-page on a long-running blog's first
 * fallback hit.
 */
const feedParser = new Parser({ timeout: 15_000 });

async function ingestFeedFallback(
  userId: Types.ObjectId,
  source: SourceDoc,
  feedUrl: string,
): Promise<{ ingested: number; skippedDup: number }> {
  await assertSafeHttpUrl(feedUrl);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  let xml: string;
  try {
    const res = await fetch(feedUrl, {
      headers: browserFeedHeaders(feedUrl),
      redirect: 'follow',
      signal: ctrl.signal,
    });
    if (!res.ok) {
      throw new Error(`Feed fallback responded ${res.status} ${res.statusText}`);
    }
    xml = await res.text();
  } finally {
    clearTimeout(timer);
  }
  const feed = await feedParser.parseString(xml);
  const feedTitle = feed.title?.trim() || null;
  const items = (feed.items ?? []).slice(0, 25);

  let ingested = 0;
  let skippedDup = 0;
  for (const item of items) {
    const messageId = (item.guid || (item as { id?: string }).id || item.link || `${feedUrl}#${item.title ?? ''}#${item.isoDate ?? ''}`).slice(0, 998);
    const html = item['content:encoded'] || item.content || item.summary || '';
    const text = (item.contentSnippet || html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || '').trim();
    const rawHash = createHash('sha256').update(messageId).update(' ').update(text).digest('hex');
    const dup = await Email.findOne({ userId, $or: [{ messageId }, { rawHash }] })
      .select('_id')
      .lean();
    if (dup) {
      skippedDup += 1;
      continue;
    }
    const sender = senderForUrl(feedUrl, feedTitle);
    const brand = senderDomainTag(sender.address);
    const topics: string[] = [];
    if (brand) topics.push(brand.toLowerCase());
    for (const c of item.categories ?? []) {
      const t = c.trim().toLowerCase().replace(/\s+/g, '-');
      if (t.length >= 2 && t.length <= 60 && !topics.includes(t)) topics.push(t);
    }
    const date = item.isoDate ? new Date(item.isoDate) : new Date();
    const created = await Email.create({
      userId,
      sourceId: source._id,
      kind: 'rss',
      messageId,
      rawHash,
      from: sender,
      to: [],
      cc: [],
      subject: item.title?.trim() || '(untitled feed item)',
      date,
      text: text.slice(0, 20_000),
      rawText: text.slice(0, 20_000),
      html: html || null,
      attachments: [],
      priority: 'normal',
      topics,
      links: item.link ? [{ url: item.link, text: item.title ?? null }] : [],
      images: [],
      spamScore: 0,
      spamSignals: [],
      isMassMailing: false,
      authResults: { spf: 'unknown', dkim: 'unknown', dmarc: 'unknown' },
      unsubscribeUrls: [],
      ingestStatus: 'parsed',
    });
    await generateQueue.add(
      'generate',
      { emailId: String(created._id), userId: String(userId) },
      { attempts: 3, removeOnComplete: 500, removeOnFail: 500, priority: priorityForDate(date) },
    );
    await emitRecipeEvent({
      kind: 'email.ingested',
      userId: String(userId),
      emailId: String(created._id),
      from: sender.address,
      subject: item.title?.trim() ?? '',
      brandKey: brand ? brand.toLowerCase() : null,
      priority: 'normal',
      tags: topics,
    });
    ingested += 1;
  }
  return { ingested, skippedDup };
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

      // Sitemap mode (web-integration Phase 4). Runs BEFORE the
      // single-page fetch so the sitemap-discovery side-effect
      // happens even when the headline page hasn't changed (304).
      // Bounded by cfg.sitemapMaxUrlsPerSync so a sitemap with
      // 50k entries can't flood the fetchAndParse queue on first
      // run. Errors here are swallowed — the headline page is the
      // primary contract; sitemap discovery is opportunistic.
      if (cfg.sitemapUrl) {
        try {
          const queued = await syncSitemap(
            userId,
            cfg.sitemapUrl,
            cfg.sitemapMaxUrlsPerSync ?? 50,
            source.lastSyncAt ?? null,
          );
          if (queued > 0) {
            logger.info(
              { sourceId: String(source._id), sitemapUrl: cfg.sitemapUrl, queued },
              'website-sync: sitemap discovery enqueued URLs',
            );
          }
        } catch (err) {
          logger.warn(
            { err: (err as Error).message, sitemapUrl: cfg.sitemapUrl },
            'website-sync: sitemap pull failed (continuing with headline page)',
          );
        }
      }

      // Sticky feed fallback: once a previous sync flipped this
      // source over to its discovered RSS feed, keep using the feed
      // path on subsequent runs without re-probing the origin. The
      // user can clear `websiteFeedFallbackUrl` from the UI to force
      // a direct re-attempt if the site stops blocking us.
      if (source.websiteFeedFallbackUrl) {
        try {
          const stats = await ingestFeedFallback(
            userId,
            source,
            source.websiteFeedFallbackUrl,
          );
          source.websiteLastFetchVia = 'feed-fallback';
          source.lastSyncAt = new Date();
          source.lastError = null;
          source.status = 'active';
          await source.save();
          logger.info(
            { sourceId: String(source._id), feedUrl: source.websiteFeedFallbackUrl, ...stats },
            'website-sync: feed fallback ingested',
          );
          return;
        } catch (err) {
          // Feed went away too. Clear the sticky pointer so the next
          // sync re-runs the full discovery chain from scratch.
          source.websiteFeedFallbackUrl = null;
          source.lastError = (err as Error).message;
          source.status = 'error';
          await source.save();
          throw err;
        }
      }

      let outcome: ResilientFetchOutcome;
      try {
        outcome = await resilientFetchHtml(cfg.url, {
          cache: {
            etag: source.websiteEtag ?? null,
            lastModified: source.websiteLastModified ?? null,
          },
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

      // Discovered an RSS/Atom feed for the origin. Persist the URL
      // for sticky use on the next sync and ingest its items now.
      if (outcome.kind === 'feed') {
        source.websiteFeedFallbackUrl = outcome.feedUrl;
        source.websiteLastFetchVia = 'feed-fallback';
        const stats = await ingestFeedFallback(userId, source, outcome.feedUrl);
        source.lastSyncAt = new Date();
        source.lastError = null;
        source.status = 'active';
        await source.save();
        logger.info(
          {
            sourceId: String(source._id),
            feedUrl: outcome.feedUrl,
            via: outcome.discoveredVia,
            ...stats,
          },
          'website-sync: feed fallback discovered + ingested',
        );
        return;
      }

      // outcome.kind === 'html' — direct, rotated-ua, or wayback.
      source.websiteLastFetchVia = outcome.via;
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
