import { Router } from 'express';
import crypto from 'node:crypto';
import { Types } from 'mongoose';
import { ImapFlow } from 'imapflow';
import {
  SourceCreateRequest,
  SourceUpdateRequest,
  SourceTestRequest,
  type ImapConfig,
  type RssConfig,
} from '@rose/shared';
import { userIdOf } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { Source, ApiToken, User } from '@rose/db';
import { formatImapError } from '@rose/email-parser';
import { encryptJson, decryptJson } from '../lib/crypto.js';
import { imapSyncQueue, gmailSyncQueue, rssSyncQueue } from '../lib/queues.js';
import { logger } from '../lib/logger.js';

export const sourcesRouter: Router = Router();

sourcesRouter.get('/', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const sources = await Source.find({ userId }).sort({ createdAt: -1 }).lean();
  res.json({ sources });
});

/** Returns the source plus a sanitized config (password redacted) for the edit form. */
sourcesRouter.get('/:id', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const src = await Source.findOne({ _id: req.params.id, userId }).select('+encryptedConfig');
  if (!src) {
    res.status(404).json({ error: 'not_found', message: 'Source not found' });
    return;
  }
  let config: Partial<ImapConfig> | RssConfig | null = null;
  if (src.type === 'imap' && src.encryptedConfig) {
    const decrypted = decryptJson<ImapConfig>(src.encryptedConfig);
    config = { ...decrypted, password: '' };
  } else if (src.type === 'rss' && src.encryptedConfig) {
    config = decryptJson<RssConfig>(src.encryptedConfig);
  }
  const obj = src.toObject();
  delete (obj as { encryptedConfig?: unknown }).encryptedConfig;
  res.json({ ...obj, config });
});

sourcesRouter.post('/', validateBody(SourceCreateRequest), async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const body = req.body as typeof SourceCreateRequest._type;

  if (body.type === 'imap') {
    const src = await Source.create({
      userId,
      type: 'imap',
      name: body.name,
      encryptedConfig: encryptJson(body.config),
      pollIntervalMinutes: body.config.pollIntervalMinutes,
    });
    const payload = { sourceId: src._id.toString(), userId: userId.toString() };
    // Repeatable job fires every N minutes starting at +N — kick off an
    // immediate one-shot so the user doesn't wait for the first interval.
    await imapSyncQueue.add('sync', payload, {
      repeat: { every: body.config.pollIntervalMinutes * 60_000 },
      jobId: `imap:${src._id.toString()}`,
    });
    await imapSyncQueue.add('sync', payload, {
      attempts: 3,
      removeOnComplete: 50,
      removeOnFail: 50,
    });
    res.status(201).json(src);
    return;
  }

  if (body.type === 'webhook') {
    const rawToken = crypto.randomBytes(24).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const src = await Source.create({ userId, type: 'webhook', name: body.name });
    await ApiToken.create({ userId, name: body.name, tokenHash, sourceId: src._id });
    res.status(201).json({
      source: src,
      token: rawToken,
      hint: 'Save this token. POST raw RFC822 to /api/webhook/email with header "Authorization: Bearer <token>".',
    });
    return;
  }

  if (body.type === 'rss') {
    const user = await User.findById(userId).select('settings').lean();
    const userDefault =
      (user?.settings as { rssPollIntervalMinutes?: number } | undefined)
        ?.rssPollIntervalMinutes ?? 30;
    const interval = body.config.pollIntervalMinutes ?? userDefault;
    const cfg: RssConfig = {
      url: body.config.url,
      pollIntervalMinutes: interval,
      historicalBackfillDays: body.config.historicalBackfillDays,
      maxPerSync: body.config.maxPerSync,
    };
    const src = await Source.create({
      userId,
      type: 'rss',
      name: body.name,
      encryptedConfig: encryptJson(cfg),
      pollIntervalMinutes: interval,
      rssFeedUrl: cfg.url,
    });
    const payload = { sourceId: src._id.toString(), userId: userId.toString() };
    await rssSyncQueue.add('sync', payload, {
      repeat: { every: interval * 60_000 },
      jobId: `rss:${src._id.toString()}`,
    });
    await rssSyncQueue.add('sync', payload, {
      attempts: 3,
      removeOnComplete: 50,
      removeOnFail: 50,
    });
    res.status(201).json(src);
    return;
  }

  if (body.type === 'gmail') {
    const src = await Source.create({
      userId,
      type: 'gmail',
      name: body.name,
      encryptedConfig: encryptJson({ authCode: body.authCode }),
      pollIntervalMinutes: body.pollIntervalMinutes,
      status: 'active',
    });
    const payload = { sourceId: src._id.toString(), userId: userId.toString() };
    await gmailSyncQueue.add('sync', payload, {
      repeat: { every: body.pollIntervalMinutes * 60_000 },
      jobId: `gmail:${src._id.toString()}`,
    });
    await gmailSyncQueue.add('sync', payload, {
      attempts: 3,
      removeOnComplete: 50,
      removeOnFail: 50,
    });
    res.status(201).json(src);
    return;
  }
});

