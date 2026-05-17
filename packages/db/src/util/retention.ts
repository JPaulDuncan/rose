import { Types } from 'mongoose';
import { User } from '../models/User.js';
import { Email } from '../models/Email.js';
import { Page } from '../models/Page.js';
import { PageRevision } from '../models/PageRevision.js';
import { DaydreamNote } from '../models/DaydreamNote.js';
import { RecipeAudit } from '../models/RecipeAudit.js';
import { Conversation } from '../models/Conversation.js';
import { Message } from '../models/Message.js';
import { TagDigest } from '../models/TagDigest.js';
import { PromoCode } from '../models/PromoCode.js';
/**
 * Per-collection cleanup driven by `User.retention.*`. Lives in @rose/db
 * because both the nightly worker sweep and the on-demand API endpoint
 * need to run the same logic; keeping it next to the models avoids a
 * duplicate copy or a brittle cross-app import.
 *
 * Design choices:
 *
 * - **0 = keep forever**: each retention field treats `0` as the
 *   disable sentinel so a user who doesn't care about pruning stays
 *   un-touched.
 * - **Latest revision is sticky**: when pruning PageRevisions we
 *   always keep the highest version so the page itself remains
 *   reconstructible.
 * - **Body-strip mode**: instead of deleting old emails outright,
 *   `stripOldEmailBodiesDays` nulls out `text` / `html` / `rawText`
 *   on emails that already produced an article. The article keeps
 *   the gist; the row stays so `page.sourceEmailIds` resolves.
 * - **Bulk + index-friendly**: every delete runs as a single
 *   `deleteMany` filtered by `(userId, createdAt < cutoff)` so the
 *   query plan uses existing indexes.
 */

export type CleanupSummary = {
  emails: number;
  pages: number;
  pageRevisions: number;
  daydream: number;
  recipeAudit: number;
  conversations: number;
  tagDigests: number;
  weatherSnapshots: number;
  emailEmbeddings: number;
  emailBodiesStripped: number;
  /** PromoCodes whose expiresAt was >30d in the past — auto-pruned. */
  expiredPromoCodes: number;
};

export function emptyCleanupSummary(): CleanupSummary {
  return {
    emails: 0,
    pages: 0,
    pageRevisions: 0,
    daydream: 0,
    recipeAudit: 0,
    conversations: 0,
    tagDigests: 0,
    weatherSnapshots: 0,
    emailEmbeddings: 0,
    emailBodiesStripped: 0,
    expiredPromoCodes: 0,
  };
}

/**
 * How long an expired promo code lingers in the Expired tab before
 * the retention sweep deletes it. Codes have a fixed shelf life
 * past expiration — most aren't honored after the window anyway,
 * and the Expired tab is a "things to remember to use" cue, not an
 * archive. System policy; not exposed to per-user retention config.
 */
export const EXPIRED_PROMO_CODE_TTL_DAYS = 30;

function cutoffFor(days: number): Date | null {
  if (!days || days <= 0) return null;
  return new Date(Date.now() - days * 24 * 3600 * 1000);
}

