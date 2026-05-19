import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import {
  LibrarySource,
  LibraryDocument,
  LibraryDocumentRef,
  User,
} from '@rose/db';
import {
  LibrarySourceCreate,
  LibrarySourceUpdate,
  LibrarySettingsUpdate,
} from '@rose/shared';
import { userIdOf } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { librarySyncQueue, postWriteHooksQueue } from '../lib/queues.js';

export const libraryRouter: Router = Router();

// ── Settings (mirrors the daydream settings shape) ────────────────

libraryRouter.get('/settings', async (req, res) => {
  const userId = userIdOf(req);
  const user = await User.findById(userId).select('settings.library').lean();
  const cfg = (user?.settings as { library?: unknown } | undefined)?.library ?? {};
  res.json({
    enabled: false,
    dailyCrawlCap: 500,
    useInDaydream: true,
    ...((cfg as Record<string, unknown>) ?? {}),
  });
});

libraryRouter.patch('/settings', validateBody(LibrarySettingsUpdate), async (req, res) => {
  const userId = userIdOf(req);
  const body = req.body as typeof LibrarySettingsUpdate._type;
  const update: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    update[`settings.library.${k}`] = v;
  }
  await User.findByIdAndUpdate(userId, { $set: update });
  res.json({ ok: true });
});

// ── Sources CRUD ──────────────────────────────────────────────────

libraryRouter.get('/sources', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  // ?status filters; default excludes rejected so the UI doesn't
  // surface dead entries. status='proposed' isolates the
  // suggestions panel; 'all' returns everything.
  const statusParam = (req.query.status as string | undefined) ?? null;
  const filter: Record<string, unknown> = { userId };
  if (statusParam === 'proposed') filter.status = 'proposed';
  else if (statusParam === 'active') filter.status = 'active';
  else if (statusParam !== 'all') filter.status = { $ne: 'rejected' };
  const sources = await LibrarySource.find(filter)
    .sort({ createdAt: -1 })
    .lean();
  // Attach a doc-count per source so the UI can render usage at a
  // glance without a follow-up call. Library is global; the
  // per-user count comes from LibraryDocumentRef.
  const counts = await LibraryDocumentRef.aggregate<{ _id: Types.ObjectId; count: number }>([
    { $match: { userId } },
    { $group: { _id: '$sourceId', count: { $sum: 1 } } },
  ]);
  const countMap = new Map<string, number>(
    counts.map((c) => [String(c._id), c.count]),
  );
  res.json({
    sources: sources.map((s) => ({
      _id: String(s._id),
      kind: s.kind,
      name: s.name,
      url: s.url ?? null,
      urlsCount: (s.urls ?? []).length,
      tags: s.tags ?? [],
      pollIntervalMinutes: s.pollIntervalMinutes,
      lastSyncAt: s.lastSyncAt ? s.lastSyncAt.toISOString() : null,
      lastError: s.lastError ?? null,
      status: s.status,
      proposalReason: (s.proposalReason as string | undefined) ?? null,
      proposalEvidence: (s.proposalEvidence as string[] | undefined) ?? [],
      docCount: countMap.get(String(s._id)) ?? 0,
    })),
  });
});

libraryRouter.post('/sources', validateBody(LibrarySourceCreate), async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const body = req.body as typeof LibrarySourceCreate._type;
  const created = await LibrarySource.create({
    userId,
    kind: body.kind,
    name: body.name,
    url: body.url ?? null,
    urls: body.urls ?? [],
    tags: body.tags ?? [],
    pollIntervalMinutes:
      body.pollIntervalMinutes ?? (body.kind === 'rss' ? 60 : 24 * 60),
    status: 'active',
  });
  // Kick an immediate sync so the user sees results without waiting
  // for the sweeper's next tick.
  await librarySyncQueue.add(
    'sync',
    { sourceId: String(created._id), userId: String(userId) },
    { attempts: 1, removeOnComplete: 200, removeOnFail: 200 },
  );
  res.status(201).json({ source: { _id: String(created._id) } });
});

libraryRouter.patch('/sources/:id', validateBody(LibrarySourceUpdate), async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const body = req.body as typeof LibrarySourceUpdate._type;
  await LibrarySource.updateOne(
    { _id: req.params.id, userId },
    { $set: body },
  );
  res.json({ ok: true });
});

