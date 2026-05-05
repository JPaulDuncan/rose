import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { User } from '@rose/db';
import { webFetchJson } from '@rose/llm';
import { userIdOf } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { logger } from '../lib/logger.js';
import { webCache } from '../lib/webFetchCache.js';

export const weatherRouter: Router = Router();

const NOAA_USER_AGENT = 'rose-wiki/0.1 (+https://github.com/anthropics/rose)';

type WeatherLocation = {
  lat: number;
  lon: number;
  label: string;
};

type ForecastPeriod = {
  number: number;
  name: string;
  startTime: string;
  endTime: string;
  isDaytime: boolean;
  temperature: number;
  temperatureUnit: string;
  windSpeed: string;
  // windDirection / icon are present on every NOAA response in
  // practice, but the wire schema marks them with `.default('')` so
  // a missing field becomes empty string rather than throwing — keep
  // the type signature in sync with that fallback.
  windDirection?: string;
  shortForecast: string;
  detailedForecast: string;
  icon?: string;
};

type WeatherCacheEntry = {
  fetchedAt: number;
  current: ForecastPeriod | null;
  periods: ForecastPeriod[];
  brief: string;
};

const WEATHER_TTL_MS = 30 * 60 * 1000; // 30 minutes
const briefCache = new Map<string, WeatherCacheEntry>(); // key = `${userId}:${lat},${lon}`

const SetByQuery = z.object({
  query: z.string().min(2).max(120),
});
const SetByLatLon = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  label: z.string().min(1).max(120),
});
const SetLocationRequest = z.union([SetByQuery, SetByLatLon]);

// Zod-validated wire shapes. NOAA + Nominatim drift occasionally;
// keeping these strict means a breaking change shows up as a parse
// failure in logs instead of an undefined-y crash later.
const NominatimResult = z.array(
  z.object({
    lat: z.string(),
    lon: z.string(),
    display_name: z.string(),
  }),
);
const NoaaPointsResponse = z.object({
  properties: z.object({
    forecast: z.string().url().optional(),
  }),
});
const NoaaForecastResponse = z.object({
  properties: z.object({
    periods: z.array(
      z.object({
        number: z.number(),
        name: z.string(),
        startTime: z.string(),
        endTime: z.string(),
        isDaytime: z.boolean(),
        temperature: z.number(),
        temperatureUnit: z.string(),
        windSpeed: z.string(),
        windDirection: z.string().default(''),
        shortForecast: z.string(),
        detailedForecast: z.string(),
        icon: z.string().default(''),
      }),
    ),
  }),
});

