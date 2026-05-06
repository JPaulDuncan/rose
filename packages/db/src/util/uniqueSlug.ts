import { Types } from 'mongoose';
import { Page } from '../models/Page.js';

/**
 * Resolve a slug collision loop for a user-scoped Page slug. Caller
 * supplies the pre-slugified base; the helper appends `-2`, `-3`, …
 * until the slug doesn't collide (or until the conflicting page is
 * the one we're updating in place).
 *
 * Plan 13 (D3) folded the api's `apps/api/src/services/wiki.ts:6`
 * `uniqueSlug`, the worker's `apps/worker/src/processors/briefing.ts`
 * `uniqueSlugForUser`, and the inline `while (await Page.findOne…)`
 * loop in `apps/worker/src/processors/generatePage.ts` into this
 * single export.
 */
export async function uniqueSlug(
  userId: Types.ObjectId,
  base: string,
  opts?: { excludePageId?: Types.ObjectId },
): Promise<string> {
  if (!base) throw new Error('uniqueSlug: empty base');
  let slug = base;
  let n = 1;
  while (true) {
    const conflict = await Page.findOne({ userId, slug });
    if (
      !conflict ||
      (opts?.excludePageId && conflict._id.equals(opts.excludePageId))
    ) {
      return slug;
    }
    n += 1;
    slug = `${base}-${n}`;
  }
}
