import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Types } from 'mongoose';
import { Instruction, type PageDoc } from '@rose/db';
import { renderTemplate, SYSTEM_PROMPT_BASE } from '@rose/llm';
import { resolveProviderForUser } from '../lib/providers.js';
import { logger } from '../lib/logger.js';

const PlacesOutput = z.object({
  places: z
    .array(
      z.object({
        name: z.string().min(1).max(160),
      }),
    )
    .max(8),
});

export type ExtractedPlace = { name: string };

/** SHA-256 of the page contentMd we last extracted from, used to
 *  skip re-extraction when the body hasn't moved. */
export function hashContent(s: string): string {
  return createHash('sha256').update(s ?? '').digest('hex').slice(0, 32);
}

async function templateFor(userId: Types.ObjectId): Promise<string | null> {
  const user = await Instruction.findOne({ userId, scope: 'places', isDefault: true });
  if (user) return user.template;
  const sys = await Instruction.findOne({ userId, scope: 'places', isSystem: true });
  return sys?.template ?? null;
}

/**
 * Extract named places from a page body via one LLM call. Returns
 * an empty array on any failure — callers fall back to whatever
 * places the page already has.
 *
 * Idempotent guard: callers store the page-content hash on the
 * page after a successful run; this helper doesn't manage that
 * state itself, but it returns enough info that the caller can
 * decide whether to bump the stored hash.
 */
export async function extractPlacesFromPage(
  userId: Types.ObjectId,
  page: PageDoc,
): Promise<ExtractedPlace[]> {
  const body = (page.contentMd ?? '').trim();
  if (body.length < 80) return [];
  const trimmed = body.length > 6000 ? body.slice(0, 6000) : body;

  const tpl = await templateFor(userId);
  if (!tpl) {
    logger.warn({ userId: String(userId) }, 'extract-places: no template');
    return [];
  }

  let resolved;
  try {
    resolved = await resolveProviderForUser(userId, 'generation');
  } catch (err) {
    logger.warn({ err }, 'extract-places: provider unavailable');
    return [];
  }

  const prompt = renderTemplate(tpl, {
    title: page.title ?? '',
    body: trimmed,
  });

  let raw: string;
  try {
    raw = await resolved.provider.generate({
      model: resolved.model,
      prompt,
      system: SYSTEM_PROMPT_BASE,
      format: 'json',
      temperature: 0.1,
    });
  } catch (err) {
    logger.warn({ err, pageId: String(page._id) }, 'extract-places: generate failed');
    return [];
  }

  const json = raw
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();
  let parsed: { places: ExtractedPlace[] };
  try {
    parsed = PlacesOutput.parse(JSON.parse(json));
  } catch (err) {
    logger.warn(
      { err, raw: raw.slice(0, 200), pageId: String(page._id) },
      'extract-places: invalid JSON',
    );
    return [];
  }
  return parsed.places;
}