async function geocode(query: string): Promise<WeatherLocation | null> {
  // Free, no-key — Nominatim. UA + 30-day cache for repeated queries
  // (same city looked up many times across users) helps stay under
  // their fair-use limit.
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`;
  const json = await webFetchJson(url, {
    userAgent: NOAA_USER_AGENT,
    cache: webCache,
    cacheTtlSec: 30 * 24 * 60 * 60,
    caller: 'weather.geocode',
    timeoutMs: 6000,
    schema: NominatimResult,
  });
  if (!json || json.length === 0) return null;
  const top = json[0]!;
  return {
    lat: Number(top.lat),
    lon: Number(top.lon),
    label: top.display_name.split(',').slice(0, 3).join(',').trim(),
  };
}

async function fetchNoaaForecast(lat: number, lon: number): Promise<ForecastPeriod[] | null> {
  // Step 1: /points → discover the office-specific forecast URL.
  // This is stable per (lat, lon) so cache it for a day.
  const points = await webFetchJson(
    `https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`,
    {
      userAgent: NOAA_USER_AGENT,
      headers: { accept: 'application/geo+json' },
      cache: webCache,
      cacheTtlSec: 24 * 60 * 60,
      caller: 'weather.noaa.points',
      timeoutMs: 8000,
      schema: NoaaPointsResponse,
    },
  );
  if (!points?.properties.forecast) {
    logger.warn({ lat, lon }, 'NOAA points lookup returned no forecast URL');
    return null;
  }
  // Step 2: forecast itself. Don't cache — NOAA updates the forecast
  // multiple times a day and we already cache the response in the
  // in-memory briefCache for 30 min upstream.
  const fc = await webFetchJson(points.properties.forecast, {
    userAgent: NOAA_USER_AGENT,
    headers: { accept: 'application/geo+json' },
    caller: 'weather.noaa.forecast',
    timeoutMs: 8000,
    schema: NoaaForecastResponse,
  });
  if (!fc) return null;
  return fc.properties.periods;
}

/**
 * Deterministic NOAA brief — assembled from the periods array, no LLM.
 * The previous version asked the generation provider to summarise the
 * JSON, which is the wrong shape: it lets a small/weak local model
 * hallucinate temperatures, drift on conditions, or invent timing.
 * Building it by hand from the structured data means the brief always
 * matches the numbers shown alongside it. Falls back to an empty
 * string when the periods are too sparse to summarise meaningfully.
 */
function buildDeterministicBrief(
  location: WeatherLocation,
  periods: ForecastPeriod[],
): string {
  if (!periods.length) return '';
  const cur = periods[0]!;
  const next = periods[1];
  const upcoming = periods.slice(0, 4);

  // High/low across the next ~24 hours of daytime + nighttime periods.
  const day = upcoming.find((p) => p.isDaytime);
  const night = upcoming.find((p) => !p.isDaytime);
  const high = day?.temperature;
  const low = night?.temperature;
  const unit = cur.temperatureUnit ?? 'F';

  const parts: string[] = [];
  parts.push(
    `${cur.name}: ${cur.shortForecast.toLowerCase()}, ${cur.temperature}°${unit}`,
  );
  if (high != null && low != null && day && night) {
    if (cur.isDaytime) {
      parts.push(`tonight ~${low}°${unit}`);
    } else {
      parts.push(`tomorrow ~${high}°${unit}`);
    }
  }

  // Next-period delta — only mention if the short-forecast text
  // changes meaningfully (different first noun) or the temp moves
  // by more than 10 degrees.
  if (next) {
    const curHead = cur.shortForecast.split(/[ ,]/, 1)[0]?.toLowerCase() ?? '';
    const nextHead = next.shortForecast.split(/[ ,]/, 1)[0]?.toLowerCase() ?? '';
    const tempDelta = Math.abs(next.temperature - cur.temperature);
    if (curHead && nextHead && curHead !== nextHead) {
      parts.push(
        `${next.name.toLowerCase()} turns ${next.shortForecast.toLowerCase()}`,
      );
    } else if (tempDelta >= 10) {
      parts.push(
        `${next.name.toLowerCase()} ${next.temperature}°${unit}`,
      );
    }
  }

  if (cur.windSpeed) parts.push(`wind ${cur.windSpeed.toLowerCase()}`);

  // Capitalise the first letter, end with a period.
  const joined = parts.join(' · ');
  const out = joined.charAt(0).toUpperCase() + joined.slice(1);
  return out.endsWith('.') ? out : out + '.';
  void location; // location is in the surrounding UI label; unused here
}

weatherRouter.get('/location', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const user = await User.findById(userId).select('weatherLocation').lean();
  res.json({ location: user?.weatherLocation ?? null });
});

weatherRouter.post('/location', validateBody(SetLocationRequest), async (req, res, next) => {
  try {
    const userId = new Types.ObjectId(userIdOf(req));
    const body = req.body as typeof SetLocationRequest._type;
    let location: WeatherLocation | null = null;
    if ('query' in body) {
      location = await geocode(body.query);
      if (!location) {
        res
          .status(400)
          .json({ error: 'invalid_request', message: 'Could not geocode that location.' });
        return;
      }
    } else {
      location = { lat: body.lat, lon: body.lon, label: body.label };
    }
    await User.updateOne(
      { _id: userId },
      {
        $set: {
          'weatherLocation.lat': location.lat,
          'weatherLocation.lon': location.lon,
          'weatherLocation.label': location.label,
          'weatherLocation.setAt': new Date(),
        },
      },
    );
    // Bust cache.
    for (const k of [...briefCache.keys()]) {
      if (k.startsWith(`${userId.toString()}:`)) briefCache.delete(k);
    }
    res.json({ location });
  } catch (err) {
    next(err);
  }
});

weatherRouter.delete('/location', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  await User.updateOne(
    { _id: userId },
    { $set: { 'weatherLocation.lat': null, 'weatherLocation.lon': null, 'weatherLocation.label': null } },
  );
  for (const k of [...briefCache.keys()]) {
    if (k.startsWith(`${userId.toString()}:`)) briefCache.delete(k);
  }
  res.json({ ok: true });
});

weatherRouter.get('/', async (req, res, next) => {
  try {
    const userId = new Types.ObjectId(userIdOf(req));
    const user = await User.findById(userId).select('weatherLocation').lean();
    const loc = user?.weatherLocation;
    if (!loc?.lat || !loc?.lon || !loc?.label) {
      res.json({ configured: false });
      return;
    }
    const cacheKey = `${userId.toString()}:${loc.lat},${loc.lon}`;
    const cached = briefCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < WEATHER_TTL_MS) {
      res.json({
        configured: true,
        location: { lat: loc.lat, lon: loc.lon, label: loc.label },
        current: cached.current,
        periods: cached.periods.slice(0, 4),
        brief: cached.brief,
        fetchedAt: new Date(cached.fetchedAt).toISOString(),
        cached: true,
      });
      return;
    }

    const periods = await fetchNoaaForecast(loc.lat, loc.lon);
    if (!periods || periods.length === 0) {
      res
        .status(502)
        .json({ configured: true, error: 'forecast_unavailable', message: 'NOAA returned no forecast.' });
      return;
    }
    const current = periods[0] ?? null;
    const brief = buildDeterministicBrief(
      { lat: loc.lat, lon: loc.lon, label: loc.label },
      periods,
    );
    briefCache.set(cacheKey, {
      fetchedAt: Date.now(),
      current,
      periods,
      brief,
    });
    res.json({
      configured: true,
      location: { lat: loc.lat, lon: loc.lon, label: loc.label },
      current,
      periods: periods.slice(0, 4),
      brief,
      fetchedAt: new Date().toISOString(),
      cached: false,
    });
  } catch (err) {
    next(err);
  }
});
