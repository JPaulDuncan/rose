import { Types } from 'mongoose';
import { Page, User, type PageDoc } from '@rose/db';
import { resolveProviderForUser } from '../lib/providers.js';
import { logger } from '../lib/logger.js';

/** Per-user / per-day cap state stored in memory in the worker. The
 *  user's `settings.vision.dailyCap` is the policy ceiling; we count
 *  describe calls in this map and reset at midnight UTC. Survives a
 *  worker restart-as-zero, which is fine — the goal is to keep
 *  metered providers from running away, not perfect accuracy. */
const callsToday = new Map<string, { day: string; count: number }>();

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function bumpAndCheckCap(userId: string, cap: number): boolean {
  const day = todayKey();
  const cur = callsToday.get(userId);
  if (!cur || cur.day !== day) {
    callsToday.set(userId, { day, count: 1 });
    return true;
  }
  if (cur.count >= cap) return false;
  cur.count += 1;
  return true;
}

const SAFE_CONTENT_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
]);

/**
 * Fetch an image URL with the same SSRF guards as the URL save path,
 * but without the heavyweight redirect-by-hand loop — we trust the
 * fetch's own redirect handling for this read-only describe step.
 * Returns base64 + mime type, or null on failure / unsupported type.
 */
async function fetchImageAsBase64(
  url: string,
  signal?: AbortSignal,
): Promise<{ bytes: string; mimeType: string } | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Rose/1.0 (+https://rose.local)' },
      signal,
    });
    if (!res.ok) return null;
    const ct = (res.headers.get('content-type') ?? 'image/jpeg').split(';')[0]!.trim();
    if (!SAFE_CONTENT_TYPES.has(ct)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > 4 * 1024 * 1024) return null; // 4MB cap per image
    return { bytes: buf.toString('base64'), mimeType: ct };
  } catch {
    return null;
  }
}

/**
 * Walk the page's images and describe up to `maxPerPage` of them
 * using the user's configured generation provider's vision capability.
 * Skips images that already have a description, and respects the
 * user's daily cap.
 *
 * Best-effort end-to-end — failures are logged but never abort the
 * generate-page job.
 */
export async function describePageImages(
  userId: Types.ObjectId,
  page: PageDoc,
  maxPerPage = 3,
): Promise<{ described: number; skipped: number }> {
  const user = await User.findById(userId).select('settings.vision providers').lean();
  const cfg = (user?.settings as { vision?: { enabled?: boolean; model?: string; dailyCap?: number } } | undefined)
    ?.vision ?? {};
  if (!cfg.enabled) return { described: 0, skipped: 0 };

  const cap = cfg.dailyCap ?? 30;
  const images =
    (page.pageImages as { url: string; alt?: string | null; description?: string | null }[]) ??
    [];
  const targets = images
    .filter((img) => !img.description && /^https?:\/\//i.test(img.url))
    .slice(0, maxPerPage);
  if (targets.length === 0) return { described: 0, skipped: 0 };

  let provider;
  let visionModel: string;
  try {
    const r = await resolveProviderForUser(userId, 'generation');
    provider = r.provider;
    if (!provider.supportsVision) return { described: 0, skipped: targets.length };
    visionModel = cfg.model || r.model;
  } catch {
    return { described: 0, skipped: targets.length };
  }

  let described = 0;
  for (let i = 0; i < targets.length; i += 1) {
    if (!bumpAndCheckCap(String(userId), cap)) {
      logger.info({ userId: String(userId), cap }, 'vision: daily cap hit; skipping rest');
      break;
    }
    const target = targets[i]!;
    try {
      // Anthropic + OpenAI accept URLs; Ollama needs base64. Try the
      // URL path first and fall back to fetch-then-base64 on error.
      let description: string;
      try {
        description = await provider.describeImage(
          { url: target.url },
          { model: visionModel, prompt: 'Describe this image in one short paragraph.' },
        );
      } catch {
        const fetched = await fetchImageAsBase64(target.url);
        if (!fetched) throw new Error('image fetch failed');
        description = await provider.describeImage(
          { bytes: fetched.bytes, mimeType: fetched.mimeType },
          { model: visionModel, prompt: 'Describe this image in one short paragraph.' },
        );
      }
      const trimmed = description.trim().slice(0, 600);
      if (trimmed) {
        // Find this image in the page's pageImages by url and persist
        // the description.
        const idx = (page.pageImages as { url: string }[] | undefined)?.findIndex(
          (img) => img.url === target.url,
        );
        if (idx != null && idx >= 0) {
          await Page.updateOne(
            { _id: page._id, [`pageImages.${idx}.url`]: target.url },
            { $set: { [`pageImages.${idx}.description`]: trimmed } },
          );
          described += 1;
        }
      }
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, url: target.url.slice(0, 80) },
        'vision: describe failed (continuing)',
      );
    }
  }
  return { described, skipped: targets.length - described };
}
