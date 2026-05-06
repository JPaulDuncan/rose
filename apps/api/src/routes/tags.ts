import { Router } from 'express';
import { Types } from 'mongoose';
import { Page, TagDigest, TagCanonical, normalizeTagKey, titleCaseTag } from '@rose/db';
import { userIdOf } from '../middleware/auth.js';
import { tagDigestQueue } from '../lib/queues.js';

export const tagsRouter: Router = Router();

// ── Canonical-tag management (Settings → Tags) ─────────────────────────
//
// Routes registered first so /api/tags/canonicals etc. take
// precedence over the catch-all /api/tags/:tag aggregation handler
// further down. Stored canonicals are kebab keys (Page.tags storage
// form); displayName is what the UI renders on pills.

/**
 * Aggregate per-canonical page counts straight off Page.tags so the
 * settings UI shows accurate "in use on N pages" numbers without
 * relying on the lazily-maintained `TagCanonical.pageCount` field.
 *
 * Also pulls a small histogram of "tags that exist on pages but
 * have no canonical row yet" — those are emergent tags we never
 * canonicalised (legacy data, or the canonicalisation step
 * fell back to passthrough). Surfaced separately so the user can
 * promote them to canonicals if they want.
 */
async function aggregateTagCounts(userId: Types.ObjectId): Promise<Map<string, number>> {
  const rows = await Page.aggregate<{ _id: string; pageCount: number }>([
    { $match: { userId } },
    { $project: { tags: 1 } },
    { $unwind: '$tags' },
    { $group: { _id: '$tags', pageCount: { $sum: 1 } } },
  ]);
  const out = new Map<string, number>();
  for (const r of rows) out.set(r._id, r.pageCount);
  return out;
}

tagsRouter.get('/canonicals', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const [canonicals, counts] = await Promise.all([
    TagCanonical.find({ userId })
      .select('canonical displayName aliases pageCount updatedAt createdAt')
      .lean(),
    aggregateTagCounts(userId),
  ]);

  // Compose: every canonical row + a synthesized "uncanonical"
  // entry per emergent tag the user has on pages but no canonical
  // for. Both shapes match so the UI can render them in one list.
  const known = new Set(canonicals.map((c) => c.canonical));
  const emergent: typeof canonicals = [];
  for (const [tag, n] of counts) {
    if (!known.has(tag) && n > 0) {
      emergent.push({
        _id: undefined as unknown as Types.ObjectId,
        canonical: tag,
        displayName: '',
        aliases: [],
        pageCount: n,
      } as never);
    }
  }
  const all = [
    ...canonicals.map((c) => ({
      canonical: c.canonical,
      displayName: c.displayName || titleCaseTag(c.canonical),
      aliases: (c.aliases ?? []) as string[],
      pageCount: counts.get(c.canonical) ?? 0,
      isCanonicalRow: true,
      updatedAt: c.updatedAt ? new Date(c.updatedAt as Date).toISOString() : null,
    })),
    ...emergent.map((c) => ({
      canonical: c.canonical,
      displayName: titleCaseTag(c.canonical),
      aliases: [] as string[],
      pageCount: c.pageCount ?? 0,
      isCanonicalRow: false,
      updatedAt: null as string | null,
    })),
  ].sort((a, b) => b.pageCount - a.pageCount || a.canonical.localeCompare(b.canonical));
  res.json({ canonicals: all });
});

/**
 * Update displayName and / or aliases on a canonical. Aliases the
 * user pastes are normalized through `normalizeTagKey` so "Job
 * Postings" or "Job_Postings" all collapse to "job-postings". An
 * alias collision with a different canonical is rejected — the
 * caller should merge instead.
 */
