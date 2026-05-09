import { Router } from 'express';
import { Types } from 'mongoose';
import {
  Entity,
  Page,
  DaydreamNote,
  Sender,
  User,
  Organization,
  normalizeTagKey,
  ENTITY_TYPES,
  daydreamSubjectKey,
} from '@rose/db';
import { userIdOf } from '../middleware/auth.js';
import { daydreamQueue } from '../lib/queues.js';
import { llmForceLimiter } from '../middleware/rateLimit.js';

export const entitiesRouter: Router = Router();

/**
 * Lightweight directory of every entity the user has, sorted by
 * page count. Used by a future Settings → Entities surface and by
 * the auto-linker as a warm cache. Cap at 500 — the directory is
 * not paginated yet, and the auto-linker per-page is bounded by
 * Page.entities[] anyway.
 */
/**
 * Create a new entity row by hand. The auto-extractor doesn't always
 * pick everything up; this gives the user an explicit "add to my
 * taxonomy" affordance from Settings → Entities. Returns 409 when
 * the kebab key already exists (use Edit / Merge for those).
 */
entitiesRouter.post('/', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const body = (req.body ?? {}) as {
    displayName?: string;
    type?: string;
    aliases?: string[];
  };
  const displayName = (body.displayName ?? '').trim();
  if (!displayName) {
    res.status(400).json({ error: 'invalid_request', message: 'displayName is required' });
    return;
  }
  const type = body.type;
  if (
    type !== 'person' &&
    type !== 'work' &&
    type !== 'organization' &&
    type !== 'place'
  ) {
    res.status(400).json({
      error: 'invalid_request',
      message: 'type must be one of "person", "work", "organization", "place"',
    });
    return;
  }
  const key = normalizeTagKey(displayName);
  if (!key) {
    res.status(400).json({ error: 'invalid_request', message: 'displayName produces no valid key' });
    return;
  }
  const existing = await Entity.findOne({ userId, $or: [{ key }, { aliases: key }] }).lean();
  if (existing) {
    res.status(409).json({
      error: 'entity_exists',
      message: `"${existing.key}" already exists.`,
    });
    return;
  }
  const aliases = Array.isArray(body.aliases)
    ? [
        ...new Set(
          body.aliases
            .map((a) => normalizeTagKey(String(a)))
            .filter((a) => a && a !== key),
        ),
      ]
    : [];
  const created = await Entity.create({
    userId,
    key,
    displayName: displayName.slice(0, 200),
    type,
    aliases,
    pageCount: 0,
    lastSeenAt: new Date(),
  });
  // Organizations are global — dual-write so other users see this
  // org on /n/<key>. setOnInsert keeps an existing canonical name
  // intact; the per-user displayName edit lives on Entity.
  if (type === 'organization') {
    try {
      await Organization.updateOne(
        { key },
        {
          $setOnInsert: {
            key,
            displayName: displayName.slice(0, 200),
            firstSeenBy: userId,
          },
          ...(aliases.length
            ? { $addToSet: { aliases: { $each: aliases } } }
            : {}),
        },
        { upsert: true },
      );
    } catch {
      // Best-effort; the per-user row succeeded.
    }
  }
  res.status(201).json({
    key: created.key,
    displayName: created.displayName,
    type: created.type,
    aliases: (created.aliases as string[] | undefined) ?? [],
  });
});

entitiesRouter.get('/', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const type = req.query.type as string | undefined;
  const filter: Record<string, unknown> = { userId };
  if (
    type === 'person' ||
    type === 'work' ||
    type === 'organization' ||
    type === 'place'
  ) {
    filter.type = type;
  }
  const rows = await Entity.find(filter)
    .sort({ pageCount: -1, displayName: 1 })
    .limit(500)
    .select('key displayName type aliases pageCount lastSeenAt')
    .lean();
  res.json({
    entities: rows.map((r) => ({
      key: r.key,
      displayName: r.displayName,
      type: r.type,
      aliases: (r.aliases as string[] | undefined) ?? [],
      pageCount: r.pageCount ?? 0,
      lastSeenAt: r.lastSeenAt ? new Date(r.lastSeenAt as Date).toISOString() : null,
    })),
  });
});

