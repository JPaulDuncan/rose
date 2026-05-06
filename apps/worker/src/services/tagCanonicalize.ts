import { Types } from 'mongoose';
import {
  Instruction,
  TagCanonical,
  normalizeTagKey,
  titleCaseTag,
} from '@rose/db';
import { TagCanonicalization } from '@rose/shared';
import { SYSTEM_PROMPT_BASE, extractJson, renderTemplate } from '@rose/llm';
import { resolveProviderForUser, applyParamOverrides } from '../lib/providers.js';
import { logger } from '../lib/logger.js';

/**
 * Resolve a freshly-emitted tag list onto the user's canonical-tag
 * registry. Returns the deduplicated canonical-form list (kebab-case
 * strings) suitable for persisting on `Page.tags`.
 *
 * Hot-path optimisation: the LLM is only called when there is at
 * least one tag we can't resolve via direct canonical / alias
 * lookup. For pages whose tags are all already known, this is a
 * single `find()` and zero LLM calls.
 *
 * Failure mode: if the LLM call or its JSON validation fails, the
 * function logs and returns the raw normalised tags unchanged —
 * canonicalisation is a polish step, never load-bearing.
 */
export async function canonicalizeTags(
  userId: Types.ObjectId,
  rawTags: string[],
): Promise<string[]> {
  const normalised = [
    ...new Set(rawTags.map((t) => normalizeTagKey(t)).filter((t) => t.length > 0)),
  ];
  if (normalised.length === 0) return [];

  // Direct canonical or alias hit. Cheap; covers the steady state
  // where every tag is already known. If every tag resolves we
  // return without ever talking to the LLM.
  const directHits = await TagCanonical.find({
    userId,
    $or: [
      { canonical: { $in: normalised } },
      { aliases: { $in: normalised } },
    ],
  })
    .select('canonical aliases')
    .lean();

  const resolved = new Map<string, string>();
  for (const row of directHits) {
    if (normalised.includes(row.canonical)) resolved.set(row.canonical, row.canonical);
    for (const a of row.aliases ?? []) {
      if (normalised.includes(a)) resolved.set(a, row.canonical);
    }
  }
  const unknown = normalised.filter((t) => !resolved.has(t));
  if (unknown.length === 0) {
    return [...new Set(resolved.values())];
  }

  // We have at least one unknown tag — fetch a candidate set of
  // existing canonicals to feed the LLM as the "merge into one of
  // these or treat as new" anchor list. Prefer the heaviest tags
  // first so the LLM has the user's most-used taxonomy in front of
  // it; cap at 80 lines so the prompt stays bounded for users with
  // thousands of canonicals.
  const existingCanonicals = await TagCanonical.find({ userId })
    .sort({ pageCount: -1, updatedAt: -1 })
    .limit(80)
    .select('canonical displayName aliases')
    .lean();

  const template = await getTagCanonInstruction(userId);
  if (!template) {
    // No instruction wired up — fall back to passthrough so the
    // page generation never blocks on this step.
    logger.warn(
      { userId: String(userId) },
      'tag-canon: no instruction template; passing tags through unchanged',
    );
    return finaliseWithoutLLM(resolved, unknown);
  }

  const prompt = renderTemplate(template, {
    emitted_tags: unknown.join(', '),
    existing_canonicals:
      existingCanonicals
        .map(
          (c) =>
            `${c.canonical}\t${c.displayName ?? titleCaseTag(c.canonical)}\t${(c.aliases ?? []).join(',')}`,
        )
        .join('\n') || '(none yet)',
  });

  let parsed;
  try {
    const { provider, model, params: userParams } = await resolveProviderForUser(
      userId,
      'generation',
    );
    const merged = applyParamOverrides({ temperature: 0.1 }, userParams);
    const text = await provider.generate({
      model,
      prompt,
      system: SYSTEM_PROMPT_BASE,
      format: 'json',
      temperature: merged.temperature ?? 0.1,
      maxTokens: 800,
    });
    parsed = TagCanonicalization.parse(extractJson(text));
  } catch (err) {
    logger.warn(
      { err, userId: String(userId), unknown },
      'tag-canon: LLM step failed — falling back to passthrough',
    );
    return finaliseWithoutLLM(resolved, unknown);
  }

  // Apply the LLM's mappings. For any emitted tag the LLM didn't
  // map (defensive — the prompt requires every tag to appear), we
  // synthesise a fresh canonical from the tag itself.
  const llmMap = new Map<string, { canonical: string; displayName: string; isNew: boolean }>();
  for (const m of parsed.mappings) {
    const tagKey = normalizeTagKey(m.tag);
    const canonKey = normalizeTagKey(m.canonical);
    if (!tagKey || !canonKey) continue;
    llmMap.set(tagKey, {
      canonical: canonKey,
      displayName: m.displayName?.trim() || titleCaseTag(canonKey),
      isNew: m.isNew,
    });
  }

  for (const tag of unknown) {
    const hit = llmMap.get(tag);
    if (hit) {
      resolved.set(tag, hit.canonical);
      // Persist the alias / new canonical so subsequent runs hit
      // the cheap path. Best-effort: a failure here doesn't block
      // page generation.
      try {
        await persistMapping(userId, tag, hit.canonical, hit.displayName, hit.isNew);
      } catch (err) {
        logger.warn(
          { err, userId: String(userId), tag, canonical: hit.canonical },
          'tag-canon: failed to persist alias',
        );
      }
    } else {
      // LLM dropped this one — treat as a fresh canonical.
      resolved.set(tag, tag);
      try {
        await persistMapping(userId, tag, tag, titleCaseTag(tag), true);
      } catch {
        // ignore
      }
    }
  }

  return [...new Set(resolved.values())];
}