tagsRouter.patch('/canonicals/:canonical', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const canonical = normalizeTagKey(decodeURIComponent(req.params.canonical ?? ''));
  if (!canonical) {
    res.status(400).json({ error: 'invalid_request', message: 'Invalid canonical' });
    return;
  }
  const body = (req.body ?? {}) as {
    displayName?: string;
    aliases?: string[];
  };

  const update: Record<string, unknown> = {};
  if (typeof body.displayName === 'string') {
    update.displayName = body.displayName.trim().slice(0, 80);
  }
  let normalisedAliases: string[] | null = null;
  if (Array.isArray(body.aliases)) {
    normalisedAliases = [
      ...new Set(
        body.aliases
          .map((a) => normalizeTagKey(String(a)))
          .filter((a) => a && a !== canonical),
      ),
    ];
    // Reject collisions with other canonicals — those should go
    // through the merge endpoint so Page.tags rewrites correctly.
    if (normalisedAliases.length) {
      const collision = await TagCanonical.findOne({
        userId,
        canonical: { $ne: canonical, $in: normalisedAliases },
      })
        .select('canonical')
        .lean();
      if (collision) {
        res.status(409).json({
          error: 'alias_collides_with_canonical',
          message: `"${collision.canonical}" is already its own canonical — use Merge instead of Alias.`,
        });
        return;
      }
    }
    update.aliases = normalisedAliases;
  }

  const result = await TagCanonical.findOneAndUpdate(
    { userId, canonical },
    {
      $set: update,
      $setOnInsert: {
        userId,
        canonical,
        displayName: update.displayName ?? titleCaseTag(canonical),
      },
    },
    { upsert: true, new: true },
  );
  res.json({
    canonical: result.canonical,
    displayName: result.displayName || titleCaseTag(result.canonical),
    aliases: (result.aliases as string[] | undefined) ?? [],
  });
});

/**
 * Merge `:canonical` into the target canonical:
 *   • Target absorbs the source's aliases AND the source canonical
 *     itself as an alias (so a page tagged with the old form keeps
 *     resolving once the row goes away).
 *   • Every Page.tags array gets the source replaced with the
 *     target — uses two updates rather than $set with arrayFilters
 *     because Mongo's array-element ops don't combine $pull and
 *     $addToSet on the same field cleanly.
 *   • The source canonical row is deleted.
 *
 * If the target doesn't exist yet, it's created from
 * `intoDisplayName` (or a title-cased fallback). Refusing to merge
 * a tag onto itself; refusing self-targeting via aliases.
 */
tagsRouter.post('/canonicals/:canonical/merge', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const source = normalizeTagKey(decodeURIComponent(req.params.canonical ?? ''));
  const body = (req.body ?? {}) as { into?: string; intoDisplayName?: string };
  const target = normalizeTagKey(body.into ?? '');
  if (!source || !target) {
    res
      .status(400)
      .json({ error: 'invalid_request', message: 'Both source and `into` are required' });
    return;
  }
  if (source === target) {
    res.status(400).json({ error: 'invalid_request', message: 'Cannot merge a tag into itself' });
    return;
  }

  const sourceRow = await TagCanonical.findOne({ userId, canonical: source });

  // Ensure target exists. If it's a brand-new canonical we create
  // it; if it already exists we just absorb the source into it.
  await TagCanonical.updateOne(
    { userId, canonical: target },
    {
      $setOnInsert: {
        userId,
        canonical: target,
        displayName:
          body.intoDisplayName?.trim().slice(0, 80) || titleCaseTag(target),
      },
      $addToSet: {
        aliases: { $each: [source, ...((sourceRow?.aliases as string[] | undefined) ?? [])] },
      },
    },
    { upsert: true },
  );

  // Repoint every page tagged with the source. We snapshot the
  // affected ids first because Mongo's array-element ops can't
  // combine $pull and $addToSet on the same field in one update —
  // and "addToSet on every page that doesn't have target" would be
  // catastrophically wrong (it'd dump the target onto every other
  // page in the corpus).
  const affected = await Page.find({ userId, tags: source }).select('_id').lean();
  const ids = affected.map((p) => p._id as Types.ObjectId);
  if (ids.length > 0) {
    await Page.updateMany(
      { _id: { $in: ids }, userId },
      { $pull: { tags: source } },
    );
    await Page.updateMany(
      { _id: { $in: ids }, userId, tags: { $ne: target } },
      { $addToSet: { tags: target } },
    );
  }

  await TagCanonical.deleteOne({ userId, canonical: source });
  // Plan 14 — daydream notes are global; deleting here would
  // pull the brief from every other user's tag page too. Tag
  // canonicals are also per-user (TagCanonical is a per-user
  // collection), so other users' merges don't propagate here
  // anyway. The orphaned note simply becomes unrouted for this
  // user without affecting anyone else.

  res.json({
    ok: true,
    target,
    affectedPages: ids.length,
  });
});

/**
 * Rename `:canonical` to a new kebab key. Updates Page.tags across
 * the corpus and stashes the old key as an alias on the renamed
 * row so historical references still resolve. Refuses to rename
 * onto an existing canonical (which would silently merge — caller
 * should use the merge endpoint for that case).
 */