/**
 * Aggregated entity-detail page:
 *   • Entity row metadata (displayName, type, aliases).
 *   • Every page that mentions the entity (via `entities.normKey`)
 *     OR — for places — every page that has the same key in its
 *     `places.normKey`. This makes the route uniform across types
 *     even though places live in their own array.
 *   • Top related entities (most-co-occurring on the same pages).
 *   • Geocoded coordinates if the key matches a known place,
 *     surfaced so the web page can render the map inset.
 */
entitiesRouter.get('/:key', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const key = normalizeTagKey(decodeURIComponent(req.params.key ?? ''));
  if (!key) {
    res.status(400).json({ error: 'invalid_request', message: 'Invalid entity key' });
    return;
  }

  // Try the Entity row first; fall back to deriving metadata from
  // the page-level entries when the row hasn't been upserted (a
  // page extraction may have stored `entities[]` on the page before
  // the Entity collection write succeeded — best-effort upserts can
  // race the page save).
  const entity = await Entity.findOne({
    userId,
    $or: [{ key }, { aliases: key }],
  }).lean();
  const canonicalKey = entity?.key ?? key;

  // Pull every page that references this entity (or the place form
  // if it's a place). Limited to 200 — the route is for browsing,
  // not for serving an unbounded analytics view.
  const pages = await Page.find({
    userId,
    $or: [
      { 'entities.normKey': canonicalKey },
      { 'places.normKey': canonicalKey },
    ],
  })
    .sort({ updatedAt: -1 })
    .limit(200)
    .select('-contentMd -embedding -topicCentroid')
    .lean();

  // Derived metadata when the Entity row is absent. Pull the first
  // page-level entry that matches as the canonical surface form.
  let inferredType: 'person' | 'work' | 'organization' | 'place' | null = entity?.type ?? null;
  let inferredDisplayName = entity?.displayName ?? '';
  let placeCoords: { lat: number; lon: number; displayName: string | null } | null = null;
  for (const p of pages) {
    if (!inferredDisplayName || !inferredType) {
      const ent = ((p.entities as Array<{ normKey: string; displayName: string; name: string; type: string }> | undefined) ?? []).find((e) => e.normKey === canonicalKey);
      if (ent) {
        inferredType = (ent.type as typeof inferredType) ?? inferredType;
        inferredDisplayName = inferredDisplayName || ent.displayName || ent.name;
      }
    }
    // Surface place coordinates from whichever page has them. We
    // take the first geocoded entry — coordinates rarely diverge
    // across pages for the same kebab key.
    if (!placeCoords) {
      const place = ((p.places as Array<{
        normKey: string;
        lat: number | null;
        lon: number | null;
        displayName: string | null;
        name: string;
      }> | undefined) ?? []).find((pl) => pl.normKey === canonicalKey);
      if (place && place.lat != null && place.lon != null) {
        placeCoords = {
          lat: place.lat,
          lon: place.lon,
          displayName: place.displayName,
        };
        if (!inferredType) inferredType = 'place';
        if (!inferredDisplayName) inferredDisplayName = place.name;
      }
    }
  }

  // Co-occurrence: count entities that appear on the same page set
  // as this one. Cheap because we already have the pages.
  const related = new Map<string, { displayName: string; type: string; count: number }>();
  for (const p of pages) {
    const ents = (p.entities as Array<{ normKey: string; displayName: string; name: string; type: string }> | undefined) ?? [];
    for (const e of ents) {
      if (e.normKey === canonicalKey) continue;
      const prev = related.get(e.normKey);
      if (prev) {
        prev.count += 1;
      } else {
        related.set(e.normKey, {
          displayName: e.displayName || e.name,
          type: e.type,
          count: 1,
        });
      }
    }
  }
  const relatedList = [...related.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 12)
    .map(([key, v]) => ({
      key,
      displayName: v.displayName,
      type: v.type,
      count: v.count,
    }));

  // Organizations are global — merge the shared facts (canonical
  // displayName, aliases, summary, websites, logo) from the
  // Organization row so every user sees the same brand identity for
  // an org-typed entity. The user's own Entity still owns their
  // pageCount / lastSeenAt / per-user overrides.
  let orgFacts: {
    displayName?: string;
    aliases?: string[];
    websites?: string[];
    logoUrl?: string | null;
    summary?: string;
  } = {};
  if (inferredType === 'organization') {
    const org = await Organization.findOne({ key: canonicalKey })
      .select('displayName aliases websites logoUrl summary forgottenBriefBy')
      .lean();
    if (org) {
      const muted = (
        (org.forgottenBriefBy as Types.ObjectId[] | undefined) ?? []
      ).some((u) => String(u) === String(userId));
      orgFacts = {
        displayName: (org.displayName as string | undefined) || undefined,
        aliases: (org.aliases as string[] | undefined) ?? [],
        websites: (org.websites as string[] | undefined) ?? [],
        logoUrl: (org.logoUrl as string | null | undefined) ?? null,
        summary: muted ? '' : ((org.summary as string | undefined) ?? ''),
      };
    }
  }

  // Aliases: union of per-user (Entity) and global (Organization).
  const aliasSet = new Set<string>([
    ...(((entity?.aliases as string[] | undefined) ?? [])),
    ...(orgFacts.aliases ?? []),
  ]);

  res.json({
    key: canonicalKey,
    // Per-user displayName wins when the user has explicitly set
    // one; otherwise fall back to the global org name.
    displayName:
      inferredDisplayName || orgFacts.displayName || canonicalKey,
    type: inferredType,
    aliases: [...aliasSet],
    pageCount: pages.length,
    placeCoords,
    pages,
    related: relatedList,
    org: inferredType === 'organization'
      ? {
          displayName: orgFacts.displayName ?? null,
          websites: orgFacts.websites ?? [],
          logoUrl: orgFacts.logoUrl ?? null,
          summary: orgFacts.summary ?? '',
        }
      : null,
  });
});

