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
import { cosine } from '../lib/vec.js';
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
 * function logs and returns the raw normalized tags unchanged —
 * canonicalisation is a polish step, never load-bearing.
 */
export async function canonicalizeTags(
  userId: Types.ObjectId,
  rawTags: string[],
): Promise<string[]> {
  const normalized = [
    ...new Set(rawTags.map((t) => normalizeTagKey(t)).filter((t) => t.length > 0)),
  ];
  if (normalized.length === 0) return [];

  // Direct canonical or alias hit. Cheap; covers the steady state
  // where every tag is already known. Tags are global — any user's
  // prior canonicalisation seeds the cache for everyone else, so
  // we don't filter by userId here.
  const directHits = await TagCanonical.find({
    $or: [
      { canonical: { $in: normalized } },
      { aliases: { $in: normalized } },
    ],
  })
    .select('canonical aliases')
    .lean();

  const resolved = new Map<string, string>();
  for (const row of directHits) {
    if (normalized.includes(row.canonical)) resolved.set(row.canonical, row.canonical);
    for (const a of row.aliases ?? []) {
      if (normalized.includes(a)) resolved.set(a, row.canonical);
    }
  }
  let unknown = normalized.filter((t) => !resolved.has(t));
  if (unknown.length === 0) {
    return [...new Set(resolved.values())];
  }

  // We have at least one unknown tag — fetch a candidate set of
  // existing canonicals to feed BOTH the deterministic cascade
  // and (when needed) the LLM prompt. Prefer the heaviest tags
  // first so the LLM has the most-used global taxonomy in front of
  // it; cap at 200 here (was 80) since the cascade benefits from
  // a wider candidate set without paying LLM-prompt cost for it.
  const existingCanonicals = await TagCanonical.find({})
    .sort({ pageCount: -1, updatedAt: -1 })
    .limit(200)
    .select('canonical displayName aliases')
    .lean();

  // ── Deterministic cascade: suffix collapse → edit distance.
  // Most "unknown" tags are simple variants of known canonicals
  // (`invoices` → `invoice`, `remote-working` → `remote-work`).
  // The LLM was doing this work at meaningful cost; do it for free
  // here first, and only fall through to the LLM for the genuinely-
  // ambiguous tail (synonyms, novel concepts).
  const canonicalKeys = existingCanonicals.map((c) => c.canonical as string);
  const aliasIndex = new Map<string, string>();
  for (const c of existingCanonicals) {
    for (const a of ((c.aliases as string[] | undefined) ?? [])) {
      aliasIndex.set(a, c.canonical as string);
    }
  }
  const canonicalSet = new Set(canonicalKeys);
  const stillUnknown: string[] = [];
  for (const tag of unknown) {
    const suffixHit = trySuffixCollapse(tag, canonicalSet, aliasIndex);
    if (suffixHit) {
      resolved.set(tag, suffixHit);
      // Persist the alias so the next page write hits the cheap
      // direct-lookup path. Best-effort.
      try {
        await persistMapping(userId, tag, suffixHit, '', false);
      } catch {
        // ignore
      }
      continue;
    }
    const editHit = tryEditDistance(tag, canonicalKeys);
    if (editHit) {
      resolved.set(tag, editHit);
      try {
        await persistMapping(userId, tag, editHit, '', false);
      } catch {
        // ignore
      }
      continue;
    }
    stillUnknown.push(tag);
  }
  if (stillUnknown.length === 0) {
    return [...new Set(resolved.values())];
  }
  unknown = stillUnknown;

  // ── Embedding-similarity pass: only fold tags whose meaning is
  // genuinely near-synonymous with an existing canonical. This is
  // the LAST free rung before the LLM. Gated aggressively —
  // threshold 0.92 cosine — because the failure mode is bridging
  // distinct concepts ("python" → "ruby") which is harder to
  // notice and harder to undo than a missed merge. Embeddings are
  // expensive, so:
  //   1. Compute the unknown tag's embedding once per call.
  //   2. Read canonical embeddings from the persisted cache when
  //      present; lazily backfill the missing ones for the
  //      top-100 most-used canonicals only (the candidates we
  //      actually score against).
  //   3. Skip gracefully if the embedding provider is unavailable.
  const tryEmbed = await runEmbeddingRung(
    userId,
    unknown,
    existingCanonicals,
  );
  const stillUnknownAfterEmbed: string[] = [];
  for (const tag of unknown) {
    const hit = tryEmbed.get(tag);
    if (hit) {
      resolved.set(tag, hit);
      try {
        await persistMapping(userId, tag, hit, '', false);
      } catch {
        // ignore
      }
    } else {
      stillUnknownAfterEmbed.push(tag);
    }
  }
  if (stillUnknownAfterEmbed.length === 0) {
    return [...new Set(resolved.values())];
  }
  // From here down only the genuinely-novel tags hit the LLM.
  unknown = stillUnknownAfterEmbed;

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
  // synthesize a fresh canonical from the tag itself.
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
  // Global registry — drop the userId filter; the displayName is
  // shared. The userId param is kept on the function signature so
  // callers don't have to change.
  void userId;
  const rows = await TagCanonical.find({ canonical: { $in: keys } })
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

/**
 * Suffix-collapse pass — the cheap first line of the cascade.
 * Looks for plural/singular variants of an unknown tag against the
 * existing canonicals + aliases. Examples:
 *   • `invoices`  → matches canonical `invoice`
 *   • `invoice`   → matches canonical `invoices` (rarer; supported)
 *   • `companies` → matches canonical `company` (ies → y)
 *
 * Conservative on stem length so we don't collapse `news` → `ne`
 * or `bus` → `bu`. Stems below 3 chars are rejected.
 *
 * Exported for vitest coverage so the rules are pinned.
 */
export function trySuffixCollapse(
  tag: string,
  canonicalSet: Set<string>,
  aliasIndex: Map<string, string>,
): string | null {
  const candidates: string[] = [];
  // Singularising the unknown tag.
  if (tag.endsWith('ies') && tag.length > 4) {
    candidates.push(tag.slice(0, -3) + 'y');
  }
  if (tag.endsWith('es') && tag.length > 4) {
    candidates.push(tag.slice(0, -2));
  }
  if (tag.endsWith('s') && tag.length > 3) {
    candidates.push(tag.slice(0, -1));
  }
  // Pluralising — handles the rarer case where the canonical was
  // emitted in plural form first.
  if (tag.length > 2) {
    candidates.push(tag + 's');
    if (tag.endsWith('y')) candidates.push(tag.slice(0, -1) + 'ies');
    if (!tag.endsWith('s')) candidates.push(tag + 'es');
  }
  for (const c of candidates) {
    if (c.length < 3) continue;
    if (canonicalSet.has(c)) return c;
    const aliasHit = aliasIndex.get(c);
    if (aliasHit) return aliasHit;
  }
  return null;
}

/**
 * Levenshtein distance with an early-exit threshold. Computes the
 * standard DP table only up to `maxDistance` rows of edits before
 * giving up — keeps the cascade fast for long tag sets.
 *
 * Exported for vitest coverage.
 */
export function boundedLevenshtein(
  a: string,
  b: string,
  maxDistance: number,
): number {
  if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;
  if (a === b) return 0;
  const la = a.length;
  const lb = b.length;
  // Allocate one row at a time — the standard space-optimised DP.
  let prev = new Array<number>(lb + 1);
  let curr = new Array<number>(lb + 1);
  for (let j = 0; j <= lb; j += 1) prev[j] = j;
  for (let i = 1; i <= la; i += 1) {
    curr[0] = i;
    let rowMin = curr[0]!;
    for (let j = 1; j <= lb; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1]! + 1,
        prev[j]! + 1,
        prev[j - 1]! + cost,
      );
      if (curr[j]! < rowMin) rowMin = curr[j]!;
    }
    if (rowMin > maxDistance) return maxDistance + 1;
    [prev, curr] = [curr, prev];
  }
  return prev[lb]!;
}

