import { Worker, type Job, Queue } from 'bullmq';
import { Types } from 'mongoose';
import { createHash } from 'node:crypto';
import Parser from 'rss-parser';
import {
  LibrarySource,
  LibraryDocument,
  User,
  type LibrarySourceDoc,
} from '@rose/db';
import { redis, bullConnection } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { webFetch } from '@rose/llm';

const QUEUE = 'rose.library-sync';
const SWEEP_INTERVAL_MS = 5 * 60_000;

const embedQueue = new Queue('rose.library-embed', { connection: bullConnection() });

const parser = new Parser({
  headers: { 'User-Agent': 'Rose/1.0 (+https://rose.local; library)' },
  timeout: 15_000,
});

export type LibrarySyncJobData = { sourceId: string; userId: string };

/** Per-user / per-day crawl cap. Same shape as the Daydream cap.
 *  Counts documents *fetched and stored* (cache-busts that produce
 *  no new doc don't count). */
const crawlsToday = new Map<string, { day: string; count: number }>();
function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}
function bumpAndCheckCrawlCap(userId: string, cap: number): boolean {
  const day = todayKey();
  const cur = crawlsToday.get(userId);
  if (!cur || cur.day !== day) {
    crawlsToday.set(userId, { day, count: 1 });
    return true;
  }
  if (cur.count >= cap) return false;
  cur.count += 1;
  return true;
}

function urlHashOf(url: string): string {
  return createHash('sha256').update(url).digest('hex');
}

/**
 * Strip HTML to plain text. Lifted from rssSync's helper but kept
 * inline so library is self-contained. Preserves paragraph breaks
 * so the LLM still sees structure when it summarises.
 */
function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function pickTitleFromHtml(html: string): string {
  const ogm = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  if (ogm?.[1]) return ogm[1];
  const t = html.match(/<title>([^<]+)<\/title>/i);
  if (t?.[1]) return t[1].trim();
  return '';
}

function pickMetaDescription(html: string): string {
  const og = html.match(
    /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i,
  );
  if (og?.[1]) return og[1];
  const md = html.match(
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i,
  );
  if (md?.[1]) return md[1];
  return '';
}

const BODY_CAP = 50 * 1024;
function capBody(s: string): string {
  return s.length > BODY_CAP ? s.slice(0, BODY_CAP) : s;
}

/**
 * Persist or upsert a library document. Returns true when a new doc
 * was created (so the caller can decide whether to enqueue an embed).
 */
async function upsertDocument(
  userId: Types.ObjectId,
  source: LibrarySourceDoc,
  data: {
    url: string;
    title?: string;
    author?: string;
    publishedAt?: Date | null;
    summary?: string;
    bodyText?: string;
    tags?: string[];
  },
): Promise<{ docId: Types.ObjectId; created: boolean } | null> {
  const urlHash = urlHashOf(data.url);
  const existing = await LibraryDocument.findOne({ userId, urlHash })
    .select('_id')
    .lean();
  if (existing) {
    // Update body/title in place — the source might have edited the
    // post — but don't touch crawledAt so the staleAfter window is
    // preserved.
    await LibraryDocument.updateOne(
      { _id: existing._id },
      {
        $set: {
          title: data.title ?? '',
          author: data.author ?? '',
          publishedAt: data.publishedAt ?? null,
          summary: (data.summary ?? '').slice(0, 280),
          bodyText: capBody(data.bodyText ?? ''),
        },
      },
    );
    return { docId: existing._id, created: false };
  }
  const created = await LibraryDocument.create({
    userId,
    sourceId: source._id,
    url: data.url,
    urlHash,
    title: data.title ?? '',
    author: data.author ?? '',
    publishedAt: data.publishedAt ?? null,
    summary: (data.summary ?? '').slice(0, 280),
    bodyText: capBody(data.bodyText ?? ''),
    tags: [...new Set([...(source.tags ?? []), ...(data.tags ?? [])])],
    crawledAt: new Date(),
    // 30-day default re-crawl window for URL-kind docs; RSS feed
    // items don't get re-crawled (the next feed pull either re-
    // includes them or doesn't).
    staleAfter:
      source.kind === 'url' ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) : null,
  });
  return { docId: created._id, created: true };
}

