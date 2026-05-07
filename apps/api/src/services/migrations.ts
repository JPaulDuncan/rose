import { Page, DaydreamNote, Sender, SenderBrand, User } from '@rose/db';
import { Types } from 'mongoose';
import { logger } from '../lib/logger.js';

/**
 * Plan 12 (R2) — fold any non-null `Page.threadKey` (legacy singular
 * field) into `Page.threadKeys[]` (current array form), then clear
 * the legacy field.
 *
 * Runs at API boot, idempotent: when no rows match the filter,
 * `updateMany` is a no-op. The two operations are separate so
 * `$addToSet` can reference the legacy field's value before
 * `$unset` clears it.
 *
 * Why this matters: the assignment ladder still has a defensive
 * `$or: [{threadKeys: x}, {threadKey: x}]` lookup. Once every page
 * has migrated, that legacy branch can go away. We don't drop it
 * here because we can't know whether all installations have
 * finished the migration — the next dedicated cleanup commit can.
 */
export async function migrateLegacyThreadKey(): Promise<void> {
  const filter = { threadKey: { $type: 'string', $ne: null } };
  const beforeCount = await Page.countDocuments(filter);
  if (beforeCount === 0) return;

  // Two-step:
  // 1. Add the legacy threadKey value into threadKeys[] (idempotent
  //    — `$addToSet` is a no-op if it's already there).
  // 2. Clear the legacy threadKey field on those rows.
  // Doing this with two updateMany calls means we don't need
  // aggregation pipeline updates and the migration is portable
  // across older Mongo versions.
  const r1 = await Page.updateMany(filter, [
    {
      $set: {
        threadKeys: {
          $setUnion: [{ $ifNull: ['$threadKeys', []] }, ['$threadKey']],
        },
      },
    },
  ]);
  const r2 = await Page.updateMany(filter, { $set: { threadKey: null } });

  logger.info(
    {
      candidates: beforeCount,
      union: r1.modifiedCount ?? 0,
      cleared: r2.modifiedCount ?? 0,
    },
    'threadKey migration completed',
  );
}

/**
 * Plan 14 — DaydreamNote went from `(userId, kind, subjectKey)`-keyed
 * to `(kind, subjectKey)`-keyed. Multiple users may have researched
 * the same subject before this commit, leaving N duplicate rows that
 * the new unique index would reject.
 *
 * For each `(kind, subjectKey)` group we:
 *   1. Pick the canonical row — preferring non-failed > newer
 *      `generatedAt` > newer `_id`.
 *   2. Move that row's `userId` (legacy field) onto the new
 *      `firstResearchedBy` slot.
 *   3. Delete the rest. The information they held was (by design)
 *      a duplicate of the surviving row's encyclopedic content.
 *
 * Idempotent — re-runs after a clean migration find no candidates
 * because every group is size 1.
 */