/**
 * Edit-distance pass — catches typos and slight variants the
 * suffix pass missed. Threshold scales with tag length so short
 * tags ("css" vs "cs") need an exact match while longer ones
 * ("remote-working" vs "remote-work") tolerate a couple of edits.
 *
 *   ≤ 5 chars     →  distance ≤ 1
 *   ≤ 8 chars     →  distance ≤ 1
 *   > 8 chars     →  distance ≤ 2
 *
 * Returns the canonical with the SMALLEST distance ≤ threshold, or
 * null when nothing's close enough. Exported for vitest coverage.
 */
export function tryEditDistance(
  tag: string,
  canonicalKeys: string[],
): string | null {
  // Short tags are noisy at edit-distance 1 (e.g. "ci" vs "cd" are
  // unrelated). Require exact equality below 5 chars.
  if (tag.length < 5) return null;
  const maxDistance = tag.length <= 8 ? 1 : 2;
  let best: { canonical: string; distance: number } | null = null;
  for (const c of canonicalKeys) {
    if (Math.abs(c.length - tag.length) > maxDistance) continue;
    const d = boundedLevenshtein(tag, c, maxDistance);
    if (d <= maxDistance && (!best || d < best.distance)) {
      best = { canonical: c, distance: d };
      if (d === 0) break; // can't beat zero
    }
  }
  return best?.canonical ?? null;
}

/**
 * Cosine threshold for the embedding rung. 0.92 is intentionally
 * tight — at this score on a small-model embedding the two tags
 * tend to be near-synonyms ("authentication" / "auth", "machine-
 * learning" / "ml"). At 0.85 you start folding adjacent-but-
 * distinct concepts ("python" / "ruby"), which is hard to undo
 * because the loser canonical disappears as an alias.
 */
