import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { User, Page } from '@rose/db';
import { userIdOf } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { redis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';

export const mapsRouter: Router = Router();

const MapsSettings = z.object({
  enabled: z.boolean().default(false),
  /** Set to non-null after the user accepts the egress note. */
  acknowledgedAt: z.string().nullable().default(null),
});
export type MapsSettings = z.infer<typeof MapsSettings>;

const MapsSettingsUpdate = z.object({
  enabled: z.boolean().optional(),
  /** Pass `true` to record the user has seen the egress note (sets
   *  lastAcknowledgedAt server-side). */
  acknowledge: z.boolean().optional(),
});

/**
 * Read the user's maps preferences. Returns the current `enabled`
 * flag plus an `acknowledgedAt` timestamp the UI uses to decide
 * whether to show the first-time egress note.
 */
mapsRouter.get('/settings', async (req, res) => {
  const userId = userIdOf(req);
  const user = await User.findById(userId).select('settings.maps').lean();
  const cfg =
    (user?.settings as { maps?: { enabled?: boolean; lastAcknowledgedAt?: Date } } | undefined)
      ?.maps ?? {};
  const safe: MapsSettings = {
    enabled: !!cfg.enabled,
    acknowledgedAt: cfg.lastAcknowledgedAt
      ? new Date(cfg.lastAcknowledgedAt).toISOString()
      : null,
  };
  res.json(safe);
});

mapsRouter.patch('/settings', validateBody(MapsSettingsUpdate), async (req, res) => {
  const userId = userIdOf(req);
  const body = req.body as typeof MapsSettingsUpdate._type;
  const update: Record<string, unknown> = {};
  if (body.enabled !== undefined) update['settings.maps.enabled'] = body.enabled;
  if (body.acknowledge) update['settings.maps.lastAcknowledgedAt'] = new Date();
  if (Object.keys(update).length === 0) {
    res.json({ ok: true });
    return;
  }
  await User.findByIdAndUpdate(userId, { $set: update });
  res.json({ ok: true });
});

// ─── Static map snapshot ─────────────────────────────────────────
//
// Places don't move. Rendering Leaflet on every page mount fires a
// dozen tile loads against the user's network for a view that's
// purely decorative. This endpoint serves a single PNG snapshot of
// a `(lat, lon, zoom)` view, cached in Redis after the first fetch
// so subsequent visits — across users, across processes, across
// restarts — pay zero upstream cost.
//
// Browser-side, the response is `Cache-Control: public, immutable,
// max-age=1y` so a returning visitor doesn't even hit the API.
// Together: one upstream fetch per (lat, lon, zoom, w, h, marker)
// for the lifetime of the cache, then a static `<img>` ever after.

const StaticMapQuery = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lon: z.coerce.number().min(-180).max(180),
  /** OSM zoom level. We clamp to a sane range — the snapshot
   *  endpoint is for inset views, not gigapixel exploration. */
  zoom: z.coerce.number().int().min(1).max(18).default(12),
  w: z.coerce.number().int().min(64).max(1024).default(600),
  h: z.coerce.number().int().min(48).max(1024).default(300),
  /** Whether to drop a marker at the centre. Most callers want
   *  one; pass `false` for backdrop-only views. */
  marker: z.enum(['true', 'false']).default('true'),
});

const STATIC_TTL_SEC = 90 * 24 * 60 * 60; // 90 days
const UPSTREAM_TIMEOUT_MS = 10_000;

/** 3 d.p. ≈ 110 m — same grid the weather snapshot uses. Aligns
 *  cache keys for nearby callers so two users at "the same place"
 *  share one cached image. */