/**
 * Update displayName / aliases / type on an entity row. Aliases the
 * caller pastes are normalized through the same kebab helper as
 * canonical keys; collisions with another entity's key are
 * rejected (use Merge).
 */
entitiesRouter.patch('/:key', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const key = normalizeTagKey(decodeURIComponent(req.params.key ?? ''));
  if (!key) {
    res.status(400).json({ error: 'invalid_request', message: 'Invalid entity key' });
    return;
  }
  const body = (req.body ?? {}) as {
    displayName?: string;
    aliases?: string[];
    type?: string;
  };
  const update: Record<string, unknown> = {};
  if (typeof body.displayName === 'string') {
    update.displayName = body.displayName.trim().slice(0, 200);
  }
  if (
    typeof body.type === 'string' &&
    (ENTITY_TYPES as readonly string[]).includes(body.type)
  ) {
    update.type = body.type;
  }
  if (Array.isArray(body.aliases)) {
    const normalized = [
      ...new Set(
        body.aliases
          .map((a) => normalizeTagKey(String(a)))
          .filter((a) => a && a !== key),
      ),
    ];
    if (normalized.length) {
      const collision = await Entity.findOne({
        userId,
        key: { $ne: key, $in: normalized },
      })
        .select('key')
        .lean();
      if (collision) {
        res.status(409).json({
          error: 'alias_collides_with_entity',
          message: `"${collision.key}" already exists as its own entity — use Merge instead of Alias.`,
        });
        return;
      }
    }
    update.aliases = normalized;
  }
  const result = await Entity.findOneAndUpdate(
    { userId, key },
    { $set: update },
    { new: true },
  );
  if (!result) {
    res.status(404).json({ error: 'not_found', message: 'Entity not found' });
    return;
  }
  // Mirror displayName changes onto every Page.entities entry that
  // points to this key so the UI doesn't show stale labels until the
  // next page regeneration.
  if (typeof update.displayName === 'string') {
    await Page.updateMany(
      { userId, 'entities.normKey': key },
      {
        $set: {
          'entities.$[matched].displayName': update.displayName,
          'entities.$[matched].name': update.displayName,
        },
      },
      { arrayFilters: [{ 'matched.normKey': key }] },
    );
  }
  if (typeof update.type === 'string') {
    await Page.updateMany(
      { userId, 'entities.normKey': key },
      { $set: { 'entities.$[matched].type': update.type } },
      { arrayFilters: [{ 'matched.normKey': key }] },
    );
  }
  // Org-typed entity edits flow into the global Organization row.
  // Aliases use $addToSet so one user's discovery surfaces for
  // everyone; displayName is intentionally NOT mirrored on PATCH —
  // the per-user displayName lives on Entity, and the canonical
  // global name is set once on first insert.
  if (result.type === 'organization') {
    try {
      const orgUpdate: Record<string, unknown> = {
        $setOnInsert: { key, displayName: result.displayName, firstSeenBy: userId },
      };
      const newAliases = Array.isArray(update.aliases)
        ? (update.aliases as string[])
        : [];
      if (newAliases.length) {
        orgUpdate.$addToSet = { aliases: { $each: newAliases } };
      }
      await Organization.updateOne({ key }, orgUpdate, { upsert: true });
    } catch {
      // Best-effort.
    }
  }
  res.json({
    key: result.key,
    displayName: result.displayName,
    type: result.type,
    aliases: (result.aliases as string[] | undefined) ?? [],
  });
});