async function syncRss(
  userId: Types.ObjectId,
  source: LibrarySourceDoc,
  cap: number,
): Promise<{ found: number; new: number }> {
  if (!source.url) return { found: 0, new: 0 };
  // rss-parser handles conditional GET internally if we pass etag/
  // lastModified via headers — but its default doesn't, so we set
  // them ourselves. A 304 makes parseURL throw; treat as "no change".
  const headers: Record<string, string> = {};
  if (source.etag) headers['if-none-match'] = source.etag;
  if (source.lastModified) headers['if-modified-since'] = source.lastModified;
  let feed;
  try {
    feed = await parser.parseURL(source.url);
  } catch (err) {
    const msg = (err as Error).message ?? '';
    if (/304/.test(msg)) return { found: 0, new: 0 };
    throw err;
  }
  const items = feed.items ?? [];
  let created = 0;
  for (const item of items) {
    if (!bumpAndCheckCrawlCap(String(userId), cap)) {
      logger.info({ userId: String(userId), cap }, 'library: daily cap hit; stopping sweep');
      break;
    }
    const url = item.link ?? '';
    if (!url) continue;
    // RSS bodies vary: prefer content:encoded > content > summary.
    const rich =
      (item as Parser.Item & { 'content:encoded'?: string })['content:encoded'] ??
      item.content ??
      item.summary ??
      '';
    const bodyText = htmlToText(rich);
    const r = await upsertDocument(userId, source, {
      url,
      title: item.title ?? '',
      author: item.creator ?? feed.title ?? '',
      publishedAt: item.isoDate ? new Date(item.isoDate) : null,
      summary: bodyText.slice(0, 280),
      bodyText,
      tags: ((item.categories ?? []) as string[]).filter(Boolean),
    });
    if (r?.created) {
      created += 1;
      await embedQueue.add(
        'embed',
        { documentId: String(r.docId), userId: String(userId) },
        { attempts: 3, removeOnComplete: 500, removeOnFail: 500, priority: 5 },
      );
    }
  }
  return { found: items.length, new: created };
}

async function syncUrl(
  userId: Types.ObjectId,
  source: LibrarySourceDoc,
  cap: number,
): Promise<{ found: number; new: number }> {
  if (!source.url) return { found: 0, new: 0 };
  if (!bumpAndCheckCrawlCap(String(userId), cap)) {
    return { found: 0, new: 0 };
  }
  const r = await webFetch(source.url, {
    timeoutMs: 12_000,
    caller: 'library.url',
    userAgent: 'Rose/1.0 (+https://rose.local; library)',
  });
  if (!r.ok || !r.body) {
    throw new Error(`fetch failed: ${r.status}`);
  }
  const html = r.body;
  const title = pickTitleFromHtml(html) || source.name;
  const summary = pickMetaDescription(html);
  const bodyText = htmlToText(html);
  const result = await upsertDocument(userId, source, {
    url: source.url,
    title,
    summary,
    bodyText,
  });
  if (result?.created) {
    await embedQueue.add(
      'embed',
      { documentId: String(result.docId), userId: String(userId) },
      { attempts: 3, removeOnComplete: 500, removeOnFail: 500, priority: 5 },
    );
    return { found: 1, new: 1 };
  }
  return { found: 1, new: 0 };
}

async function syncUrlList(
  userId: Types.ObjectId,
  source: LibrarySourceDoc,
  cap: number,
): Promise<{ found: number; new: number }> {
  let created = 0;
  let found = 0;
  for (const url of source.urls ?? []) {
    if (!bumpAndCheckCrawlCap(String(userId), cap)) {
      logger.info({ userId: String(userId), cap }, 'library: daily cap hit; partial urlList sweep');
      break;
    }
    found += 1;
    try {
      const r = await webFetch(url, {
        timeoutMs: 12_000,
        caller: 'library.urlList',
        userAgent: 'Rose/1.0 (+https://rose.local; library)',
      });
      if (!r.ok) continue;
      const html = r.body;
      const title = pickTitleFromHtml(html) || url;
      const summary = pickMetaDescription(html);
      const bodyText = htmlToText(html);
      const result = await upsertDocument(userId, source, {
        url,
        title,
        summary,
        bodyText,
      });
      if (result?.created) {
        created += 1;
        await embedQueue.add(
          'embed',
          { documentId: String(result.docId), userId: String(userId) },
          { attempts: 3, removeOnComplete: 500, removeOnFail: 500, priority: 5 },
        );
      }
    } catch (err) {
      logger.warn({ err, url }, 'library: urlList item failed (continuing)');
    }
  }
  return { found, new: created };
}