/**
 * Resolve a list of canonical kebab keys to their human-readable
 * display names. Used by the API to attach `tagDisplayNames` to the
 * page payload so the UI can render "Job Listings" while the URL
 * route stays `/t/job-listings`.
 */
export async function resolveTagDisplayNames(
  userId: Types.ObjectId,
  canonicals: string[],
): Promise<Record<string, string>> {
  const keys = [...new Set(canonicals.map((c) => normalizeTagKey(c)).filter(Boolean))];
  if (keys.length === 0) return {};
  const rows = await TagCanonical.find({ userId, canonical: { $in: keys } })
    .select('canonical displayName')
    .lean();
  const out: Record<string, string> = {};
  for (const k of keys) out[k] = titleCaseTag(k); // sane default
  for (const r of rows) {
    if (r.displayName && r.displayName.trim()) out[r.canonical] = r.displayName;
  }
  return out;
}

async function getTagCanonInstruction(userId: Types.ObjectId): Promise<string> {
  const userDef = await Instruction.findOne({
    userId,
    scope: 'tag-canon',
    isDefault: true,
  });
  if (userDef?.template) return userDef.template;
  const sys = await Instruction.findOne({ userId, scope: 'tag-canon', isSystem: true });
  return sys?.template ?? '';
}

function finaliseWithoutLLM(
  resolved: Map<string, string>,
  unknown: string[],
): string[] {
  for (const t of unknown) resolved.set(t, t);
  return [...new Set(resolved.values())];
}

async function persistMapping(
  userId: Types.ObjectId,
  alias: string,
  canonical: string,
  displayName: string,
  isNew: boolean,
): Promise<void> {
  if (alias === canonical && !isNew) {
    // Pure passthrough; nothing to persist.
    return;
  }
  if (isNew || alias === canonical) {
    // Create the canonical if needed; idempotent upsert.
    await TagCanonical.updateOne(
      { userId, canonical },
      {
        $setOnInsert: {
          userId,
          canonical,
          displayName: displayName || titleCaseTag(canonical),
        },
        $addToSet: alias !== canonical ? { aliases: alias } : { aliases: { $each: [] } },
      },
      { upsert: true },
    );
    return;
  }
  // Aliasing onto an existing canonical.
  await TagCanonical.updateOne(
    { userId, canonical },
    {
      $setOnInsert: {
        userId,
        canonical,
        displayName: displayName || titleCaseTag(canonical),
      },
      $addToSet: { aliases: alias },
    },
    { upsert: true },
  );
}
