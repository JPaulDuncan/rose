import type { Types } from 'mongoose';
import {
  Entity,
  Organization,
  Instruction,
  normalizeTagKey,
  daydreamSubjectKey,
  type PageDoc,
  type EntityType,
} from '@rose/db';
import { EntityExtraction } from '@rose/shared';
import { renderTemplate, SYSTEM_PROMPT_BASE, extractJson } from '@rose/llm';
import { resolveProviderForUser } from '../lib/providers.js';
import { enrichEntityWikidata } from './wikidataResolver.js';
import { logger } from '../lib/logger.js';

export type ExtractedEntity = {
  name: string;
  normKey: string;
  type: EntityType;
  displayName: string;
};

async function templateFor(userId: Types.ObjectId): Promise<string | null> {
  const userDef = await Instruction.findOne({
    userId,
    scope: 'entities',
    isDefault: true,
  });
  if (userDef) return userDef.template;
  const sys = await Instruction.findOne({ userId, scope: 'entities', isSystem: true });
  return sys?.template ?? null;
}

/**
 * Extract named entities from a page via one LLM call. Returns the
 * normalized list (deduped, kebab-keyed). Best-effort: any failure
 * downstream — provider unavailable, JSON parse, Zod validation —
 * yields an empty array so this step can never block page persistence.
 *
 * Side-effects: upserts a row in the per-user `Entity` collection
 * for every emitted entity. This makes future lookups O(1) for the
 * auto-linker and gives the entity-directory UI a stable backing
 * store. New aliases get added; existing ones are preserved.
 */
export async function extractEntitiesFromPage(
  userId: Types.ObjectId,
  page: PageDoc,
): Promise<ExtractedEntity[]> {
  const body = (page.contentMd ?? '').trim();
  if (body.length < 80) return [];
  const trimmed = body.length > 6000 ? body.slice(0, 6000) : body;

  const tpl = await templateFor(userId);
  if (!tpl) {
    logger.warn({ userId: String(userId) }, 'extract-entities: no template');
    return [];
  }

  let resolved;
  try {
    resolved = await resolveProviderForUser(userId, 'generation');
  } catch (err) {
    logger.warn({ err }, 'extract-entities: provider unavailable');
    return [];
  }

  const prompt = renderTemplate(tpl, {
    page_title: page.title ?? '',
    page_summary: page.summary ?? '',
    page_body: trimmed,
  });

  let raw: string;
  try {
    raw = await resolved.provider.generate({
      model: resolved.model,
      prompt,
      system: SYSTEM_PROMPT_BASE,
      format: 'json',
      temperature: 0.1,
      maxTokens: 800,
    });
  } catch (err) {
    logger.warn(
      { err, pageId: String(page._id) },
      'extract-entities: generate failed',
    );
    return [];
  }

  let parsed;
  try {
    parsed = EntityExtraction.parse(extractJson(raw));
  } catch (err) {
    logger.warn(
      { err, raw: raw.slice(0, 200), pageId: String(page._id) },
      'extract-entities: invalid JSON',
    );
    return [];
  }

  const seen = new Map<string, ExtractedEntity>();
  for (const e of parsed.entities) {
    const normKey = normalizeTagKey(e.name);
    if (!normKey) continue;
    if (seen.has(normKey)) continue;
    seen.set(normKey, {
      name: e.name,
      normKey,
      type: e.type,
      displayName: e.name,
    });

    // Upsert the registry row so the directory page and the
    // auto-linker have a stable backing store. Aliases the LLM
    // emitted are normalized through the same kebab function as the
    // primary key. We $addToSet so existing aliases survive a
    // re-extraction without wiping the user's prior data.
    const aliasKeys = (e.aliases ?? [])
      .map((a) => normalizeTagKey(a))
      .filter((a) => a && a !== normKey);

    try {
      await Entity.updateOne(
        { userId, key: normKey },
        {
          $set: {
            displayName: e.name,
            type: e.type,
            lastSeenAt: new Date(),
          },
          $setOnInsert: {
            userId,
            key: normKey,
            pageCount: 0,
          },
          ...(aliasKeys.length
            ? { $addToSet: { aliases: { $each: aliasKeys } } }
            : {}),
        },
        { upsert: true },
      );
      // Organizations are global — every user sees the same row
      // when they open /n/<key>. Dual-write so the per-user Entity
      // captures pageCount + lastSeenAt while the global
      // Organization owns the canonical name + aliases + (later)
      // the LLM-written brief. setOnInsert on displayName means
      // the FIRST extraction to surface an org wins the casing;
      // subsequent extractions don't clobber. Aliases use
      // $addToSet so every user contributes to the global alias
      // list without overwriting each other.
      // Person entities: chain into the Wikidata resolver so
      // /n/<key> can render the Q-ID badge and the relation panel
      // can pull in canonical facts (birthplace, employer) without
      // an LLM call. Place entities are upserted via the separate
      // `runPlacesExtraction` path in generatePage, which does its
      // own enrichEntityWikidata call there. Fire-and-forget —
      // the resolver throttles to one fetch per row per 90 days.
      if (e.type === 'person') {
        void enrichEntityWikidata(userId, normKey).catch((err) =>
          logger.debug(
            { err, key: normKey, type: e.type },
            'extract-entities: entity wikidata enrich failed',
          ),
        );
      }
      if (e.type === 'organization') {
        try {
          await Organization.updateOne(
            { key: normKey },
            {
              $setOnInsert: {
                key: normKey,
                displayName: e.name,
                firstSeenBy: userId,
              },
              ...(aliasKeys.length
                ? { $addToSet: { aliases: { $each: aliasKeys } } }
                : {}),
            },
            { upsert: true },
          );
        } catch (err) {
          logger.warn(
            { err, key: normKey },
            'extract-entities: failed to upsert Organization row',
          );
        }
      }
    } catch (err) {
      // Don't fail the whole extraction over one upsert; the
      // page-level `entities[]` is still durable, and the next
      // page write will retry the row.
      logger.warn(
        { err, userId: String(userId), key: normKey },
        'extract-entities: failed to upsert Entity row',
      );
    }
  }

  return [...seen.values()];
}