tagsRouter.post('/canonicals/:canonical/rename', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const oldCanonical = normalizeTagKey(decodeURIComponent(req.params.canonical ?? ''));
  const body = (req.body ?? {}) as { canonical?: string; displayName?: string };
  const newCanonical = normalizeTagKey(body.canonical ?? '');
  if (!oldCanonical || !newCanonical) {
    res.status(400).json({
      error: 'invalid_request',
      message: 'Both old and new canonical keys are required',
    });
    return;
  }
  if (oldCanonical === newCanonical) {
    // Pure displayName change goes through PATCH; nothing to do here.
    res.status(400).json({
      error: 'invalid_request',
      message: 'New canonical equals old; use PATCH to update displayName.',
    });
    return;
  }
  const collision = await TagCanonical.findOne({ userId, canonical: newCanonical }).lean();
  if (collision) {
    res.status(409).json({
      error: 'canonical_exists',
      message: `"${newCanonical}" is already a canonical — use Merge instead of Rename.`,
    });
    return;
  }

  const sourceRow = await TagCanonical.findOne({ userId, canonical: oldCanonical });
  const displayName =
    body.displayName?.trim().slice(0, 80) ||
    sourceRow?.displayName ||
    titleCaseTag(newCanonical);

  const aliases = new Set<string>([
    ...((sourceRow?.aliases as string[] | undefined) ?? []),
    oldCanonical,
  ]);
  aliases.delete(newCanonical);

  // Create the new row, then delete the old. Doing this in two
  // operations keeps history tidy if the rename is racy.
  await TagCanonical.create({
    userId,
    canonical: newCanonical,
    displayName,
    aliases: [...aliases],
  });
  if (sourceRow) await TagCanonical.deleteOne({ _id: sourceRow._id });

  // Rewrite Page.tags. Same pattern as merge.
  const affected = await Page.find({ userId, tags: oldCanonical })
    .select('_id')
    .lean();
  const ids = affected.map((p) => p._id as Types.ObjectId);
  if (ids.length > 0) {
    await Page.updateMany(
      { _id: { $in: ids }, userId },
      { $pull: { tags: oldCanonical } },
    );
    await Page.updateMany(
      { _id: { $in: ids }, userId, tags: { $ne: newCanonical } },
      { $addToSet: { tags: newCanonical } },
    );
  }

  res.json({ ok: true, canonical: newCanonical, displayName, affectedPages: ids.length });
});

/**
 * Delete a canonical row. By default leaves the tag in place on
 * any pages that carry it (the kebab key still functions in
 * URLs / queries; the UI just falls back to title-cased rendering).
 * Pass `purgeFromPages: true` to also strip the tag from every
 * page that has it.
 */
tagsRouter.delete('/canonicals/:canonical', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const canonical = normalizeTagKey(decodeURIComponent(req.params.canonical ?? ''));
  if (!canonical) {
    res.status(400).json({ error: 'invalid_request', message: 'Invalid canonical' });
    return;
  }
  const purge = (req.query.purgeFromPages ?? req.body?.purgeFromPages) === 'true' ||
    req.body?.purgeFromPages === true;
  await TagCanonical.deleteOne({ userId, canonical });
  // Plan 14 — daydream notes are global; see merge handler above.
  let affected = 0;
  if (purge) {
    const r = await Page.updateMany(
      { userId, tags: canonical },
      { $pull: { tags: canonical } },
    );
    affected = r.modifiedCount ?? 0;
  }
  res.json({ ok: true, purged: purge, affectedPages: affected });
});

function utcDayKey(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Pick the most recent non-failed digest for the tag — usually
 * today's, but if today's hasn't been generated yet we fall back to
 * yesterday's so the home edition always has a lede when there's
 * been any prior activity. Failed digests are intentionally
 * skipped so a transient blip doesn't dominate the section header.
 */
async function latestDigest(userId: Types.ObjectId, tag: string) {
  return TagDigest.findOne({ userId, tag, failed: false })
    .sort({ generatedAt: -1 })
    .lean();
}

function shapeDigest(d: NonNullable<Awaited<ReturnType<typeof latestDigest>>> | null) {
  if (!d) return null;
  return {
    headline: d.headline ?? '',
    dek: d.dek ?? '',
    bodyMd: d.bodyMd ?? '',
    topPageIds: (d.topPageIds ?? []).map(String),
    pageCount: d.pageCount ?? 0,
    model: d.model ?? null,
    dayKey: d.dayKey,
    generatedAt: d.generatedAt ? new Date(d.generatedAt).toISOString() : null,
  };
}

/**
 * Lightweight directory of every tag / topic the user has, sorted by usage.
 * Useful for autocomplete and a future "browse all tags" page.
 */
tagsRouter.get('/', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  // Single aggregation across both fields so the directory is unified.
  const rows = await Page.aggregate<{ _id: string; pageCount: number }>([
    { $match: { userId } },
    {
      $project: {
        all: { $setUnion: [{ $ifNull: ['$tags', []] }, { $ifNull: ['$topics', []] }] },
      },
    },
    { $unwind: '$all' },
    { $group: { _id: '$all', pageCount: { $sum: 1 } } },
    { $sort: { pageCount: -1, _id: 1 } },
    { $limit: 500 },
  ]);
  res.json({
    tags: rows.map((r) => ({ tag: r._id, pageCount: r.pageCount })),
  });
});