function roundCoord(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function cacheKey(q: z.infer<typeof StaticMapQuery>): string {
  const lat = roundCoord(q.lat);
  const lon = roundCoord(q.lon);
  return `maps:static:${lat},${lon}:z${q.zoom}:${q.w}x${q.h}:m${q.marker}`;
}

function upstreamUrl(q: z.infer<typeof StaticMapQuery>): string {
  const lat = roundCoord(q.lat);
  const lon = roundCoord(q.lon);
  // staticmap.openstreetmap.de is community-hosted, no API key
  // required. Long Redis cache means we hit it sparingly — once
  // per unique (lat, lon, zoom, w, h, marker) for ~90 days.
  const params = new URLSearchParams({
    center: `${lat},${lon}`,
    zoom: String(q.zoom),
    size: `${q.w}x${q.h}`,
    maptype: 'mapnik',
  });
  if (q.marker === 'true') {
    // The service supports a comma-separated list of markers.
    // `red-pushpin` matches the rose-coloured Leaflet pin UX.
    params.set('markers', `${lat},${lon},red-pushpin`);
  }
  return `https://staticmap.openstreetmap.de/staticmap.php?${params.toString()}`;
}

mapsRouter.get('/static', async (req, res, next) => {
  try {
    // Egress gate. Maps make outbound HTTP requests for tiles; the
    // rest of Rose is opt-in for that, so the snapshot service
    // honours the same toggle. Returns 403 (not 404) so the SPA
    // can show a "turn this on in Settings → Maps" hint.
    const userId = userIdOf(req);
    const user = await User.findById(userId).select('settings.maps').lean();
    const enabled =
      !!(user?.settings as { maps?: { enabled?: boolean } } | undefined)?.maps
        ?.enabled;
    if (!enabled) {
      res.status(403).json({
        error: 'maps_disabled',
        message: 'Enable maps in Settings → Maps to use the snapshot service.',
      });
      return;
    }

    const parsed = StaticMapQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', issues: parsed.error.issues });
      return;
    }
    const q = parsed.data;
    const key = cacheKey(q);

    // Aggressive browser cache — same URL = same image, forever
    // (the params include everything that affects the render).
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.set('Content-Type', 'image/png');

    // Redis cache: bytes are stored base64-encoded so they survive
    // ioredis's string-only API. Hit-path is a single GET + decode
    // — no upstream traffic, no PNG re-encode.
    const cached = await redis.get(key);
    if (cached) {
      res.set('X-Map-Snapshot', 'hit');
      res.send(Buffer.from(cached, 'base64'));
      return;
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
    let buf: Buffer;
    try {
      const upstream = await fetch(upstreamUrl(q), {
        headers: {
          'User-Agent': 'rose-wiki/0.1 (+https://github.com/anthropics/rose; maps)',
          Accept: 'image/png,image/*;q=0.8',
        },
        signal: ctrl.signal,
      });
      if (!upstream.ok) {
        logger.warn(
          { status: upstream.status, lat: q.lat, lon: q.lon },
          'maps-static: upstream non-OK',
        );
        res.status(502).end();
        return;
      }
      buf = Buffer.from(await upstream.arrayBuffer());
    } catch (err) {
      logger.warn({ err, lat: q.lat, lon: q.lon }, 'maps-static: upstream failed');
      res.status(504).end();
      return;
    } finally {
      clearTimeout(timer);
    }

    // Persist for the next visitor — fire-and-forget so a Redis
    // blip doesn't sink the response. Even without a successful
    // SET the browser still caches via the immutable header.
    void redis.set(key, buf.toString('base64'), 'EX', STATIC_TTL_SEC).catch(
      (err) => logger.debug({ err }, 'maps-static: cache set failed (continuing)'),
    );

    res.set('X-Map-Snapshot', 'miss');
    res.send(buf);
  } catch (err) {
    next(err);
  }
});

// ─── All-places overview ─────────────────────────────────────────
//
// Aggregates every geocoded place across the user's Page.places[]
// arrays into one deduped list — feeds the /map route's multi-pin
// view. Rounded coords (3 d.p., ~110 m) collapse near-duplicates
// from different pages so two emails about "the same" coffee shop
// share one pin.

mapsRouter.get('/places', async (req, res, next) => {
  try {
    const userId = new Types.ObjectId(userIdOf(req));
    // Pull every page that has at least one geocoded place. We
    // project just `places` to keep the working set small —
    // no contentMd / embedding.
    const pages = await Page.find({
      userId,
      'places.lat': { $ne: null },
    })
      .select('_id slug title places updatedAt')
      .sort({ updatedAt: -1 })
      .lean();

    type PlaceEntry = {
      normKey: string;
      name: string;
      displayName: string | null;
      lat: number;
      lon: number;
      pageCount: number;
      pages: { slug: string; title: string }[];
    };
    const out = new Map<string, PlaceEntry>();
    for (const p of pages) {
      const places = (p.places ?? []) as Array<{
        name?: string;
        normKey?: string;
        lat?: number | null;
        lon?: number | null;
        displayName?: string | null;
        failed?: boolean;
      }>;
      for (const place of places) {
        if (place.failed) continue;
        if (place.lat == null || place.lon == null) continue;
        if (!place.normKey) continue;
        // 3-d.p. rounding to dedupe slight jitter from different
        // geocode batches. We key on normKey too so two places
        // that happen to share a coordinate (same building) but
        // different names stay distinct.
        const lat = Math.round(place.lat * 1000) / 1000;
        const lon = Math.round(place.lon * 1000) / 1000;
        const key = `${place.normKey}__${lat},${lon}`;
        let entry = out.get(key);
        if (!entry) {
          entry = {
            normKey: place.normKey,
            name: place.name ?? place.normKey,
            displayName: place.displayName ?? null,
            lat,
            lon,
            pageCount: 0,
            pages: [],
          };
          out.set(key, entry);
        }
        entry.pageCount += 1;
        if (entry.pages.length < 5) {
          entry.pages.push({ slug: p.slug, title: p.title });
        }
      }
    }
    const list = [...out.values()].sort(
      (a, b) => b.pageCount - a.pageCount || a.name.localeCompare(b.name),
    );
    res.json({ places: list });
  } catch (err) {
    next(err);
  }
});