/**
 * Merge `:key` into another entity. Page.entities[] entries pointing
 * at the source get their normKey rewritten to the target (and
 * displayName/type to match the target). Source row absorbed into
 * target as alias + deleted.
 */
entitiesRouter.post('/:key/merge', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const source = normalizeTagKey(decodeURIComponent(req.params.key ?? ''));
  const body = (req.body ?? {}) as { into?: string };
  const target = normalizeTagKey(body.into ?? '');
  if (!source || !target) {
    res.status(400).json({ error: 'invalid_request', message: 'Both source and `into` are required' });
    return;
  }
  if (source === target) {
    res.status(400).json({ error: 'invalid_request', message: 'Cannot merge an entity into itself' });
    return;
  }
  const [sourceRow, targetRow] = await Promise.all([
    Entity.findOne({ userId, key: source }),
    Entity.findOne({ userId, key: target }),
  ]);
  if (!targetRow) {
    res.status(404).json({
      error: 'not_found',
      message: 'Target entity not found. Create or rename it first.',
    });
    return;
  }
  await Entity.updateOne(
    { userId, key: target },
    {
      $addToSet: {
        aliases: { $each: [source, ...((sourceRow?.aliases as string[] | undefined) ?? [])] },
      },
    },
  );
  // Repoint pages. Snapshot first so the second update knows which
  // pages had the source — same defensive pattern as Tag merge.
  const affected = await Page.find({ userId, 'entities.normKey': source })
    .select('_id')
    .lean();
  const ids = affected.map((p) => p._id as Types.ObjectId);
  if (ids.length > 0) {
    // Two-step: update entries that already had source → rewrite to
    // target. Then deduplicate any pages that ended up with both via
    // a $pull-then-$addToSet pass.
    await Page.updateMany(
      { _id: { $in: ids }, userId },
      {
        $set: {
          'entities.$[matched].normKey': target,
          'entities.$[matched].name': targetRow.displayName,
          'entities.$[matched].displayName': targetRow.displayName,
          'entities.$[matched].type': targetRow.type,
        },
      },
      { arrayFilters: [{ 'matched.normKey': source }] },
    );
    // De-duplicate: if a page previously had both source and target,
    // the rewrite above leaves two entries for target. Pull them
    // both then re-add a single canonical row.
    await Page.updateMany(
      { _id: { $in: ids }, userId },
      { $pull: { entities: { normKey: target } } },
    );
    await Page.updateMany(
      { _id: { $in: ids }, userId },
      {
        $addToSet: {
          entities: {
            name: targetRow.displayName,
            normKey: target,
            type: targetRow.type,
            displayName: targetRow.displayName,
          },
        },
      },
    );
  }
  if (sourceRow) await Entity.deleteOne({ _id: sourceRow._id });

  // Plan 14 — entities are per-user; daydream notes are global.
  // The pre-plan-14 cleanup deleted the source entity's daydream
  // note here, but doing that now would yank the encyclopedic
  // brief from every other user too. The note is left in place;
  // /n/<source> on this user's UI will simply not resolve to an
  // entity row anymore, so the daydream lookup never fires.

  res.json({ ok: true, target, affectedPages: ids.length });
});

