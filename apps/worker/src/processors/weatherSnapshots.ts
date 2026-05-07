import { Queue, Worker, type Job } from 'bullmq';
import { Types } from 'mongoose';
import { z } from 'zod';
import { User, WeatherSnapshot } from '@rose/db';
import { webFetchJson } from '@rose/llm';
import { redis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { webCache } from '../lib/webFetchCache.js';

const QUEUE = 'rose.weather-snapshot';

/**
 * Server-side weather-snapshot sweeper. Runs every 30 minutes on a
 * BullMQ repeatable so the trend chart on /weather hydrates even if
 * nobody has the home weather panel open. Mirrors what the API
 * brief endpoint does on a cache-miss, except this path is
 * unconditional — every distinct configured location gets one
 * snapshot per pass.
 *
 * Why this exists: the brief endpoint only writes a snapshot when
 * its 30-minute in-memory cache misses, which happens at most once
 * per user-active-poll-on-the-boundary. If the SPA is closed (or
 * the API process restarted recently and the cache is warm but the
 * user isn't poking it), no snapshots accumulate. A trend chart
 * that needs you to be staring at it to grow is the wrong tradeoff.
 */

const NOAA_USER_AGENT = 'rose-wiki/0.1 (+https://github.com/anthropics/rose)';

const NoaaPointsResponse = z.object({
  properties: z.object({
    forecast: z.string().optional(),
  }),
});

const NoaaForecastResponse = z.object({
  properties: z.object({
    periods: z
      .array(
        z.object({
          number: z.number().optional(),
          name: z.string().optional(),
          startTime: z.string().optional(),
          endTime: z.string().optional(),
          isDaytime: z.boolean().optional(),
          temperature: z.number().optional(),
          temperatureUnit: z.string().optional(),
          windSpeed: z.string().optional(),
          windDirection: z.string().optional(),
          icon: z.string().optional(),
          shortForecast: z.string().optional(),
        }),
      )
      .optional(),
  }),
});

type StoredLocation = {
  id: string;
  lat: number;
  lon: number;
  label: string;
  primary?: boolean;
};

function roundCoord(n: number): number {
  return Math.round(n * 1000) / 1000;
}

async function fetchNoaaCurrent(
  lat: number,
  lon: number,
): Promise<{
  temperature: number;
  temperatureUnit: string;
  shortForecast: string;
  windSpeed: string;
  windDirection: string;
  isDaytime: boolean;
  icon: string | null;
  startTime: Date | null;
  endTime: Date | null;
} | null> {
  try {
    const points = await webFetchJson(
      `https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`,
      {
        userAgent: NOAA_USER_AGENT,
        headers: { accept: 'application/geo+json' },
        cache: webCache,
        cacheTtlSec: 24 * 60 * 60,
        caller: 'weather-snapshot.noaa.points',
        timeoutMs: 8000,
        schema: NoaaPointsResponse,
      },
    );
    if (!points?.properties.forecast) return null;
    const fc = await webFetchJson(points.properties.forecast, {
      userAgent: NOAA_USER_AGENT,
      headers: { accept: 'application/geo+json' },
      timeoutMs: 8000,
      caller: 'weather-snapshot.noaa.forecast',
      schema: NoaaForecastResponse,
    });
    const period = fc?.properties.periods?.[0];
    if (!period || period.temperature == null) return null;
    return {
      temperature: period.temperature,
      temperatureUnit: period.temperatureUnit ?? 'F',
      shortForecast: period.shortForecast ?? '',
      windSpeed: period.windSpeed ?? '',
      windDirection: period.windDirection ?? '',
      isDaytime: period.isDaytime ?? true,
      icon: period.icon ?? null,
      startTime: period.startTime ? new Date(period.startTime) : null,
      endTime: period.endTime ? new Date(period.endTime) : null,
    };
  } catch (err) {
    logger.debug({ err, lat, lon }, 'weather-snapshot: NOAA fetch failed');
    return null;
  }
}

async function runSweep(): Promise<{ locations: number; written: number }> {
  // Distinct locations across all users, rounded to the same 3-d.p.
  // grid the brief endpoint uses so the unique index dedupes
  // concurrent writes from this sweep + a live request.
  const users = await User.find({
    'weatherLocations.0': { $exists: true },
  })
    .select('weatherLocations')
    .lean();

  const points = new Map<string, { lat: number; lon: number; label: string }>();
  for (const u of users) {
    for (const loc of (u.weatherLocations ?? []) as StoredLocation[]) {
      const lat = roundCoord(loc.lat);
      const lon = roundCoord(loc.lon);
      const key = `${lat},${lon}`;
      if (!points.has(key)) points.set(key, { lat, lon, label: loc.label });
    }
  }
  if (points.size === 0) return { locations: 0, written: 0 };

  let written = 0;
  for (const { lat, lon, label } of points.values()) {
    const current = await fetchNoaaCurrent(lat, lon);
    if (!current) continue;
    try {
      const fetchedAt = new Date();
      const r = await WeatherSnapshot.updateOne(
        { lat, lon, fetchedAt },
        {
          $setOnInsert: {
            lat,
            lon,
            fetchedAt,
            label,
            ...current,
          },
          $set: { label },
        },
        { upsert: true },
      );
      if (r.upsertedCount) written += 1;
    } catch (err) {
      logger.warn({ err, lat, lon }, 'weather-snapshot: upsert failed');
    }
  }
  return { locations: points.size, written };
}

export function startWeatherSnapshotWorker(): void {
  const worker = new Worker(
    QUEUE,
    async (_job: Job) => {
      const r = await runSweep();
      logger.info(r, 'weather-snapshot: sweep complete');
    },
    { connection: redis, concurrency: 1 },
  );
  worker.on('failed', (job, err) =>
    logger.error({ err, jobId: job?.id }, 'weather-snapshot: sweep failed'),
  );
}

/** Schedule the 30-minute repeatable + an immediate one-shot at
 *  boot so trend data starts accruing without waiting half an hour. */
export async function scheduleWeatherSnapshotSweeper(): Promise<void> {
  const queue = new Queue(QUEUE, { connection: redis });
  await queue.add(
    'sweep',
    {},
    { repeat: { every: 30 * 60 * 1000 }, jobId: 'weather:snapshot:sweep' },
  );
  await queue.add('sweep', {}, { attempts: 1, removeOnComplete: 5 });
}