libraryRouter.delete('/sources/:id', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  if (!Types.ObjectId.isValid(req.params.id)) {
    res.status(400).json({ error: 'invalid_request', message: 'invalid id' });
    return;
  }
  const sourceId = new Types.ObjectId(req.params.id);
  await LibrarySource.deleteOne({ _id: sourceId, userId });
  // Library is global — cascade only this user's refs. The shared
  // LibraryDocument rows stay so other users who reference the
  // same URLs (now or later) still benefit. A separate sweeper
  // can GC global rows that nobody refs anymore.
  const r = await LibraryDocumentRef.deleteMany({ sourceId, userId });
  res.json({ ok: true, documentsDeleted: r.deletedCount ?? 0 });
});

libraryRouter.post('/sources/:id/sync-now', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const source = await LibrarySource.findOne({ _id: req.params.id, userId })
    .select('_id')
    .lean();
  if (!source) {
    res.status(404).json({ error: 'not_found', message: 'source not found' });
    return;
  }
  const job = await librarySyncQueue.add(
    'sync',
    { sourceId: String(source._id), userId: String(userId) },
    { attempts: 1, removeOnComplete: 200, removeOnFail: 200 },
  );
  res.status(202).json({ jobId: job.id });
});

/**
 * Accept a proposed source — flips status from 'proposed' to
 * 'active', clears proposal-only fields, and kicks an immediate
 * sync so the user sees library docs without waiting for the next
 * scheduled tick.
 */
libraryRouter.post('/sources/:id/accept', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  if (!Types.ObjectId.isValid(req.params.id ?? '')) {
    res.status(400).json({ error: 'invalid_request' });
    return;
  }
  const cat = await LibrarySource.findOne({ _id: req.params.id, userId });
  if (!cat || cat.status !== 'proposed') {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  cat.status = 'active';
  cat.proposalReason = '';
  cat.proposalEvidence = [];
  await cat.save();
  await librarySyncQueue.add(
    'sync',
    { sourceId: String(cat._id), userId: String(userId) },
    { attempts: 1, removeOnComplete: 200, removeOnFail: 200 },
  );
  res.json({ ok: true, source: cat });
});

/**
 * Reject a proposed source — flips status to 'rejected' (kept as
 * a row so future proposer runs dedup against it and don't
 * re-suggest the same URL).
 */
libraryRouter.post('/sources/:id/reject', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  if (!Types.ObjectId.isValid(req.params.id ?? '')) {
    res.status(400).json({ error: 'invalid_request' });
    return;
  }
  const cat = await LibrarySource.findOne({ _id: req.params.id, userId });
  if (!cat || cat.status !== 'proposed') {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  cat.status = 'rejected';
  await cat.save();
  res.json({ ok: true, source: cat });
});

/**
 * Enqueue the library-source proposer for this user. Walks the
 * user's confident xMemory user-fact groups and proposes
 * RSS/sitemap/URL sources matching each theme. UI polls
 * /sources?status=proposed for results.
 */
libraryRouter.post('/sources/suggest', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  try {
    await postWriteHooksQueue.add(
      'library-suggest',
      { kind: 'library-suggest', userId: String(userId) },
      { attempts: 1, removeOnComplete: 20, removeOnFail: 20 },
    );
  } catch (err) {
    res.status(503).json({ error: 'enqueue_failed', message: (err as Error).message });
    return;
  }
  res.status(202).json({ ok: true });
});

// ── Documents (search + read + delete) ────────────────────────────

