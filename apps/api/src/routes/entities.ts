import { Router } from 'express';
import { Types } from 'mongoose';
import { Entity, Page, normalizeTagKey } from '@rose/db';
import { userIdOf } from '../middleware/auth.js';

export const entitiesRouter: Router = Router();

/**
 * Lightweight directory of every entity the user has, sorted by
 * page count. Used by a future Settings → Entities surface and by
 * the auto-linker as a warm cache. Cap at 500 — the directory is
 * not paginated yet, and the auto-linker per-page is bounded by
 * Page.entities[] anyway.
 */
entitiesRouter.get('/', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const type = req.query.type as string | undefined;
  const filter: Record<string, unknown> = { userId };
  if (type === 'person' || type === 'work' || type === 'organization') {
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

  res.json({
    key: canonicalKey,
    displayName: inferredDisplayName || canonicalKey,
    type: inferredType,
    aliases: ((entity?.aliases as string[] | undefined) ?? []),
    pageCount: pages.length,
    placeCoords,
    pages,
    related: relatedList,
  });
});