export async function migrateDaydreamNotesToGlobal(): Promise<void> {
  // Fast path: if any duplicate (kind, subjectKey) pairs exist, the
  // unique index can't be created, so we always need to run the
  // collapse-step before the new index is built. Mongoose builds the
  // index on first model use, so this has to happen pre-traffic.
  type Row = {
    _id: Types.ObjectId;
    userId?: Types.ObjectId;
    firstResearchedBy?: Types.ObjectId;
    kind: string;
    subjectKey: string;
    generatedAt: Date | null;
    failed: boolean;
  };
  // The model has been re-cast to the new schema, but Mongoose still
  // returns whatever fields the document carries. Use a raw cursor.
  const all = (await DaydreamNote.find({})
    .select('_id userId firstResearchedBy kind subjectKey generatedAt failed')
    .lean()) as unknown as Row[];
  if (all.length === 0) return;

  type GroupKey = string;
  const groups = new Map<GroupKey, Row[]>();
  for (const r of all) {
    const k = `${r.kind}__${r.subjectKey}`;
    const arr = groups.get(k);
    if (arr) arr.push(r);
    else groups.set(k, [r]);
  }

  let dupGroups = 0;
  let deleted = 0;
  let stamped = 0;

  for (const rows of groups.values()) {
    if (rows.length === 1) {
      // Single row — just stamp `firstResearchedBy` from legacy
      // `userId` if it isn't set yet.
      const only = rows[0]!;
      if (!only.firstResearchedBy && only.userId) {
        await DaydreamNote.updateOne(
          { _id: only._id },
          { $set: { firstResearchedBy: only.userId }, $unset: { userId: '' } },
        );
        stamped += 1;
      } else if (only.userId && only.firstResearchedBy) {
        // Legacy field still hanging around alongside the new one.
        await DaydreamNote.updateOne(
          { _id: only._id },
          { $unset: { userId: '' } },
        );
      }
      continue;
    }
    dupGroups += 1;
    // Pick canonical: prefer non-failed; tiebreak on most recent
    // generatedAt; final tiebreak on most recent _id.
    rows.sort((a, b) => {
      if (a.failed !== b.failed) return a.failed ? 1 : -1;
      const ga = a.generatedAt ? new Date(a.generatedAt).getTime() : 0;
      const gb = b.generatedAt ? new Date(b.generatedAt).getTime() : 0;
      if (gb !== ga) return gb - ga;
      return b._id.toString().localeCompare(a._id.toString());
    });
    const keep = rows[0]!;
    const drop = rows.slice(1);

    await DaydreamNote.updateOne(
      { _id: keep._id },
      {
        $set: {
          firstResearchedBy: keep.firstResearchedBy ?? keep.userId ?? null,
        },
        $unset: { userId: '' },
      },
    );
    if (drop.length > 0) {
      const r = await DaydreamNote.deleteMany({
        _id: { $in: drop.map((d) => d._id) },
      });
      deleted += r.deletedCount ?? 0;
    }
    stamped += 1;
  }

  logger.info(
    {
      groups: groups.size,
      duplicateGroups: dupGroups,
      stamped,
      deleted,
    },
    'daydream-note global migration completed',
  );
}

/**
 * Plan 14 — backfill the new global `SenderBrand` collection from
 * existing per-user `Sender` rows. Idempotent: for each unique
 * `brandKey`, picks the per-user row with the most evidence (longest
 * addresses[] / websites[]; highest logoConfidence; latest summary
 * timestamp) and upserts a single SenderBrand row with the union.
 *
 * After this runs, the worker's senderUpsert / summarizeSender start
 * writing brand-global fields to SenderBrand. Existing Sender rows
 * keep their now-stale brand-global field copies as fallback for
 * any read path that hasn't migrated to the merged shape yet.
 */