/** Force an immediate one-shot sync for an IMAP or Gmail source. */
sourcesRouter.post('/:id/sync', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const src = await Source.findOne({ _id: req.params.id, userId });
  if (!src) {
    res.status(404).json({ error: 'not_found', message: 'Source not found' });
    return;
  }
  const payload = { sourceId: src._id.toString(), userId: userId.toString() };
  const opts = { attempts: 3, removeOnComplete: 50, removeOnFail: 50 } as const;
  if (src.type === 'imap') {
    const job = await imapSyncQueue.add('sync', payload, opts);
    res.status(202).json({ jobId: job.id });
    return;
  }
  if (src.type === 'gmail') {
    const job = await gmailSyncQueue.add('sync', payload, opts);
    res.status(202).json({ jobId: job.id });
    return;
  }
  if (src.type === 'rss') {
    const job = await rssSyncQueue.add('sync', payload, opts);
    res.status(202).json({ jobId: job.id });
    return;
  }
  res.status(400).json({
    error: 'invalid_request',
    message: `Source type "${src.type}" does not support manual sync`,
  });
});

/**
 * Connect to an IMAP server with the supplied config and report whether
 * authentication + mailbox listing succeed. Does not persist anything.
 */
async function testImap(config: ImapConfig): Promise<{ ok: true; mailboxes: string[] } | { ok: false; message: string }> {
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.username, pass: config.password },
    logger: false,
    socketTimeout: 8000,
  });
  try {
    await client.connect();
    const list = await client.list();
    return { ok: true, mailboxes: list.map((m) => m.path).slice(0, 100) };
  } catch (err) {
    logger.warn({ err, host: config.host, user: config.username }, 'IMAP test failed');
    return { ok: false, message: formatImapError(err, config.host) };
  } finally {
    await client.logout().catch(() => null);
  }
}

/**
 * Fetch an RSS/Atom feed and return its title + first few item titles, so
 * the user can confirm they pasted the right URL before saving.
 */
async function testRss(url: string): Promise<
  | { ok: true; feedTitle: string; sampleItems: { title: string; link: string | null }[] }
  | { ok: false; message: string }
> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Rose/1.0 (+https://rose.local)' },
      redirect: 'follow',
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { ok: false, message: `Feed responded ${res.status} ${res.statusText}` };
    const xml = await res.text();
    const Parser = (await import('rss-parser')).default;
    const parser = new Parser({ timeout: 10_000 });
    const feed = await parser.parseString(xml);
    const items = (feed.items ?? []).slice(0, 5).map((it) => ({
      title: it.title?.trim() || '(untitled)',
      link: it.link ?? null,
    }));
    return { ok: true, feedTitle: feed.title?.trim() || url, sampleItems: items };
  } catch (err) {
    return { ok: false, message: (err as Error).message || 'Failed to fetch feed' };
  }
}

sourcesRouter.post('/test', validateBody(SourceTestRequest), async (req, res) => {
  const body = req.body as typeof SourceTestRequest._type;
  if (body.type === 'imap') {
    const result = await testImap(body.config);
    res.status(result.ok ? 200 : 400).json(result);
    return;
  }
  if (body.type === 'rss') {
    const result = await testRss(body.config.url);
    res.status(result.ok ? 200 : 400).json(result);
    return;
  }
  res.status(400).json({ ok: false, message: 'Unsupported source type for test' });
});

