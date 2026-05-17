import { Types } from 'mongoose';
import {
  Category,
  DESK_SEED_DEFAULTS,
  UNCATEGORIZED_NAME,
  displayCategoryName,
  normalizeCategoryName,
  type CategoryDoc,
} from '@rose/db';
import { logger } from '../lib/logger.js';

/**
 * Seed the user's newspaper-desk vocabulary. Idempotent — checks
 * for an existing `kind: 'desk'` row before inserting anything, and
 * any individual seed that matches an existing (kind, name) doesn't
 * get duplicated.
 *
 * Called lazily at the top of page generation so legacy users get
 * desks the first time a page generates post-deploy. No background
 * migration; the cost is one indexed `Category.exists` per page
 * generation when desks already exist, which is cheap.
 */
export async function ensureDeskSeedsForUser(userId: Types.ObjectId): Promise<void> {
  const exists = await Category.exists({ userId, kind: 'desk' });
  if (exists) return;
  for (const seed of DESK_SEED_DEFAULTS) {
    const name = displayCategoryName(seed.name);
    const normalizedName = normalizeCategoryName(name);
    try {
      await Category.findOneAndUpdate(
        { userId, normalizedName },
        {
          $setOnInsert: {
            userId,
            name,
            normalizedName,
            kind: 'desk',
            description: seed.description,
            icon: seed.icon,
            seedDefault: true,
            status: 'active',
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
    } catch (err) {
      logger.warn(
        { err, userId: String(userId), name },
        'desks: seed insert failed (continuing)',
      );
    }
  }
  logger.info(
    { userId: String(userId), count: DESK_SEED_DEFAULTS.length },
    'desks: seeded defaults',
  );
}

/**
 * Build the vocabulary block fed to the generator prompt. When the
 * user has active desks, we render a STRICT enumerated list with
 * per-desk descriptions and an explicit "pick exactly one or null"
 * instruction. This override is read AFTER the template's static
 * "prefer existing, invent new" rules — the model honours the more
 * specific instruction.
 *
 * When no desks exist (cold-start before seeds run), we fall back
 * to the legacy free-form rendering (ad-hoc rows by name + count)
 * so behaviour is backwards-compatible.
 */
export async function buildCategoryVocabulary(
  userId: Types.ObjectId,
  pageCountsById: ReadonlyMap<string, number>,
): Promise<{
  block: string;
  desks: { id: Types.ObjectId; name: string; description: string }[];
  isStrictDeskMode: boolean;
}> {
  const desks = (await Category.find({
    userId,
    kind: 'desk',
    status: 'active',
  })
    .sort({ seedDefault: -1, name: 1 })
    .lean()) as CategoryDoc[];

  if (desks.length > 0) {
    const lines = desks.map(
      (d) =>
        `  - ${d.name} (${pageCountsById.get(String(d._id)) ?? 0} pages) — ${d.description || 'no description'}`,
    );
    const block = [
      'DESK VOCABULARY — closed set. Pick EXACTLY ONE name from the list below verbatim,',
      'or return null. DO NOT INVENT a new desk; the user curates the desk list separately.',
      'When a page genuinely fits NO desk, return null — it lands in Uncategorized.',
      '',
      ...lines,
    ].join('\n');
    return {
      block,
      desks: desks.map((d) => ({
        id: d._id as Types.ObjectId,
        name: d.name,
        description: d.description ?? '',
      })),
      isStrictDeskMode: true,
    };
  }

  // Cold-start: render ad-hoc categories the legacy way so behaviour
  // is backwards-compatible. The seeder hasn't run yet for this
  // user (typically because they had no Category rows at all).
  const adHoc = (await Category.find({ userId })
    .select('name')
    .lean()) as CategoryDoc[];
  const block = adHoc.length
    ? adHoc
        .map((c) => `${c.name}\t${pageCountsById.get(String(c._id)) ?? 0}`)
        .join('\n')
    : '(none yet — pick null or invent a specific category)';
  return { block, desks: [], isStrictDeskMode: false };
}

/**
 * Snap an LLM-emitted category name to the closest matching active
 * desk. Returns the desk's id when:
 *   • exact match (case-insensitive, post-normalisation)
 *   • a desk name is a prefix of the emitted text (handles
 *     "Sports / NBA" → "Sports")
 *   • Levenshtein distance ≤ 2 against any desk name (catches
 *     typos like "Atvertising" → "Advertising")
 *
 * Returns null when nothing matches; caller falls back to
 * Uncategorized (which is itself a seeded desk).
 */
export function snapToDesk(
  emittedName: string | null | undefined,
  desks: ReadonlyArray<{ id: Types.ObjectId; name: string }>,
): Types.ObjectId | null {
  if (!emittedName || desks.length === 0) return null;
  const normalised = normalizeCategoryName(emittedName);
  if (!normalised) return null;
  // 1. Exact normalised match.
  for (const d of desks) {
    if (normalizeCategoryName(d.name) === normalised) return d.id;
  }
  // 2. Desk name is a prefix of the emitted text (after normalise).
  for (const d of desks) {
    const dn = normalizeCategoryName(d.name);
    if (normalised === dn || normalised.startsWith(`${dn} `)) return d.id;
  }
  // 3. Levenshtein ≤ 2 — catches one-character typos.
  let bestDist = Infinity;
  let bestId: Types.ObjectId | null = null;
  for (const d of desks) {
    const dn = normalizeCategoryName(d.name);
    const dist = levenshtein(normalised, dn);
    if (dist < bestDist && dist <= 2) {
      bestDist = dist;
      bestId = d.id;
    }
  }
  return bestId;
}

/**
 * Return the Uncategorized desk's id for this user, seeding it if
 * somehow missing. Used as the terminal fallback when the LLM
 * emits null or an unmatchable name.
 */
export async function getUncategorizedDeskId(
  userId: Types.ObjectId,
): Promise<Types.ObjectId | null> {
  const normalised = normalizeCategoryName(UNCATEGORIZED_NAME);
  const existing = await Category.findOne({ userId, normalizedName: normalised })
    .select('_id')
    .lean();
  if (existing) return existing._id as Types.ObjectId;
  // Edge case: someone (manually) deleted the Uncategorized seed.
  // Re-create it so we always have a fallback bucket.
  const created = await Category.create({
    userId,
    name: UNCATEGORIZED_NAME,
    normalizedName: normalised,
    kind: 'desk',
    description: 'Pages that do not fit any other desk.',
    seedDefault: true,
    status: 'active',
  });
  return created._id as Types.ObjectId;
}

/**
 * Return the Advertising desk's id for this user when it exists.
 * Used by the promotional-page override — `flags.isPromotional`
 * pages get pinned to Advertising regardless of the LLM's
 * suggestion, keeping the two classifications consistent.
 */
export async function getAdvertisingDeskId(
  userId: Types.ObjectId,
): Promise<Types.ObjectId | null> {
  const normalised = normalizeCategoryName('Advertising');
  const existing = await Category.findOne({
    userId,
    normalizedName: normalised,
    kind: 'desk',
    status: 'active',
  })
    .select('_id')
    .lean();
  return existing ? (existing._id as Types.ObjectId) : null;
}

/** Plain-Javascript Levenshtein. ~30 lines, no dependency. Used
 *  only on short category names (≤ 30 chars typically); cost is
 *  trivial. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,
        prev[j]! + 1,
        prev[j - 1]! + cost,
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length] ?? 0;
}
