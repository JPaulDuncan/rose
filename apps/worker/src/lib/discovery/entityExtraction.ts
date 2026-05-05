import { z } from 'zod';
import type { Types } from 'mongoose';
import type { PageDoc } from '@rose/db';
import { resolveProviderForUser } from '../providers.js';
import { logger } from '../logger.js';

const ENTITY_SYSTEM = `Extract up to 8 named entities from the wiki page body provided by the user.

Return JSON: {"entities": [{"name": string, "kind": "person"|"org"|"place"|"work"|"concept"|"other"}, ...]}

Rules:
- Only proper nouns and named concepts. NOT generic terms like "team", "company", "platform" unless qualified by a proper name (e.g. "Acme Corp", "PyTorch").
- Prefer specificity: "Steve Jobs" not "person", "OpenStreetMap" not "map".
- Skip the user's own emails / addresses.
- Skip date strings, numbers, URLs.
- If there are fewer than 8 worthwhile entities, return only those.
- If there are no clear entities, return {"entities": []}.

Output JSON only — no prose, no markdown fences.`;

const EntityList = z.object({
  entities: z
    .array(
      z.object({
        name: z.string().min(1).max(120),
        kind: z.enum(['person', 'org', 'place', 'work', 'concept', 'other']),
      }),
    )
    .max(16),
});

export type ExtractedEntity = {
  name: string;
  kind: 'person' | 'org' | 'place' | 'work' | 'concept' | 'other';
};

/**
 * Extract named entities from a page's body via one LLM call. Result
 * is cached on `Page.daydreamSubjects` after the worker persists, so
 * this only runs once per page (and once after a page body change,
 * if the worker decides to re-extract).
 *
 * Returns an empty array on any failure — the caller falls back to
 * topics + tags as the subject set, which is what plan 09 already
 * shipped.
 */
export async function extractEntitiesFromPage(
  userId: Types.ObjectId,
  page: PageDoc,
): Promise<ExtractedEntity[]> {
  const body = (page.contentMd ?? '').trim();
  // Don't burn an LLM call on a near-empty page — the result would
  // be noise.
  if (body.length < 200) return [];
  const trimmed = body.length > 6000 ? body.slice(0, 6000) : body;
  let resolved;
  try {
    resolved = await resolveProviderForUser(userId, 'generation');
  } catch (err) {
    logger.warn({ err, pageId: String(page._id) }, 'entity-extract: provider unavailable');
    return [];
  }
  let raw: string;
  try {
    raw = await resolved.provider.generate({
      model: resolved.model,
      prompt: trimmed,
      system: ENTITY_SYSTEM,
      format: 'json',
      temperature: 0.1,
    });
  } catch (err) {
    logger.warn({ err, pageId: String(page._id) }, 'entity-extract: generate failed');
    return [];
  }
  // Strip code fences if the model wrapped the JSON.
  const json = raw
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();
  let parsed: { entities: ExtractedEntity[] };
  try {
    parsed = EntityList.parse(JSON.parse(json));
  } catch (err) {
    logger.warn(
      { err, raw: raw.slice(0, 300), pageId: String(page._id) },
      'entity-extract: invalid JSON',
    );
    return [];
  }
  return parsed.entities;
}