export function startLibrarySyncWorker(): void {
  const worker = new Worker<LibrarySyncJobData>(
    QUEUE,
    async (job: Job<LibrarySyncJobData>) => {
      const userId = new Types.ObjectId(job.data.userId);
      const source = (await LibrarySource.findOne({
        _id: job.data.sourceId,
        userId,
      })) as LibrarySourceDoc | null;
      if (!source) return { skipped: 'source-not-found' };
      if (source.status === 'paused') return { skipped: 'paused' };
      // Look up daily cap from the user's settings.
      const user = await User.findById(userId).select('settings.library').lean();
      const cap =
        (user?.settings as { library?: { dailyCrawlCap?: number } } | undefined)?.library
          ?.dailyCrawlCap ?? 500;
      let result: { found: number; new: number };
      try {
        if (source.kind === 'rss') result = await syncRss(userId, source, cap);
        else if (source.kind === 'url') result = await syncUrl(userId, source, cap);
        else if (source.kind === 'urlList') result = await syncUrlList(userId, source, cap);
        else return { skipped: 'kind-not-implemented', kind: source.kind };
        await LibrarySource.updateOne(
          { _id: source._id },
          {
            $set: {
              lastSyncAt: new Date(),
              lastError: null,
              status: 'active',
            },
          },
        );
        logger.info(
          { sourceId: String(source._id), kind: source.kind, ...result },
          'library: sync complete',
        );
        return result;
      } catch (err) {
        await LibrarySource.updateOne(
          { _id: source._id },
          {
            $set: {
              lastSyncAt: new Date(),
              lastError: (err as Error).message ?? 'unknown',
              status: 'error',
            },
          },
        );
        throw err;
      }
    },
    {
      connection: bullConnection(),
      concurrency: 2,
      lockDuration: 10 * 60_000,
      stalledInterval: 60_000,
      maxStalledCount: 2,
    },
  );
  worker.on('failed', (job, err) =>
    logger.error({ jobId: job?.id, err }, 'library-sync: failed'),
  );
  worker.on('error', (err) => logger.error({ err }, 'library-sync: worker error'));
}

/**
 * Sweeper: every few minutes, find sources whose `lastSyncAt + poll
 * interval` is in the past and enqueue. Skips paused/errored
 * sources. Library is per-user opt-in (settings.library.enabled);
 * sources owned by users who haven't enabled it are ignored.
 */
export function startLibrarySweeper(): void {
  let inFlight = false;
  const queue = new Queue<LibrarySyncJobData>(QUEUE, { connection: bullConnection() });
  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const now = new Date();
      // Two paths: sources never synced (lastSyncAt: null) and
      // sources where lastSyncAt + pollIntervalMinutes is in the
      // past. Combine via $expr so we can compute the threshold
      // server-side without pulling every row.
      const due = await LibrarySource.aggregate<{ _id: Types.ObjectId; userId: Types.ObjectId }>(
        [
          { $match: { status: 'active' } },
          {
            $match: {
              $expr: {
                $or: [
                  { $eq: ['$lastSyncAt', null] },
                  {
                    $lte: [
                      {
                        $add: [
                          '$lastSyncAt',
                          { $multiply: ['$pollIntervalMinutes', 60_000] },
                        ],
                      },
                      now,
                    ],
                  },
                ],
              },
            },
          },
          { $project: { userId: 1 } },
          { $limit: 50 },
        ],
      );
      if (due.length === 0) return;
      // Confirm the user has library enabled before enqueuing.
      const userIds = [...new Set(due.map((d) => String(d.userId)))];
      const enabledUsers = await User.find({
        _id: { $in: userIds.map((id) => new Types.ObjectId(id)) },
        'settings.library.enabled': true,
      })
        .select('_id')
        .lean();
      const okSet = new Set(enabledUsers.map((u) => String(u._id)));
      let enq = 0;
      for (const d of due) {
        if (!okSet.has(String(d.userId))) continue;
        await queue.add(
          'sync',
          { sourceId: String(d._id), userId: String(d.userId) },
          { attempts: 1, removeOnComplete: 200, removeOnFail: 200 },
        );
        enq += 1;
      }
      if (enq > 0) logger.debug({ enqueued: enq }, 'library-sweeper: tick');
    } catch (err) {
      logger.warn({ err }, 'library-sweeper: tick failed');
    } finally {
      inFlight = false;
    }
  };
  const handle = setInterval(() => void tick(), SWEEP_INTERVAL_MS);
  handle.unref();
  setTimeout(() => void tick(), 10_000).unref();
  logger.info({ intervalMs: SWEEP_INTERVAL_MS }, 'library-sweeper: started');
}