export async function applyRetentionForUser(
  userId: Types.ObjectId,
  retention: Record<string, number | undefined>,
): Promise<CleanupSummary> {
  const sum = emptyCleanupSummary();

  const emailCutoff = cutoffFor(retention.emails ?? 0);
  if (emailCutoff) {
    const r = await Email.deleteMany({ userId, createdAt: { $lt: emailCutoff } });
    sum.emails = r.deletedCount ?? 0;
  }

  const stripCutoff = cutoffFor(retention.stripOldEmailBodiesDays ?? 0);
  if (stripCutoff) {
    const r = await Email.updateMany(
      {
        userId,
        createdAt: { $lt: stripCutoff },
        pageId: { $ne: null },
        text: { $ne: '' },
      },
      { $set: { text: '', html: null, rawText: '' } },
    );
    sum.emailBodiesStripped = r.modifiedCount ?? 0;
  }

  const embedCutoff = cutoffFor(retention.emailEmbeddings ?? 0);
  if (embedCutoff) {
    const r = await Email.updateMany(
      {
        userId,
        createdAt: { $lt: embedCutoff },
        embedding: { $ne: null },
      },
      { $set: { embedding: null, embeddingModel: null } },
    );
    sum.emailEmbeddings = r.modifiedCount ?? 0;
  }

  const pageCutoff = cutoffFor(retention.pages ?? 0);
  if (pageCutoff) {
    const stale = await Page.find({
      userId,
      updatedAt: { $lt: pageCutoff },
    })
      .select('_id')
      .lean();
    if (stale.length > 0) {
      const ids = stale.map((p) => p._id);
      await PageRevision.deleteMany({ pageId: { $in: ids } });
      const r = await Page.deleteMany({ _id: { $in: ids }, userId });
      sum.pages = r.deletedCount ?? 0;
    }
  }

  const revCutoff = cutoffFor(retention.pageRevisions ?? 0);
  if (revCutoff) {
    const heads = await PageRevision.aggregate<{
      _id: Types.ObjectId;
      maxVersion: number;
    }>([
      { $match: { createdAt: { $lt: revCutoff } } },
      { $group: { _id: '$pageId', maxVersion: { $max: '$version' } } },
    ]);
    const pageIds = heads.map((h) => h._id);
    if (pageIds.length > 0) {
      const owned = await Page.find({ userId, _id: { $in: pageIds } })
        .select('_id')
        .lean();
      const ownedSet = new Set(owned.map((p) => String(p._id)));
      const headByPage = new Map<string, number>();
      for (const h of heads) headByPage.set(String(h._id), h.maxVersion);

      const ops = [...ownedSet].map((id) => ({
        deleteMany: {
          filter: {
            pageId: new Types.ObjectId(id),
            createdAt: { $lt: revCutoff },
            version: { $ne: headByPage.get(id) ?? -1 },
          },
        },
      }));
      if (ops.length > 0) {
        const r = await PageRevision.bulkWrite(ops, { ordered: false });
        sum.pageRevisions = (r.deletedCount as number | undefined) ?? 0;
      }
    }
  }

  const daydreamCutoff = cutoffFor(retention.daydream ?? 0);
  if (daydreamCutoff) {
    const r = await DaydreamNote.deleteMany({
      userId,
      createdAt: { $lt: daydreamCutoff },
    });
    sum.daydream = r.deletedCount ?? 0;
  }

  const auditCutoff = cutoffFor(retention.recipeAudit ?? 0);
  if (auditCutoff) {
    const r = await RecipeAudit.deleteMany({
      userId,
      createdAt: { $lt: auditCutoff },
    });
    sum.recipeAudit = r.deletedCount ?? 0;
  }

  const convCutoff = cutoffFor(retention.conversations ?? 0);
  if (convCutoff) {
    const stale = await Conversation.find({
      userId,
      updatedAt: { $lt: convCutoff },
    })
      .select('_id')
      .lean();
    if (stale.length > 0) {
      const ids = stale.map((c) => c._id);
      await Message.deleteMany({ conversationId: { $in: ids } });
      const r = await Conversation.deleteMany({ _id: { $in: ids }, userId });
      sum.conversations = r.deletedCount ?? 0;
    }
  }

  const tagCutoff = cutoffFor(retention.tagDigests ?? 0);
  if (tagCutoff) {
    const r = await TagDigest.deleteMany({
      userId,
      createdAt: { $lt: tagCutoff },
    });
    sum.tagDigests = r.deletedCount ?? 0;
  }

  // Plan 17 — weather snapshots are global; the per-user retention
  // knob is a no-op. Snapshot retention is the 365-day TTL on
  // `WeatherSnapshot.fetchedAt`; per-user cleanup would silently
  // delete other users' history at the same coord. Leave the
  // setting in the schema for backwards-compat with old SPA
  // versions; the value just doesn't drive anything anymore.
  void retention.weatherSnapshots;

  // System policy — expired promo codes get a fixed 30-day window
  // past their expiration before they're permanently deleted. The
  // Expired tab in the Promotional Codes page is a "remember to
  // use these soon" cue; once a code is a month past expiration it
  // almost certainly isn't being honored anymore. Not exposed as a
  // user-configurable retention key — there's no useful knob here
  // (shorter = surprise deletion; longer = clutter).
  const expiredPromoCutoff = new Date(
    Date.now() - EXPIRED_PROMO_CODE_TTL_DAYS * 24 * 3600 * 1000,
  );
  const promoResult = await PromoCode.deleteMany({
    userId,
    expiresAt: { $ne: null, $lt: expiredPromoCutoff },
  });
  sum.expiredPromoCodes = promoResult.deletedCount ?? 0;

  return sum;
}

/** Run cleanup for a specific user immediately and persist the
 *  summary back onto the user. Used by both the nightly worker
 *  sweep and the on-demand API endpoint. */
export async function runRetentionCleanup(
  userId: Types.ObjectId,
): Promise<CleanupSummary> {
  const u = await User.findById(userId).select('retention').lean();
  if (!u) throw new Error('User not found');
  const retention = (u.retention ?? {}) as Record<string, number | undefined>;
  const summary = await applyRetentionForUser(userId, retention);
  await User.updateOne(
    { _id: userId },
    {
      $set: {
        'retention.lastCleanupAt': new Date(),
        'retention.lastCleanupSummary': summary,
      },
    },
  );
  return summary;
}