export async function migrateSenderBrandsToGlobal(): Promise<void> {
  type SenderRow = {
    _id: Types.ObjectId;
    userId: Types.ObjectId;
    brandKey: string;
    domain: string | null;
    name: string;
    addresses: string[];
    websites: string[];
    logoUrl: string | null;
    logoConfidence: number;
    logoLocked: boolean;
    unsubscribeUrls: string[];
    postalAddresses: string[];
    summary: string;
    summaryGeneratedAt: Date | null;
    summaryLocked: boolean;
    firstSeenAt: Date | null;
  };
  // Plan 15 — read brand-global fields from legacy per-user rows.
  // Even though the schema no longer declares these, MongoDB still
  // carries the values; we use a raw cursor to read them.
  const all = (await Sender.find({})
    .select(
      '_id userId brandKey domain name addresses websites logoUrl logoConfidence logoLocked unsubscribeUrls postalAddresses summary summaryGeneratedAt summaryLocked firstSeenAt',
    )
    .lean()) as unknown as SenderRow[];
  if (all.length === 0) return;

  const groups = new Map<string, SenderRow[]>();
  for (const r of all) {
    const arr = groups.get(r.brandKey);
    if (arr) arr.push(r);
    else groups.set(r.brandKey, [r]);
  }

  let upserted = 0;
  for (const [brandKey, rows] of groups) {
    // Plan 15 — prefer rows where the user pinned their own summary
    // (`summaryLocked: true`); their hand-curated brief is the most
    // valuable signal. After that, freshest summary, highest
    // logoConfidence, longest addresses, lowest userId for
    // determinism on retries.
    rows.sort((a, b) => {
      if (!!a.summaryLocked !== !!b.summaryLocked)
        return a.summaryLocked ? -1 : 1;
      const sa = a.summaryGeneratedAt
        ? new Date(a.summaryGeneratedAt).getTime()
        : 0;
      const sb = b.summaryGeneratedAt
        ? new Date(b.summaryGeneratedAt).getTime()
        : 0;
      if (sa !== sb) return sb - sa;
      if (a.logoConfidence !== b.logoConfidence)
        return (b.logoConfidence ?? 0) - (a.logoConfidence ?? 0);
      const la = (a.addresses ?? []).length;
      const lb = (b.addresses ?? []).length;
      if (la !== lb) return lb - la;
      return String(a.userId).localeCompare(String(b.userId));
    });
    const best = rows[0]!;
    // Union all addresses / websites / unsubscribeUrls /
    // postalAddresses across users so the brand row is the most
    // complete picture available.
    const union = (key: keyof Pick<SenderRow, 'addresses' | 'websites' | 'unsubscribeUrls' | 'postalAddresses'>) => [
      ...new Set(
        rows.flatMap((r) =>
          ((r[key] as string[] | undefined) ?? []).filter(Boolean),
        ),
      ),
    ];
    // The first user to surface the brand becomes the audit anchor —
    // pick the row with the earliest firstSeenAt, falling back to
    // the user with the lowest id.
    const firstSeen = [...rows].sort((a, b) => {
      const ta = a.firstSeenAt ? new Date(a.firstSeenAt).getTime() : Number.POSITIVE_INFINITY;
      const tb = b.firstSeenAt ? new Date(b.firstSeenAt).getTime() : Number.POSITIVE_INFINITY;
      return ta - tb;
    })[0]!;
    await SenderBrand.updateOne(
      { brandKey },
      {
        $setOnInsert: {
          brandKey,
          firstSeenBy: firstSeen.userId,
        },
        $set: {
          domain: best.domain,
          name: best.name || brandKey,
          addresses: union('addresses'),
          websites: union('websites'),
          logoUrl: best.logoUrl,
          logoConfidence: best.logoConfidence ?? 0,
          unsubscribeUrls: union('unsubscribeUrls').slice(0, 4),
          postalAddresses: union('postalAddresses'),
          summary: best.summary ?? '',
          summaryGeneratedAt: best.summaryGeneratedAt ?? null,
        },
      },
      { upsert: true },
    );
    upserted += 1;
  }
  logger.info(
    {
      brandKeys: groups.size,
      perUserRowsRead: all.length,
      upserted,
    },
    'sender-brand global migration completed',
  );
}

/**
 * Plan 15 — strip the now-redundant brand-global fields from per-
 * user `Sender` rows once `SenderBrand` is the source of truth.
 * Preserves the user's intent:
 *   • `logoLocked: true` rows have their `logoUrl` copied to
 *     `logoUrlOverride` so the user keeps seeing their pinned logo.
 *   • Any `name` that differs from the brand-global default ends
 *     up on `nameOverride` so user-customized display names
 *     ("Dad" instead of "john.smith.42@gmail.com") survive.
 *   • Hand-curated summaries (summaryLocked rows) were already
 *     promoted onto SenderBrand by `migrateSenderBrandsToGlobal`'s
 *     prefer-locked sort — they belong to the brand now.
 *
 * Then `$unset` the dropped fields. Idempotent: if the fields are
 * already gone, the updateMany has zero candidates and returns
 * fast. Re-runs after a clean migration are safe.
 *
 * Runs after `migrateSenderBrandsToGlobal` so the brand row has the
 * canonical values before the per-user rows lose theirs.
 */
