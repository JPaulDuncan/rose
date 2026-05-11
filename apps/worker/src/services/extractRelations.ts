import type { Types } from 'mongoose';
import {
  EntityRelation,
  normalizeTagKey,
  type PageDoc,
} from '@rose/db';
import {
  RelationExtraction,
  activePredicates,
  predicateByKey,
} from '@rose/shared';
import { SYSTEM_PROMPT_BASE, extractJson } from '@rose/llm';
import { createHash } from 'node:crypto';
import { resolveProviderForUser } from '../lib/providers.js';
import { logger } from '../lib/logger.js';

/**
 * Hash the body so a regen with unchanged contentMd skips the LLM
 * call. Same pattern entity/place extractors use.
 */
function hashBody(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

function buildPrompt(page: PageDoc): string {
  const active = activePredicates();
  const lines = active.map((p) => {
    const subj = p.subjectTypes.join('|');
    const obj = p.objectTypes.join('|');
    return `  ${p.key} (${subj} → ${obj}): ${p.description}`;
  });
  const title = page.title ?? '';
  const summary = page.summary ?? '';
  const body = (page.contentMd ?? '').slice(0, 6000);
  return [
    'Extract typed relationships between named entities mentioned in the wiki page below.',
    'Use ONLY these predicates (subject and object types must match the hint):',
    '',
    lines.join('\n'),
    '',
    'Output JSON exactly matching this schema:',
    '{ "relations": [ { "subject": "<entity name as written>",',
    '                   "predicate": "<one of the keys above>",',
    '                   "object": "<entity name as written>",',
    '                   "confidence": <0..1>,',
    '                   "snippet": "<≤240 chars from the body that justifies the claim>" } ] }',
    '',
    'Rules:',
    "  - Only emit a relation if the body explicitly supports it. Don't invent.",
    '  - If a relation is unclear, omit it. Better to return [] than guess.',
    '  - Subject and object names should match how the body wrote them.',
    "  - Include the grounding `snippet` — that's what we audit against.",
    "  - Don't list a relation more than once even if the body repeats it.",
    '',
    `TITLE: ${title}`,
    `SUMMARY: ${summary}`,
    '',
    'BODY:',
    body,
  ].join('\n');
}

/**
 * Extract typed relations from a page and upsert them into the
 * global EntityRelation collection. Idempotent — same triple plus
 * same content hash short-circuits (no duplicate evidence row).
 * Best-effort: any LLM / parse failure logs and returns 0.
 *
 * The page record carries `relationsExtractedFromHash` so a regen
 * with unchanged body skips the LLM call entirely (parallels the
 * existing `entitiesExtractedFromHash`).
 */
export async function extractRelationsFromPage(
  userId: Types.ObjectId,
  page: PageDoc,
): Promise<number> {
  const body = (page.contentMd ?? '').trim();
  if (body.length < 120) return 0;
  const hash = hashBody(body);

  // Skip when this exact body already drove an extraction. The
  // field lives on Page as `relationsExtractedFromHash`; if the
  // schema hasn't been migrated yet the field is undefined and we
  // proceed (a no-op the first time, costless thereafter).
  const cachedHash = (
    page as unknown as { relationsExtractedFromHash?: string }
  ).relationsExtractedFromHash;
  if (cachedHash === hash) return 0;

  let resolved;
  try {
    resolved = await resolveProviderForUser(userId, 'generation');
  } catch (err) {
    logger.debug({ err }, 'extract-relations: provider unavailable');
    return 0;
  }

  let raw: string;
  try {
    raw = await resolved.provider.generate({
      model: resolved.model,
      prompt: buildPrompt(page),
      system: SYSTEM_PROMPT_BASE,
      format: 'json',
      temperature: 0.1,
      maxTokens: 1500,
    });
  } catch (err) {
    logger.warn(
      { err, pageId: String(page._id) },
      'extract-relations: generate failed',
    );
    return 0;
  }

  let parsed: RelationExtraction;
  try {
    parsed = RelationExtraction.parse(extractJson(raw));
  } catch (err) {
    logger.warn(
      { err, raw: raw.slice(0, 200), pageId: String(page._id) },
      'extract-relations: invalid JSON',
    );
    return 0;
  }

  // Dedup within this extraction batch — the LLM occasionally
  // emits the same triple twice with different snippets.
  const seen = new Set<string>();
  let upserted = 0;
  for (const r of parsed.relations) {
    const fromKey = normalizeTagKey(r.subject);
    const toKey = normalizeTagKey(r.object);
    if (!fromKey || !toKey) continue;
    // Self-loops aren't useful and almost always indicate an LLM
    // misread.
    if (fromKey === toKey) continue;
    // Validate the predicate against our vocabulary — the Zod
    // schema already does this, but defensive in case the schema
    // is loosened later.
    const pred = predicateByKey(r.predicate);
    if (!pred || pred.deprecatedAt) continue;
    const tripleKey = `${fromKey}|${r.predicate}|${toKey}`;
    if (seen.has(tripleKey)) continue;
    seen.add(tripleKey);

    const evidenceEntry = {
      userId,
      pageId: page._id as Types.ObjectId,
      snippet: r.snippet.slice(0, 240),
      contentHash: hash,
      extractedAt: new Date(),
    };

    try {
      // Idempotent upsert. The unique (fromKey, predicate, toKey)
      // index prevents dupes; $addToSet would skip re-adding an
      // identical evidence object but Mongo can't compare two
      // sub-documents structurally, so we do a two-step:
      //   1. Upsert the relation with first-time fields.
      //   2. Pull any prior evidence row for this (userId, pageId,
      //      contentHash) — that's the dedup key for evidence —
      //      then push the fresh entry. Bounds the array at 50
      //      entries via $slice so a popular relation can't bloat.
      await EntityRelation.updateOne(
        { fromKey, predicate: r.predicate, toKey },
        {
          $setOnInsert: {
            fromKey,
            predicate: r.predicate,
            toKey,
            firstSeenBy: userId,
          },
          $max: { confidence: r.confidence },
        },
        { upsert: true },
      );
      await EntityRelation.updateOne(
        { fromKey, predicate: r.predicate, toKey },
        {
          $pull: {
            evidence: {
              userId,
              pageId: page._id as Types.ObjectId,
              contentHash: hash,
            },
          },
        },
      );
      await EntityRelation.updateOne(
        { fromKey, predicate: r.predicate, toKey },
        {
          $push: {
            evidence: {
              $each: [evidenceEntry],
              $slice: -50,
            },
          },
        },
      );
      upserted += 1;
    } catch (err) {
      logger.warn(
        { err, triple: tripleKey },
        'extract-relations: upsert failed (continuing)',
      );
    }
  }

  // Stamp the hash on the page so the next regen with identical
  // body skips the LLM call.
  try {
    (page as unknown as { relationsExtractedFromHash?: string }).relationsExtractedFromHash =
      hash;
    page.markModified?.('relationsExtractedFromHash');
    await page.save?.();
  } catch (err) {
    logger.debug({ err }, 'extract-relations: hash stamp failed (ignored)');
  }

  if (upserted > 0) {
    logger.info(
      { pageId: String(page._id), relations: upserted },
      'extract-relations: stored',
    );
  }
  return upserted;
}

/** Convenience wrapper for the post-write pipeline. */
export async function runPostWriteRelationExtraction(
  userId: Types.ObjectId,
  page: PageDoc,
): Promise<void> {
  try {
    await extractRelationsFromPage(userId, page);
  } catch (err) {
    logger.warn(
      { err, pageId: String(page._id) },
      'post-write relation extraction failed; continuing',
    );
  }
}