/**
 * Rename an entity's canonical key. The old key becomes an alias on
 * the renamed row; refuses to rename onto an existing key (use
 * Merge for that). Page.entities[] across the corpus rewrites to
 * the new key.
 */
entitiesRouter.post('/:key/rename', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const oldKey = normalizeTagKey(decodeURIComponent(req.params.key ?? ''));
  const body = (req.body ?? {}) as { key?: string; displayName?: string };
  const newKey = normalizeTagKey(body.key ?? '');
  if (!oldKey || !newKey) {
    res.status(400).json({ error: 'invalid_request', message: 'Both old and new keys are required' });
    return;
  }
  if (oldKey === newKey) {
    res.status(400).json({ error: 'invalid_request', message: 'New key equals old; use PATCH instead' });
    return;
  }
  const collision = await Entity.findOne({ userId, key: newKey }).lean();
  if (collision) {
    res.status(409).json({
      error: 'entity_exists',
      message: `"${newKey}" already exists — use Merge instead of Rename.`,
    });
    return;
  }
  const sourceRow = await Entity.findOne({ userId, key: oldKey });
  if (!sourceRow) {
    res.status(404).json({ error: 'not_found', message: 'Entity not found' });
    return;
  }
  const displayName =
    body.displayName?.trim().slice(0, 200) || sourceRow.displayName;
  const aliases = new Set<string>([
    ...((sourceRow.aliases as string[] | undefined) ?? []),
    oldKey,
  ]);
  aliases.delete(newKey);
  await Entity.create({
    userId,
    key: newKey,
    displayName,
    type: sourceRow.type,
    aliases: [...aliases],
    pageCount: sourceRow.pageCount ?? 0,
    lastSeenAt: new Date(),
  });
  await Entity.deleteOne({ _id: sourceRow._id });

  await Page.updateMany(
    { userId, 'entities.normKey': oldKey },
    {
      $set: {
        'entities.$[matched].normKey': newKey,
        'entities.$[matched].displayName': displayName,
        'entities.$[matched].name': displayName,
      },
    },
    { arrayFilters: [{ 'matched.normKey': oldKey }] },
  );
  const r = await Page.countDocuments({ userId, 'entities.normKey': newKey });
  res.json({ ok: true, key: newKey, displayName, affectedPages: r });
});

/**
 * Delete an entity row. By default leaves the entries in
 * Page.entities[] alone (the URL still routes; the page just won't
 * find a row in /api/entities/:key — auto-linker still works since
 * it reads from page-level data). `?purgeFromPages=true` strips
 * every Page.entities[] entry pointing at this key too.
 */
entitiesRouter.delete('/:key', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const key = normalizeTagKey(decodeURIComponent(req.params.key ?? ''));
  if (!key) {
    res.status(400).json({ error: 'invalid_request', message: 'Invalid entity key' });
    return;
  }
  const purge =
    (req.query.purgeFromPages ?? req.body?.purgeFromPages) === 'true' ||
    req.body?.purgeFromPages === true;
  // Snapshot the row before delete so we can clean up the
  // associated DaydreamNote keyed on its displayName.
  const row = await Entity.findOne({ userId, key }).select('displayName').lean();
  await Entity.deleteOne({ userId, key });
  // Plan 14 — daydream notes are global; the brief stays for other
  // users who may still have an entity row resolving to this key.
  // (Same reasoning as the merge cleanup above.) If the user wants
  // the brief gone from THEIR view, the per-user "Forget" action
  // on the daydream panel adds them to forgottenBy without
  // touching anyone else's data.
  void row?.displayName;
  let affected = 0;
  if (purge) {
    const r = await Page.updateMany(
      { userId, 'entities.normKey': key },
      { $pull: { entities: { normKey: key } } },
    );
    affected = r.modifiedCount ?? 0;
  }
  res.json({ ok: true, purged: purge, affectedPages: affected });
});

