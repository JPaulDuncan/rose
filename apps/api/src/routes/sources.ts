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
  type WebsiteConfig,
} from '@rose/shared';
import { userIdOf } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { Source, ApiToken, User } from '@rose/db';
import { formatImapError } from '@rose/email-parser';
import { encryptJson, decryptJson } from '../lib/crypto.js';
import {
  imapSyncQueue,
  gmailSyncQueue,
  rssSyncQueue,
  websiteSyncQueue,
  slackSyncQueue,
  discordSyncQueue,
  gcalSyncQueue,
} from '../lib/queues.js';
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
  let config: Partial<ImapConfig> | RssConfig | WebsiteConfig | null = null;
  if (src.type === 'imap' && src.encryptedConfig) {
    const decrypted = decryptJson<ImapConfig>(src.encryptedConfig);
    config = { ...decrypted, password: '' };
  } else if (src.type === 'rss' && src.encryptedConfig) {
    config = decryptJson<RssConfig>(src.encryptedConfig);
  } else if (src.type === 'website' && src.encryptedConfig) {
    config = decryptJson<WebsiteConfig>(src.encryptedConfig);
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
    // 30 minutes is the global default for new feeds. Per-feed
    // pollIntervalMinutes still wins when the user sets one
    // explicitly via the create form or the per-feed editor.
    const interval = body.config.pollIntervalMinutes ?? 30;
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

  if (body.type === 'slack') {
    const interval = body.config.pollIntervalMinutes;
    const src = await Source.create({
      userId,
      type: 'slack',
      name: body.name,
      encryptedConfig: encryptJson(body.config),
      pollIntervalMinutes: interval,
    });
    const payload = { sourceId: src._id.toString(), userId: userId.toString() };
    await slackSyncQueue.add('sync', payload, {
      repeat: { every: interval * 60_000 },
      jobId: `slack:${src._id.toString()}`,
    });
    await slackSyncQueue.add('sync', payload, {
      attempts: 3,
      removeOnComplete: 50,
      removeOnFail: 50,
    });
    res.status(201).json(src);
    return;
  }

  if (body.type === 'discord') {
    const interval = body.config.pollIntervalMinutes;
    const src = await Source.create({
      userId,
      type: 'discord',
      name: body.name,
      encryptedConfig: encryptJson(body.config),
      pollIntervalMinutes: interval,
    });
    const payload = { sourceId: src._id.toString(), userId: userId.toString() };
    await discordSyncQueue.add('sync', payload, {
      repeat: { every: interval * 60_000 },
      jobId: `discord:${src._id.toString()}`,
    });
    await discordSyncQueue.add('sync', payload, {
      attempts: 3,
      removeOnComplete: 50,
      removeOnFail: 50,
    });
    res.status(201).json(src);
    return;
  }

  if (body.type === 'website') {
    const interval = body.config.pollIntervalMinutes;
    const cfg: WebsiteConfig = {
      url: body.config.url,
      pollIntervalMinutes: interval,
      sitemapMaxUrlsPerSync: body.config.sitemapMaxUrlsPerSync ?? 50,
      ...(body.config.sitemapUrl ? { sitemapUrl: body.config.sitemapUrl } : {}),
    };
    const src = await Source.create({
      userId,
      type: 'website',
      name: body.name,
      encryptedConfig: encryptJson(cfg),
      pollIntervalMinutes: interval,
      websiteUrl: cfg.url,
    });
    const payload = { sourceId: src._id.toString(), userId: userId.toString() };
    await websiteSyncQueue.add('sync', payload, {
      repeat: { every: interval * 60_000 },
      jobId: `website:${src._id.toString()}`,
    });
    await websiteSyncQueue.add('sync', payload, {
      attempts: 3,
      removeOnComplete: 50,
      removeOnFail: 50,
    });
    res.status(201).json(src);
    return;
  }

  if (body.type === 'gcal') {
    const interval = body.config.pollIntervalMinutes;
    const src = await Source.create({
      userId,
      type: 'gcal',
      name: body.name,
      encryptedConfig: encryptJson(body.config),
      pollIntervalMinutes: interval,
    });
    const payload = { sourceId: src._id.toString(), userId: userId.toString() };
    await gcalSyncQueue.add('sync', payload, {
      repeat: { every: interval * 60_000 },
      jobId: `gcal:${src._id.toString()}`,
    });
    await gcalSyncQueue.add('sync', payload, {
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
  if (src.type === 'slack') {
    const job = await slackSyncQueue.add('sync', payload, opts);
    res.status(202).json({ jobId: job.id });
    return;
  }
  if (src.type === 'discord') {
    const job = await discordSyncQueue.add('sync', payload, opts);
    res.status(202).json({ jobId: job.id });
    return;
  }
  if (src.type === 'gcal') {
    const job = await gcalSyncQueue.add('sync', payload, opts);
    res.status(202).json({ jobId: job.id });
    return;
  }
  if (src.type === 'rss') {
    const job = await rssSyncQueue.add('sync', payload, opts);
    res.status(202).json({ jobId: job.id });
    return;
  }
  if (src.type === 'website') {
    const job = await websiteSyncQueue.add('sync', payload, opts);
    res.status(202).json({ jobId: job.id });
    return;
  }
  res.status(400).json({
    error: 'invalid_request',
    message: `Source type "${src.type}" does not support manual sync`,
  });
});

/**
 * One-shot "pull every message" trigger for an IMAP source.
 *
 * Flips the encrypted config to historicalBackfillDays=0 (the
 * pull-everything sentinel) and maxPerSync=0 (unlimited), clears
 * `lastSyncAt` so the worker uses the unbounded search rather than
 * an incremental one, and queues an immediate sync.
 *
 * The poll interval and other config stay untouched, so once the
 * backfill finishes subsequent runs are incremental as before.
 */
sourcesRouter.post('/:id/backfill-all', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const src = await Source.findOne({ _id: req.params.id, userId }).select('+encryptedConfig');
  if (!src) {
    res.status(404).json({ error: 'not_found', message: 'Source not found' });
    return;
  }
  if (src.type !== 'imap' || !src.encryptedConfig) {
    res.status(400).json({
      error: 'invalid_request',
      message: 'Backfill-all only applies to IMAP sources',
    });
    return;
  }
  const current = decryptJson<ImapConfig>(src.encryptedConfig);
  const merged: ImapConfig = {
    ...current,
    historicalBackfillDays: 0,
    maxPerSync: 0,
  };
  src.encryptedConfig = encryptJson(merged);
  src.lastSyncAt = null;
  src.lastError = null;
  src.status = 'active';
  await src.save();
  const job = await imapSyncQueue.add(
    'sync',
    { sourceId: src._id.toString(), userId: userId.toString() },
    { attempts: 3, removeOnComplete: 50, removeOnFail: 50 },
  );
  res.status(202).json({ jobId: job.id });
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

/**
 * Stateless preview: fetch the URL, run Readability, return the page title and
 * a short snippet so the user can confirm the parser picks up real content
 * before saving the source.
 */
async function testWebsite(url: string): Promise<
  | { ok: true; pageTitle: string; snippet: string; finalUrl: string }
  | { ok: false; message: string }
> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Rose/1.0 (+https://rose.local)',
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return { ok: false, message: `Page responded ${res.status} ${res.statusText}` };
    }
    const ct = (res.headers.get('content-type') ?? '').toLowerCase();
    if (!ct.includes('text/html') && !ct.includes('application/xhtml+xml')) {
      return { ok: false, message: `Unsupported content-type: ${ct || 'unknown'}` };
    }
    const html = await res.text();
    // Lightweight preview: pull <title> + a stripped-text snippet without
    // dragging Readability/linkedom into the API bundle. The worker runs
    // the full extractor when it actually syncs.
    const titleMatch = html.match(/<title[^>]*>([^<]{1,200})<\/title>/i);
    const ogTitleMatch = html.match(
      /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']{1,200})["']/i,
    );
    const ogDescMatch = html.match(
      /<meta[^>]+name=["']description["'][^>]+content=["']([^"']{1,500})["']/i,
    );
    const title = (
      ogTitleMatch?.[1] ??
      titleMatch?.[1] ??
      url
    )
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .trim()
      .slice(0, 200);
    const stripped = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const snippet = (ogDescMatch?.[1] ?? stripped).trim().slice(0, 280);
    if (!snippet) return { ok: false, message: 'No readable content extracted' };
    return { ok: true, pageTitle: title, snippet, finalUrl: res.url };
  } catch (err) {
    return { ok: false, message: (err as Error).message || 'Failed to fetch page' };
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
  if (body.type === 'website') {
    const result = await testWebsite(body.config.url);
    res.status(result.ok ? 200 : 400).json(result);
    return;
  }
  if (body.type === 'slack') {
    const result = await testSlack(body.config.token);
    res.status(result.ok ? 200 : 400).json(result);
    return;
  }
  if (body.type === 'discord') {
    const result = await testDiscord(body.config.botToken, body.config.guildId);
    res.status(result.ok ? 200 : 400).json(result);
    return;
  }
  res.status(400).json({ ok: false, message: 'Unsupported source type for test' });
});

/** Resolve a Slack workspace + list channels using the supplied token.
 *  Also doubles as a connectivity check before saving the source. */
async function testSlack(token: string): Promise<
  | {
      ok: true;
      workspaceName: string;
      channels: { id: string; name: string; isPrivate?: boolean }[];
    }
  | { ok: false; message: string }
> {
  try {
    const auth = await fetch('https://slack.com/api/auth.test', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: '',
      signal: AbortSignal.timeout(8_000),
    });
    const aj = (await auth.json()) as { ok?: boolean; team?: string; error?: string };
    if (!aj.ok) return { ok: false, message: aj.error ?? 'Slack auth.test failed' };
    const list = await fetch(
      'https://slack.com/api/conversations.list?types=public_channel,private_channel&exclude_archived=true&limit=200',
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      },
    );
    const lj = (await list.json()) as {
      ok?: boolean;
      channels?: { id: string; name: string; is_private?: boolean }[];
      error?: string;
    };
    if (!lj.ok) return { ok: false, message: lj.error ?? 'conversations.list failed' };
    return {
      ok: true,
      workspaceName: aj.team ?? 'Slack workspace',
      channels: (lj.channels ?? []).map((c) => ({
        id: c.id,
        name: c.name,
        isPrivate: !!c.is_private,
      })),
    };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

/** Verify a Discord bot token + guild + list text channels. */
async function testDiscord(
  botToken: string,
  guildId: string,
): Promise<
  | {
      ok: true;
      workspaceName: string;
      channels: { id: string; name: string }[];
    }
  | { ok: false; message: string }
> {
  try {
    const guildRes = await fetch(`https://discord.com/api/v10/guilds/${guildId}`, {
      headers: { Authorization: `Bot ${botToken}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!guildRes.ok) {
      const body = await guildRes.text().catch(() => '');
      return { ok: false, message: `Discord HTTP ${guildRes.status}: ${body.slice(0, 200)}` };
    }
    const guild = (await guildRes.json()) as { name?: string };
    const chRes = await fetch(`https://discord.com/api/v10/guilds/${guildId}/channels`, {
      headers: { Authorization: `Bot ${botToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!chRes.ok) {
      return { ok: false, message: `Discord channels HTTP ${chRes.status}` };
    }
    const all = (await chRes.json()) as { id: string; name: string; type: number }[];
    return {
      ok: true,
      workspaceName: guild.name ?? `Guild ${guildId}`,
      channels: all
        .filter((c) => [0, 5].includes(c.type))
        .map((c) => ({ id: c.id, name: c.name })),
    };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

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

  if (body.websiteConfig && src.type === 'website' && src.encryptedConfig) {
    const current = decryptJson<WebsiteConfig>(src.encryptedConfig);
    const nextSitemapUrl =
      body.websiteConfig.sitemapUrl === null
        ? undefined
        : body.websiteConfig.sitemapUrl ?? current.sitemapUrl;
    const merged: WebsiteConfig = {
      url: body.websiteConfig.url ?? current.url,
      pollIntervalMinutes:
        body.websiteConfig.pollIntervalMinutes ?? current.pollIntervalMinutes,
      sitemapMaxUrlsPerSync:
        body.websiteConfig.sitemapMaxUrlsPerSync ??
        current.sitemapMaxUrlsPerSync ??
        50,
      ...(nextSitemapUrl ? { sitemapUrl: nextSitemapUrl } : {}),
    };
    src.encryptedConfig = encryptJson(merged);
    if (merged.url !== current.url) {
      // URL changed — caches are no longer meaningful.
      src.websiteEtag = null;
      src.websiteLastModified = null;
      src.websiteContentHash = null;
      src.websiteTitle = null;
      src.websiteUrl = merged.url;
    }
    newInterval = merged.pollIntervalMinutes;
  } else if (body.rssConfig && src.type === 'rss' && src.encryptedConfig) {
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

    // The worker's incremental search uses lastSyncAt as its lower
    // bound, so just bumping `historicalBackfillDays` in the form
    // wouldn't widen the next sync's window — the new value would
    // never apply on a source that's already been syncing. Detect
    // the change here and reset lastSyncAt to either:
    //   • null         (when newDays = 0, the "pull everything"
    //                   sentinel — worker walks the entire mailbox)
    //   • now-newDays  (otherwise — worker re-walks the requested
    //                   window once; subsequent syncs are
    //                   incremental from the just-set lastSyncAt)
    // Don't reset when the new value would *narrow* the window
    // (lastSyncAt already captures everything within the new days).
    if (
      body.config.historicalBackfillDays !== undefined &&
      merged.historicalBackfillDays !== current.historicalBackfillDays
    ) {
      const newDays = merged.historicalBackfillDays;
      if (newDays === 0) {
        src.lastSyncAt = null;
      } else {
        const desiredFloor = new Date(Date.now() - newDays * 24 * 3600 * 1000);
        if (!src.lastSyncAt || desiredFloor < src.lastSyncAt) {
          src.lastSyncAt = desiredFloor;
        }
      }
    }
  } else if (requestedInterval !== null) {
    newInterval = requestedInterval;
  }

  if (
    newInterval !== oldInterval &&
    (src.type === 'imap' ||
      src.type === 'gmail' ||
      src.type === 'rss' ||
      src.type === 'website' ||
      src.type === 'slack' ||
      src.type === 'discord' ||
      src.type === 'gcal')
  ) {
    const queue =
      src.type === 'imap'
        ? imapSyncQueue
        : src.type === 'gmail'
          ? gmailSyncQueue
          : src.type === 'rss'
            ? rssSyncQueue
            : src.type === 'website'
              ? websiteSyncQueue
              : src.type === 'slack'
                ? slackSyncQueue
                : src.type === 'discord'
                  ? discordSyncQueue
                  : gcalSyncQueue;
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
  if (src.type === 'website')
    await websiteSyncQueue
      .removeRepeatableByKey(`website:${src._id.toString()}`)
      .catch(() => null);
  if (src.type === 'slack')
    await slackSyncQueue.removeRepeatableByKey(`slack:${src._id.toString()}`).catch(() => null);
  if (src.type === 'discord')
    await discordSyncQueue.removeRepeatableByKey(`discord:${src._id.toString()}`).catch(() => null);
  if (src.type === 'gcal')
    await gcalSyncQueue.removeRepeatableByKey(`gcal:${src._id.toString()}`).catch(() => null);
  await ApiToken.deleteMany({ sourceId: src._id });
  await src.deleteOne();
  res.json({ ok: true });
});