/**
 * Tag-aggregation page: every wiki page (and the email count behind it)
 * that includes the given tag in either its `tags` or `topics` array,
 * plus stats and the most common co-occurring tags.
 */
tagsRouter.get('/:tag', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const tag = decodeURIComponent(req.params.tag ?? '').trim().toLowerCase();
  if (!tag) {
    res.status(400).json({ error: 'invalid_request', message: 'Empty tag' });
    return;
  }

  const filter = {
    userId,
    $or: [{ tags: tag }, { topics: tag }],
  };

  const pages = await Page.find(filter)
    .sort({ updatedAt: -1 })
    .select('-contentMd -embedding -topicCentroid')
    .lean();

  if (pages.length === 0) {
    res.json({
      tag,
      pageCount: 0,
      totalEmails: 0,
      dateRange: null,
      topSenders: [],
      relatedTags: [],
      pages: [],
    });
    return;
  }

  // Stats
  let totalEmails = 0;
  let earliest: Date | null = null;
  let latest: Date | null = null;
  const senderCounts = new Map<string, number>();
  const tagCounts = new Map<string, number>();
  const topicCounts = new Map<string, number>();
  for (const p of pages) {
    totalEmails += (p.sourceEmailIds ?? []).length;
    const upd = new Date(p.updatedAt as Date);
    if (!earliest || upd < earliest) earliest = upd;
    if (!latest || upd > latest) latest = upd;
    for (const s of (p.senderAddresses ?? []) as string[]) {
      senderCounts.set(s, (senderCounts.get(s) ?? 0) + 1);
    }
    for (const t of (p.tags ?? []) as string[]) {
      if (t !== tag) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
    }
    for (const t of (p.topics ?? []) as string[]) {
      if (t !== tag) topicCounts.set(t, (topicCounts.get(t) ?? 0) + 1);
    }
  }
  const related = new Map<string, number>();
  for (const [t, n] of tagCounts) related.set(t, (related.get(t) ?? 0) + n);
  for (const [t, n] of topicCounts) related.set(t, (related.get(t) ?? 0) + n);

  const digest = shapeDigest(await latestDigest(userId, tag));
  res.json({
    tag,
    pageCount: pages.length,
    totalEmails,
    dateRange:
      earliest && latest ? { from: earliest.toISOString(), to: latest.toISOString() } : null,
    topSenders: [...senderCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([address, pageCount]) => ({ address, pageCount })),
    relatedTags: [...related.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([t, count]) => ({ tag: t, count })),
    digest,
    pages,
  });
});

/**
 * Latest digest for a tag — same shape served alongside /api/tags/:tag,
 * but pre-resolved so a UI that just wants the lede can pull it
 * without the page list.
 */
tagsRouter.get('/:tag/digest', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const tag = decodeURIComponent(req.params.tag ?? '').trim().toLowerCase();
  if (!tag) {
    res.status(400).json({ error: 'invalid_request', message: 'Empty tag' });
    return;
  }
  const digest = shapeDigest(await latestDigest(userId, tag));
  res.json({ digest });
});

/** Force-regenerate today's digest. Capped via job-id collapsing —
 *  same (user, tag, day) triple wins. */
tagsRouter.post('/:tag/digest/regenerate', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const tag = decodeURIComponent(req.params.tag ?? '').trim().toLowerCase();
  if (!tag) {
    res.status(400).json({ error: 'invalid_request', message: 'Empty tag' });
    return;
  }
  const job = await tagDigestQueue.add(
    'digest',
    { userId: String(userId), tag },
    {
      // BullMQ rejects ':' in custom job IDs (it reserves it for
      // internal namespacing). Use '__' so the (user, tag, day)
      // triple still collapses re-pins to one job.
      jobId: `digest__${String(userId)}__${tag}__${utcDayKey()}`,
      attempts: 1,
      removeOnComplete: 200,
      removeOnFail: 200,
    },
  );
  res.status(202).json({ jobId: job.id });
});