/**
 * Daydream-supplied "what is this" brief for the entity. Returns
 * the cached note (status === 'idle' / 'researching' indicates
 * whether a fresh pass is in flight). Returns `note: null` when
 * nothing has been researched yet.
 *
 * The daydream subjectKey is the lowercased + whitespace-collapsed
 * displayName, NOT the kebab URL slug — daydream stores its keys
 * in human form so notes can be re-used across surfaces.
 */
entitiesRouter.get('/:key/daydream', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const key = normalizeTagKey(decodeURIComponent(req.params.key ?? ''));
  const entity = await Entity.findOne({ userId, $or: [{ key }, { aliases: key }] })
    .select('key displayName')
    .lean();
  if (!entity) {
    res.json({ note: null });
    return;
  }
  // Plan 14 — notes are global; filter out user-forgotten ones.
  const subjectKey = daydreamSubjectKey(entity.displayName);
  const note = await DaydreamNote.findOne({
    kind: 'entity',
    subjectKey,
    forgottenBy: { $ne: userId },
  }).lean();
  // Plan 15 — resolve firstResearchedBy → displayName for the
  // attribution chip on the entity page Background card.
  let contributedBy = '';
  if (note?.firstResearchedBy) {
    const u = await User.findById(note.firstResearchedBy)
      .select('displayName')
      .lean();
    contributedBy = u?.displayName ?? '';
  }
  res.json({
    note: note
      ? {
          _id: String(note._id),
          summary: note.summary ?? '',
          bodyMd: note.bodyMd ?? '',
          sources: ((note.sources as Array<{ adapter: string; url: string; title: string; fetchedAt: Date | null }> | undefined) ?? []).map((s) => ({
            adapter: s.adapter,
            url: s.url,
            title: s.title,
            fetchedAt: s.fetchedAt ? new Date(s.fetchedAt as Date).toISOString() : null,
          })),
          confidence: note.confidence ?? 'medium',
          model: note.model ?? null,
          generatedAt: note.generatedAt
            ? new Date(note.generatedAt as Date).toISOString()
            : null,
          failed: note.failed ?? false,
          failureReason: note.failureReason ?? null,
          contributedBy,
        }
      : null,
  });
});

/**
 * Force a daydream pass for this entity directly (no page-context
 * round-trip). Mirrors the per-tag direct mode the daydream worker
 * already supports — adds a `kind: 'entity'` job that researches
 * one subject. Cheap rate limit: 5 forces per user per minute,
 * shared with the page-level Daydream Now button.
 */
entitiesRouter.post('/:key/daydream', llmForceLimiter, async (req, res) => {
  const userIdStr = userIdOf(req);
  const userId = new Types.ObjectId(userIdStr);
  const key = normalizeTagKey(decodeURIComponent(req.params.key ?? ''));
  if (!key) {
    res.status(400).json({ error: 'invalid_request', message: 'Invalid entity key' });
    return;
  }

  const entity = await Entity.findOne({ userId, $or: [{ key }, { aliases: key }] })
    .select('key displayName')
    .lean();
  if (!entity) {
    res.status(404).json({ error: 'not_found', message: 'Entity not found' });
    return;
  }
  const job = await daydreamQueue.add(
    'entity',
    {
      kind: 'entity',
      userId: userIdStr,
      key: daydreamSubjectKey(entity.displayName),
      displayName: entity.displayName,
    },
    {
      attempts: 1,
      removeOnComplete: 200,
      removeOnFail: 200,
      priority: 0,
      // BullMQ rejects ':' in custom job IDs — '__' delimits.
      jobId: `dd-entity__${userIdStr}__${entity.key}__${Date.now()}`,
    },
  );
  res.status(202).json({ jobId: job.id });
});

