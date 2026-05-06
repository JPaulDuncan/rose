import { Page } from '@rose/db';
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