export async function migrateSenderStripBrandFields(): Promise<void> {
  type LegacyRow = {
    _id: Types.ObjectId;
    brandKey: string;
    name?: string;
    logoUrl?: string | null;
    logoLocked?: boolean;
  };
  // Find rows that still carry any of the legacy brand-global
  // fields. If none, the migration is already done.
  const candidates = (await Sender.find({
    $or: [
      { name: { $exists: true } },
      { logoUrl: { $exists: true } },
      { summary: { $exists: true } },
    ],
  })
    .select('_id brandKey name logoUrl logoLocked')
    .lean()) as unknown as LegacyRow[];
  if (candidates.length === 0) return;

  // Pull each row's brand for a name-equality compare.
  const brandKeys = [...new Set(candidates.map((r) => r.brandKey))];
  const brands = await SenderBrand.find({ brandKey: { $in: brandKeys } })
    .select('brandKey name')
    .lean();
  const brandName = new Map(brands.map((b) => [b.brandKey, b.name ?? '']));

  let nameOverridesSet = 0;
  let logoOverridesSet = 0;
  for (const r of candidates) {
    const update: Record<string, unknown> = {};
    // Name override: only when the user's value differs from both
    // the brand-global value and the bare brandKey default.
    if (r.name && r.name !== brandName.get(r.brandKey) && r.name !== r.brandKey) {
      update.nameOverride = r.name.slice(0, 80);
      nameOverridesSet += 1;
    }
    // Logo override: only when the user explicitly locked theirs.
    if (r.logoLocked && r.logoUrl) {
      update.logoUrlOverride = r.logoUrl;
      logoOverridesSet += 1;
    }
    await Sender.updateOne(
      { _id: r._id },
      {
        $set: update,
        $unset: {
          name: '',
          domain: '',
          addresses: '',
          websites: '',
          logoUrl: '',
          logoConfidence: '',
          logoLocked: '',
          summary: '',
          summaryGeneratedAt: '',
          summaryLocked: '',
          unsubscribeUrls: '',
          postalAddresses: '',
        },
      },
    );
  }
  logger.info(
    {
      stripped: candidates.length,
      nameOverridesSet,
      logoOverridesSet,
    },
    'sender brand-global field strip completed',
  );
}

/**
 * Earlier admin-reset / dataIo-import paths set `User.weatherLocation`
 * to literal `null`. The schema declares it as a sub-document, so the
 * weather PUT (which used dotted-path `$set` like
 * `weatherLocation.label`) crashes with "Cannot create field 'label'
 * in element {weatherLocation: null}". Fix forward + back: the route
 * code now writes the whole sub-document, and this migration unsticks
 * any existing rows by removing the literal-null field. Idempotent.
 */
export async function migrateWeatherLocationNulls(): Promise<void> {
  const r = await User.updateMany(
    { weatherLocation: null },
    { $unset: { weatherLocation: 1 } },
  );
  if ((r.modifiedCount ?? 0) > 0) {
    logger.info(
      { fixed: r.modifiedCount },
      'cleared literal-null User.weatherLocation rows',
    );
  }
}

/**
 * Multi-location weather: collapse the legacy singular `weatherLocation`
 * subdocument into the new `weatherLocations[]` array. Each migrated
 * user lands with one entry flagged `primary: true`. Idempotent —
 * runs on raw documents (bypassing the schema) so we can read the
 * legacy field even though it's no longer in the model.
 */
export async function migrateWeatherLocationToArray(): Promise<void> {
  const collection = User.collection;
  // Only candidates that have the legacy field AND no array yet.
  const cursor = collection.find(
    {
      weatherLocation: { $exists: true, $ne: null },
      $or: [
        { weatherLocations: { $exists: false } },
        { weatherLocations: { $size: 0 } },
      ],
    },
    { projection: { _id: 1, weatherLocation: 1 } },
  );
  let migrated = 0;
  for await (const doc of cursor) {
    const wl = doc.weatherLocation as
      | { lat?: number | null; lon?: number | null; label?: string | null; setAt?: Date | null }
      | null;
    if (
      !wl ||
      typeof wl.lat !== 'number' ||
      typeof wl.lon !== 'number' ||
      !wl.label
    ) {
      // Empty / partial — drop the legacy field on the way out so the
      // candidate doesn't get re-considered next boot.
      await collection.updateOne({ _id: doc._id }, { $unset: { weatherLocation: '' } });
      continue;
    }
    await collection.updateOne(
      { _id: doc._id },
      {
        $set: {
          weatherLocations: [
            {
              _id: new (await import('mongoose')).Types.ObjectId(),
              lat: wl.lat,
              lon: wl.lon,
              label: wl.label,
              primary: true,
              setAt: wl.setAt ?? new Date(),
            },
          ],
        },
        $unset: { weatherLocation: '' },
      },
    );
    migrated += 1;
  }
  if (migrated > 0) {
    logger.info({ migrated }, 'migrated legacy weatherLocation → weatherLocations[]');
  }
}