/**
 * Rebuild the entity registry from the user's current pages. Walks
 * every Entity row and:
 *   • Recounts contributing pages from Page.entities[].normKey and
 *     Page.places[].normKey.
 *   • Recomputes type from the live page data — entities[] entries
 *     win over places[] entries so a misclassified place flips back
 *     to person / work / organization once any page actually carries
 *     that type. Sender-derived organizations are pinned to
 *     'organization' since the SenderBrand registry is authoritative.
 *   • Drops any row that has zero contributing pages AND no
 *     daydream note backing it. Cleans up ghosts left behind after
 *     the user deletes the contributing articles.
 *
 * Returns a summary so the UI can confirm "kept N, retyped M, deleted K".
 */
entitiesRouter.post('/rescan', async (req, res, next) => {
  try {
    const userId = new Types.ObjectId(userIdOf(req));

    // Pull the live page graph once so we can compute counts /
    // candidate types without N round-trips.
    const pages = await Page.find({ userId })
      .select('entities places')
      .lean();

    type Cand = { count: number; typeVotes: Map<string, number> };
    const byKey = new Map<string, Cand>();
    function bump(key: string, type: string | null) {
      const c = byKey.get(key) ?? { count: 0, typeVotes: new Map() };
      c.count += 1;
      if (type) c.typeVotes.set(type, (c.typeVotes.get(type) ?? 0) + 1);
      byKey.set(key, c);
    }
    for (const p of pages) {
      for (const e of (p.entities ?? []) as { normKey: string; type: string }[]) {
        if (e.normKey) bump(e.normKey, e.type);
      }
      for (const pl of (p.places ?? []) as { normKey: string }[]) {
        if (pl.normKey) bump(pl.normKey, 'place');
      }
    }

    // Sender-derived organisations should never be downgraded to
    // place / person even if no current page uses them yet — the
    // sender row is its own evidence. Read the sender brand keys
    // for this user and pin the type for matching entities.
    const senderKeys = new Set(
      (
        await Sender.find({ userId }).select('brandKey').lean()
      ).map((s) => s.brandKey as string),
    );

    const all = await Entity.find({ userId }).lean();
    let kept = 0;
    let retyped = 0;
    let deleted = 0;

    for (const ent of all) {
      const key = ent.key as string;
      const cand = byKey.get(key);
      const isSender = senderKeys.has(key);

      if (!cand && !isSender) {
        // Nothing in pages references this entity. Check daydream
        // notes — they can keep an entity row alive even when the
        // contributing pages were deleted.
        const subjectKey = daydreamSubjectKey(ent.displayName ?? '');
        const hasDaydream = await DaydreamNote.exists({
          subjectKey,
          forgottenBy: { $ne: userId },
        });
        if (!hasDaydream) {
          await Entity.deleteOne({ _id: ent._id });
          deleted += 1;
          continue;
        }
      }

      // Decide the canonical type. Sender-derived organisations stay
      // organisations. Otherwise use the most-voted non-place type;
      // fall back to the most-voted type overall.
      let nextType: string | null = null;
      if (isSender) {
        nextType = 'organization';
      } else if (cand) {
        const sorted = [...cand.typeVotes.entries()].sort(
          (a, b) => b[1] - a[1],
        );
        const nonPlace = sorted.find(([t]) => t !== 'place');
        nextType = (nonPlace ?? sorted[0])?.[0] ?? null;
      }

      const update: Record<string, unknown> = {
        pageCount: cand?.count ?? 0,
      };
      if (nextType && nextType !== ent.type) {
        update.type = nextType;
        retyped += 1;
      }
      await Entity.updateOne({ _id: ent._id }, { $set: update });
      kept += 1;
    }

    res.json({ ok: true, kept, retyped, deleted, scanned: all.length });
  } catch (err) {
    next(err);
  }
});