/**
 * Plan 12 (R5+G1) — shared post-write entity-extraction step. Runs
 * the same idempotent extract-and-persist cycle that previously
 * lived inside `generatePage.runEntityExtraction`, but in a place
 * any page-write surface can call (briefings + synthesis).
 *
 * Side-effects:
 *   • Sets `Page.entities[]` to the freshly-extracted list.
 *   • Bumps `Page.entitiesExtractedFromHash` so a regenerate that
 *     produces the same body skips the LLM call.
 *   • Adds `{ kind: 'entity' }` entries onto `Page.daydreamSubjects[]`
 *     (deduped) so the sweeper picks the page up for the Background
 *     brief on /n/<key>.
 *
 * Best-effort: any failure inside `extractEntitiesFromPage` already
 * yields an empty list; this caller logs and returns rather than
 * throwing.
 */
export async function runPostWriteEntityExtraction(
  userId: Types.ObjectId,
  page: PageDoc,
  contentHash: string,
): Promise<void> {
  if (contentHash && page.entitiesExtractedFromHash === contentHash) return;
  let extracted: ExtractedEntity[] = [];
  try {
    extracted = await extractEntitiesFromPage(userId, page);
  } catch (err) {
    logger.warn(
      { err, pageId: String(page._id) },
      'post-write entity extraction failed; leaving page.entities as-is',
    );
    return;
  }
  page.entities = extracted.map((e) => ({
    name: e.name.slice(0, 200),
    normKey: e.normKey,
    type: e.type,
    displayName: e.displayName,
  })) as typeof page.entities;
  page.entitiesExtractedFromHash = contentHash;
  page.markModified('entities');

  const existingSubjects = ((page.daydreamSubjects ?? []) as Array<{
    kind: string;
    subjectKey: string;
  }>).slice();
  const seen = new Set(existingSubjects.map((s) => `${s.kind}__${s.subjectKey}`));
  for (const e of extracted) {
    const subjectKey = daydreamSubjectKey(e.displayName);
    const dedupKey = `entity__${subjectKey}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    existingSubjects.push({ kind: 'entity', subjectKey });
  }
  page.daydreamSubjects = existingSubjects.slice(0, 24) as typeof page.daydreamSubjects;
  page.markModified('daydreamSubjects');
  await page.save();
}