const EMBED_SIM_THRESHOLD = 0.92;
/** How many existing canonicals to score against. Bounded so the
 *  per-page cost stays predictable; the candidates are
 *  pageCount-ranked so the top of the taxonomy is always covered. */
const EMBED_CANDIDATE_CAP = 100;

type CanonicalCandidate = {
  canonical: string;
  displayName?: string | null;
  aliases?: string[];
};

/**
 * Score each unknown tag against the top-pageCount canonicals via
 * embedding cosine similarity. Returns a map of `tag → canonical`
 * for matches at or above the threshold. The unknown tag's
 * embedding is computed once; canonical embeddings come from the
 * persisted cache when present and are lazily filled in when
 * absent.
 *
 * Best-effort: returns an empty map on any failure (no provider
 * configured, fetch error, etc) so the cascade falls through to
 * the LLM rung as if this pass hadn't run.
 */
async function runEmbeddingRung(
  userId: Types.ObjectId,
  unknownTags: string[],
  candidates: CanonicalCandidate[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (unknownTags.length === 0 || candidates.length === 0) return out;

  // Resolve the embedding provider once. The user may not have one
  // configured (Ollama not running, embedding model not pulled) —
  // in which case we skip the whole rung quietly.
  let provider, model, providerTag;
  try {
    const resolved = await resolveProviderForUser(userId, 'embedding');
    provider = resolved.provider;
    model = resolved.model;
    providerTag = `${provider.id}:${model}`;
  } catch (err) {
    logger.debug(
      { err, userId: String(userId) },
      'tag-canon: embedding provider unavailable; skipping embedding rung',
    );
    return out;
  }

  const top = candidates.slice(0, EMBED_CANDIDATE_CAP);
  // Pull the persisted embeddings (when cached). The `embedding`
  // field is `select: false` so explicitly opt in.
  const rows = (await TagCanonical.find({
    canonical: { $in: top.map((c) => c.canonical) },
  })
    .select('+embedding canonical embeddingModel')
    .lean()) as Array<{
    canonical: string;
    embedding?: number[] | null;
    embeddingModel?: string | null;
  }>;
  const cached = new Map(rows.map((r) => [r.canonical, r]));

  type Scored = { canonical: string; vec: number[] };
  const scoredCanonicals: Scored[] = [];
  for (const c of top) {
    const row = cached.get(c.canonical);
    // Cache hit when both the vector exists AND it was minted
    // with the SAME embedding model — a mismatch (e.g. user
    // switched provider) makes the cached vector unusable, so
    // we recompute.
    if (
      row?.embedding &&
      row.embedding.length > 0 &&
      row.embeddingModel === providerTag
    ) {
      scoredCanonicals.push({ canonical: c.canonical, vec: row.embedding });
      continue;
    }
    // Cache miss — embed the canonical (incl. displayName + a
    // handful of aliases to thicken the signal) and persist.
    const text = [
      c.displayName || titleCaseTag(c.canonical),
      ...((c.aliases ?? []).slice(0, 4)),
    ]
      .filter(Boolean)
      .join(' ')
      .trim();
    try {
      const vec = await provider.embed(model, text);
      scoredCanonicals.push({ canonical: c.canonical, vec });
      await TagCanonical.updateOne(
        { canonical: c.canonical },
        { $set: { embedding: vec, embeddingModel: providerTag } },
      ).catch(() => null);
    } catch (err) {
      logger.debug(
        { err, canonical: c.canonical },
        'tag-canon: failed to embed canonical (continuing)',
      );
    }
  }
  if (scoredCanonicals.length === 0) return out;

  for (const tag of unknownTags) {
    let tagVec: number[];
    try {
      tagVec = await provider.embed(model, titleCaseTag(tag));
    } catch (err) {
      logger.debug({ err, tag }, 'tag-canon: failed to embed unknown tag');
      continue;
    }
    let best: { canonical: string; score: number } | null = null;
    for (const c of scoredCanonicals) {
      const score = cosine(tagVec, c.vec);
      if (score >= EMBED_SIM_THRESHOLD && (!best || score > best.score)) {
        best = { canonical: c.canonical, score };
      }
    }
    if (best) {
      logger.info(
        { tag, canonical: best.canonical, score: Number(best.score.toFixed(3)) },
        'tag-canon: embedding rung folded',
      );
      out.set(tag, best.canonical);
    }
  }
  return out;
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
  // Tags are global. setOnInsert for the displayName so the first
  // canonicalisation wins the canonical name; later users with the
  // same emitted tag don't clobber. Aliases use $addToSet so every
  // user's discovery survives.
  await TagCanonical.updateOne(
    { canonical },
    {
      $setOnInsert: {
        canonical,
        displayName: displayName || titleCaseTag(canonical),
        firstSeenBy: userId,
      },
      ...(alias !== canonical ? { $addToSet: { aliases: alias } } : {}),
    },
    { upsert: true },
  );
}