const SearchQuery = z.object({
  q: z.string().min(1).max(200),
  tag: z.string().optional(),
  sourceId: z.string().optional(),
  since: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

/**
 * Build the per-user visibility set: which global LibraryDocument
 * IDs can the current user see, narrowed by an optional source.
 * Library is global; user visibility is gated by Refs.
 */
async function visibleDocIdsFor(
  userId: Types.ObjectId,
  filters: { sourceId?: Types.ObjectId | null } = {},
  cap = 5_000,
): Promise<Types.ObjectId[]> {
  const refFilter: Record<string, unknown> = { userId, archivedAt: null };
  if (filters.sourceId) refFilter.sourceId = filters.sourceId;
  const refs = await LibraryDocumentRef.find(refFilter)
    .select('documentId')
    .limit(cap)
    .lean();
  return refs.map((r) => r.documentId as Types.ObjectId);
}

libraryRouter.get('/', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const parsed = SearchQuery.safeParse(req.query);
  if (!parsed.success) {
    // No query = recent-feed view. Pull the user's refs first
    // (cheap, indexed) then hydrate the underlying global docs.
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const tag = (req.query.tag as string | undefined) ?? null;
    const refFilter: Record<string, unknown> = { userId, archivedAt: null };
    const refs = await LibraryDocumentRef.find(refFilter)
      .sort({ addedAt: -1 })
      .limit(limit * 2)
      .select('documentId addedAt')
      .lean();
    const docIds = refs.map((r) => r.documentId as Types.ObjectId);
    if (docIds.length === 0) {
      res.json({ mode: 'recent', documents: [] });
      return;
    }
    const docFilter: Record<string, unknown> = { _id: { $in: docIds } };
    if (tag) docFilter.tags = tag;
    const docs = await LibraryDocument.find(docFilter)
      .sort({ publishedAt: -1, crawledAt: -1 })
      .limit(limit)
      .select('-bodyText -embedding')
      .lean();
    res.json({ mode: 'recent', documents: docs.map(shapeDoc) });
    return;
  }
  const { q, tag, sourceId, since, limit } = parsed.data;
  const visibleIds = await visibleDocIdsFor(userId, {
    sourceId: sourceId ? new Types.ObjectId(sourceId) : null,
  });
  if (visibleIds.length === 0) {
    res.json({ mode: 'search', query: q, documents: [] });
    return;
  }
  const filter: Record<string, unknown> = {
    _id: { $in: visibleIds },
    $text: { $search: q },
  };
  if (tag) filter.tags = tag;
  if (since) filter.publishedAt = { $gte: new Date(since) };
  const docs = await LibraryDocument.find(filter, {
    score: { $meta: 'textScore' },
  })
    .sort({ score: { $meta: 'textScore' } })
    .limit(limit)
    .select('-bodyText -embedding')
    .lean();
  res.json({
    mode: 'search',
    query: q,
    documents: docs.map(shapeDoc),
  });
});

libraryRouter.get('/:id', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  if (!Types.ObjectId.isValid(req.params.id)) {
    res.status(400).json({ error: 'invalid_request', message: 'invalid id' });
    return;
  }
  // Visibility check via the user's Ref. Without a ref the user
  // cannot read the doc even though it lives in the global pool.
  const ref = await LibraryDocumentRef.findOne({
    userId,
    documentId: req.params.id,
  }).lean();
  if (!ref) {
    res.status(404).json({ error: 'not_found', message: 'document not found' });
    return;
  }
  const doc = await LibraryDocument.findById(req.params.id).lean();
  if (!doc) {
    res.status(404).json({ error: 'not_found', message: 'document not found' });
    return;
  }
  // Mark read so the unread badge clears. Idempotent enough.
  if (!ref.readAt) {
    await LibraryDocumentRef.updateOne(
      { _id: ref._id },
      { $set: { readAt: new Date() } },
    );
  }
  const { embedding: _e, ...rest } = doc as typeof doc & { embedding?: number[] };
  res.json({ document: shapeDoc(rest) });
});

libraryRouter.delete('/:id', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  // Per-user delete = drop the ref. The global document remains
  // (other users may still reference it); a separate sweeper can
  // GC orphaned global rows.
  await LibraryDocumentRef.deleteOne({ userId, documentId: req.params.id });
  res.json({ ok: true });
});

function shapeDoc(d: {
  _id: Types.ObjectId | string;
  sourceId?: Types.ObjectId | null;
  url: string;
  title?: string;
  author?: string;
  publishedAt?: Date | null;
  summary?: string;
  bodyText?: string;
  topics?: string[];
  tags?: string[];
  crawledAt?: Date;
}): Record<string, unknown> {
  return {
    _id: String(d._id),
    sourceId: d.sourceId ? String(d.sourceId) : null,
    url: d.url,
    title: d.title ?? '',
    author: d.author ?? '',
    publishedAt: d.publishedAt ? d.publishedAt.toISOString() : null,
    summary: d.summary ?? '',
    bodyText: d.bodyText ?? undefined,
    topics: d.topics ?? [],
    tags: d.tags ?? [],
    crawledAt: d.crawledAt ? d.crawledAt.toISOString() : null,
  };
}