sourcesRouter.patch('/:id', validateBody(SourceUpdateRequest), async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const src = await Source.findOne({ _id: req.params.id, userId }).select('+encryptedConfig');
  if (!src) {
    res.status(404).json({ error: 'not_found', message: 'Source not found' });
    return;
  }
  const body = req.body as typeof SourceUpdateRequest._type;
  if (body.name) src.name = body.name;
  if (body.status) src.status = body.status;

  // Resolve a top-level interval update from either body.pollIntervalMinutes
  // or body.config.pollIntervalMinutes (IMAP edit form puts it inside config).
  const requestedInterval =
    body.pollIntervalMinutes ?? body.config?.pollIntervalMinutes ?? null;
  const oldInterval = src.pollIntervalMinutes ?? 5;
  let newInterval = oldInterval;

  if (body.rssConfig && src.type === 'rss' && src.encryptedConfig) {
    const current = decryptJson<RssConfig>(src.encryptedConfig);
    const merged: RssConfig = {
      url: body.rssConfig.url ?? current.url,
      pollIntervalMinutes:
        body.rssConfig.pollIntervalMinutes ?? current.pollIntervalMinutes,
      historicalBackfillDays:
        body.rssConfig.historicalBackfillDays ?? current.historicalBackfillDays,
      maxPerSync: body.rssConfig.maxPerSync ?? current.maxPerSync,
    };
    src.encryptedConfig = encryptJson(merged);
    if (merged.url !== current.url) {
      // URL changed — the cached etag/last-modified are no longer valid.
      src.rssEtag = null;
      src.rssLastModified = null;
      src.rssFeedUrl = merged.url;
    }
    if (merged.pollIntervalMinutes) newInterval = merged.pollIntervalMinutes;
  } else if (body.config && src.type === 'imap' && src.encryptedConfig) {
    const current = decryptJson<ImapConfig>(src.encryptedConfig);
    // Password is sticky — empty/undefined means "keep what's stored".
    const merged: ImapConfig = {
      host: body.config.host ?? current.host,
      port: body.config.port ?? current.port,
      secure: body.config.secure ?? current.secure,
      username: body.config.username ?? current.username,
      password: body.config.password ?? current.password,
      mailbox: body.config.mailbox ?? current.mailbox,
      pollIntervalMinutes:
        body.config.pollIntervalMinutes ?? current.pollIntervalMinutes,
      historicalBackfillDays:
        body.config.historicalBackfillDays ?? current.historicalBackfillDays ?? 30,
      maxPerSync: body.config.maxPerSync ?? current.maxPerSync ?? 2000,
    };
    src.encryptedConfig = encryptJson(merged);
    newInterval = merged.pollIntervalMinutes;
  } else if (requestedInterval !== null) {
    newInterval = requestedInterval;
  }

  if (
    newInterval !== oldInterval &&
    (src.type === 'imap' || src.type === 'gmail' || src.type === 'rss')
  ) {
    const queue =
      src.type === 'imap'
        ? imapSyncQueue
        : src.type === 'gmail'
          ? gmailSyncQueue
          : rssSyncQueue;
    const repeatKey = `${src.type}:${src._id.toString()}`;
    await queue.removeRepeatableByKey(repeatKey).catch((err: Error) => {
      logger.warn({ err, repeatKey }, 'failed to remove old repeatable');
    });
    await queue.add(
      'sync',
      { sourceId: src._id.toString(), userId: userId.toString() },
      { repeat: { every: newInterval * 60_000 }, jobId: repeatKey },
    );
  }
  src.pollIntervalMinutes = newInterval;

  src.lastError = null;
  await src.save();
  // Don't echo encrypted config back to the client.
  src.encryptedConfig = null;
  res.json(src);
});

sourcesRouter.delete('/:id', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const src = await Source.findOne({ _id: req.params.id, userId });
  if (!src) {
    res.json({ ok: true });
    return;
  }
  if (src.type === 'imap')
    await imapSyncQueue.removeRepeatableByKey(`imap:${src._id.toString()}`).catch(() => null);
  if (src.type === 'gmail')
    await gmailSyncQueue.removeRepeatableByKey(`gmail:${src._id.toString()}`).catch(() => null);
  if (src.type === 'rss')
    await rssSyncQueue.removeRepeatableByKey(`rss:${src._id.toString()}`).catch(() => null);
  await ApiToken.deleteMany({ sourceId: src._id });
  await src.deleteOne();
  res.json({ ok: true });
});
