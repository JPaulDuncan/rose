import { Page, DaydreamNote } from '@rose/db';
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