// ── OPML import / export ──────────────────────────────────────────

/**
 * Tiny OPML parser. Walks <outline xmlUrl="…" title="…" /> elements
 * (RSS-flavoured OPML — the only flavour the wider ecosystem
 * actually emits) and returns a flat list. Skips OPML that's
 * malformed enough to not contain any xmlUrls.
 */
function parseOpml(xml: string): { url: string; name: string; tags: string[] }[] {
  const out: { url: string; name: string; tags: string[] }[] = [];
  // Walk every <outline …> tag. Naive regex parse — OPML is flat
  // enough that pulling attribute pairs gets us where we need.
  const tagRe = /<outline\b([^>]*?)\/?>/gi;
  // Track section titles so we can tag feeds by their containing folder.
  // Simple stack: when we see an <outline …> with no xmlUrl that has
  // children, treat its title as a tag for everything until the
  // matching </outline>.
  let match: RegExpExecArray | null;
  const folderTags: string[] = [];
  // For folder tracking we also walk a separate regex over open/close.
  void folderTags;
  while ((match = tagRe.exec(xml)) !== null) {
    const attrs = match[1] ?? '';
    const xmlUrl =
      /\bxmlUrl=["']([^"']+)["']/i.exec(attrs)?.[1] ??
      /\bxmlurl=["']([^"']+)["']/i.exec(attrs)?.[1] ??
      '';
    if (!xmlUrl) continue;
    const title =
      /\btitle=["']([^"']+)["']/i.exec(attrs)?.[1] ??
      /\btext=["']([^"']+)["']/i.exec(attrs)?.[1] ??
      xmlUrl;
    out.push({ url: xmlUrl, name: title, tags: [] });
  }
  return out;
}

const OpmlImport = z.object({
  opml: z.string().min(10).max(5 * 1024 * 1024),
  defaultTags: z.array(z.string()).max(20).default([]),
});

libraryRouter.post('/sources/import-opml', validateBody(OpmlImport), async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const body = req.body as typeof OpmlImport._type;
  const feeds = parseOpml(body.opml);
  if (feeds.length === 0) {
    res.status(400).json({
      error: 'invalid_request',
      message: 'No <outline xmlUrl="…"> elements found in the OPML.',
    });
    return;
  }
  // Dedup by URL against existing sources for this user.
  const existing = new Set(
    (
      await LibrarySource.find({ userId, kind: 'rss' })
        .select('url')
        .lean()
    )
      .map((s) => s.url)
      .filter((u): u is string => !!u),
  );
  const fresh = feeds.filter((f) => !existing.has(f.url));
  if (fresh.length > 0) {
    await LibrarySource.insertMany(
      fresh.map((f) => ({
        userId,
        kind: 'rss',
        name: f.name,
        url: f.url,
        tags: [...new Set([...f.tags, ...body.defaultTags])],
        pollIntervalMinutes: 60,
        status: 'active',
      })),
    );
  }
  res.status(201).json({
    parsed: feeds.length,
    created: fresh.length,
    duplicate: feeds.length - fresh.length,
  });
});

libraryRouter.get('/sources/export-opml', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const sources = await LibrarySource.find({ userId, kind: 'rss', status: { $ne: 'paused' } })
    .select('name url')
    .lean();
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="1.0">
  <head><title>Rose Library — RSS sources</title></head>
  <body>
${sources
  .map(
    (s) =>
      `    <outline type="rss" text="${escapeXml(s.name)}" title="${escapeXml(s.name)}" xmlUrl="${escapeXml(s.url ?? '')}" />`,
  )
  .join('\n')}
  </body>
</opml>`;
  res.set('content-type', 'text/x-opml; charset=utf-8');
  res.set('content-disposition', 'attachment; filename="rose-library.opml"');
  res.send(xml);
});

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
