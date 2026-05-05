import { z } from 'zod';
import { webFetchJson } from '@rose/llm';
import { webCache } from './webFetchCache.js';

const UA = 'Rose/1.0 (+https://rose.local; maps)';
const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org';

const NominatimResp = z.array(
  z.object({
    lat: z.string(),
    lon: z.string(),
    display_name: z.string(),
    type: z.string().optional(),
    class: z.string().optional(),
  }),
);

export type GeocodeResult = {
  lat: number;
  lon: number;
  displayName: string;
};

/**
 * Polite-pool throttle. Nominatim asks for "absolute maximum 1
 * request per second" sustained — we bound calls per worker
 * process to a 1100ms minimum gap. Worker concurrency on event
 * extraction + page generation is already low; this is belt-and-
 * braces for the case where many places land in quick succession.
 */
const MIN_GAP_MS = 1100;
let lastCalledAt = 0;
async function throttle(): Promise<void> {
  const now = Date.now();
  const wait = lastCalledAt + MIN_GAP_MS - now;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCalledAt = Date.now();
}

/**
 * Geocode a free-text place string via Nominatim. Routes through
 * webFetchJson so the SSRF guard, contactable User-Agent, and the
 * shared 30-day Redis cache all apply automatically. Same place
 * name across users hits the cache after the first lookup, which
 * is the lion's share of the savings.
 *
 * Returns null when:
 *   - Nominatim has no result for the string
 *   - the call fails (network / 5xx / parse error)
 *   - the input is empty / clearly non-geographic
 *
 * Callers persist `null` results as a sticky `geocodeFailed` /
 * `failed: true` so we don't grind through the same dead string
 * every time the source document is touched.
 */
export async function geocode(
  query: string,
  opts: { lang?: string } = {},
): Promise<GeocodeResult | null> {
  const q = query.trim();
  if (!q || q.length < 3) return null;
  await throttle();

  const url =
    `${NOMINATIM_BASE}/search` +
    `?q=${encodeURIComponent(q)}` +
    `&format=jsonv2&limit=1&addressdetails=0`;
  const headers: Record<string, string> = { 'accept-language': opts.lang ?? 'en' };

  const json = await webFetchJson(url, {
    userAgent: UA,
    timeoutMs: 8_000,
    cache: webCache,
    cacheTtlSec: 60 * 60 * 24 * 30, // place names are stable for years
    caller: 'maps.geocode',
    headers,
    schema: NominatimResp,
  });
  const top = json?.[0];
  if (!top) return null;
  const lat = Number(top.lat);
  const lon = Number(top.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon, displayName: top.display_name };
}

/** Lower-cased, whitespace-collapsed key for dedup. */
export function normalizePlaceKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}
