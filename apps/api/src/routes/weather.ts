import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { User, Instruction } from '@rose/db';
import { renderTemplate } from '@rose/llm';
import { userIdOf } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { resolveProviderForUser } from '../lib/providers.js';
import { logger } from '../lib/logger.js';

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
  windDirection: string;
  shortForecast: string;
  detailedForecast: string;
  icon: string;
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

async function geocode(query: string): Promise<WeatherLocation | null> {
  // Free, no-key — Nominatim. Honor their UA + rate-limit policy.
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': NOAA_USER_AGENT, Accept: 'application/json' },
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { lat: string; lon: string; display_name: string }[];
  if (!json[0]) return null;
  const { lat, lon, display_name } = json[0];
  return {
    lat: Number(lat),
    lon: Number(lon),
    label: display_name.split(',').slice(0, 3).join(',').trim(),
  };
}

async function fetchNoaaForecast(lat: number, lon: number): Promise<ForecastPeriod[] | null> {
  const lookup = await fetch(
    `https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`,
    { headers: { 'User-Agent': NOAA_USER_AGENT, Accept: 'application/geo+json' } },
  );
  if (!lookup.ok) {
    logger.warn({ status: lookup.status }, 'NOAA points lookup failed');
    return null;
  }
  const lookupJson = (await lookup.json()) as {
    properties?: { forecast?: string };
  };
  const forecastUrl = lookupJson.properties?.forecast;
  if (!forecastUrl) return null;
  const fc = await fetch(forecastUrl, {
    headers: { 'User-Agent': NOAA_USER_AGENT, Accept: 'application/geo+json' },
  });
  if (!fc.ok) {
    logger.warn({ status: fc.status }, 'NOAA forecast fetch failed');
    return null;
  }
  const fcJson = (await fc.json()) as {
    properties?: { periods?: ForecastPeriod[] };
  };
  return fcJson.properties?.periods ?? null;
}

async function renderBrief(
  userId: Types.ObjectId,
  location: WeatherLocation,
  periods: ForecastPeriod[],
): Promise<string> {
  // Pull the user's `weather` instruction (their default → system fallback).
  const tpl =
    (await Instruction.findOne({ userId, scope: 'weather', isDefault: true })) ??
    (await Instruction.findOne({ userId, scope: 'weather', isSystem: true }));
  if (!tpl) return '';
  const promptText = renderTemplate(tpl.template, {
    location: location.label,
    now: new Date().toISOString(),
    forecast_data: JSON.stringify(periods.slice(0, 4), null, 2),
  });
  try {
    const { provider, model } = await resolveProviderForUser(userId, 'generation');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12_000);
    let out = '';
    try {
      for await (const chunk of provider.generateStream({
        model,
        prompt: promptText,
        temperature: 0.4,
        signal: ctrl.signal,
      })) {
        out += chunk.response;
      }
    } finally {
      clearTimeout(timer);
    }
    return out.trim();
  } catch (err) {
    logger.warn({ err }, 'weather brief LLM call failed; returning empty brief');
    return '';
  }
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
    const brief = await renderBrief(
      userId,
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
