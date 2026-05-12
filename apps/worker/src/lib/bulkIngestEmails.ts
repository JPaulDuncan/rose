import { Types } from 'mongoose';
import type { Queue } from 'bullmq';
import { Email } from '@rose/db';
import { senderDomainTag, type CleanedEmail } from '@rose/email-parser';
import { detectShipmentsForEmail } from '@rose/shipments';
import { detectPromoCodesForEmail } from '@rose/promo-codes';
import { priorityForDate } from '@rose/shared';
import { emitRecipeEvent } from './recipeEmit.js';
import { inc, METRIC } from './metrics.js';
import { logger } from './logger.js';

/**
 * Shared bulk-insert path for the IMAP and Gmail sync workers. Both
 * used to loop `Email.create` once per message — one Mongo round-trip
 * each. On a 2000-message initial backfill that's ~10s of pure
 * network latency before any downstream work starts. `bulkWrite` with
 * `ordered: false` collapses an entire flush window into a single
 * round-trip; the driver continues past dup-key errors (expected,
 * since `(userId, rawHash)` is uniquely indexed and a re-fetch of an
 * already-ingested message E11000's harmlessly).
 *
 * Pre-assigning each pending entry a fresh ObjectId is what makes the
 * post-flush bookkeeping cheap: we don't need to parse the
 * driver-specific `BulkWriteResult.insertedIds` shape, we just query
 * back `_id ∈ assignedIds`. Anything that exists was inserted by
 * *this* flush — a pre-existing duplicate can't share a fresh OID.
 *
 * Downstream side-effects (generate-page enqueue, recipe emit,
 * shipment + promo detection, metric increment) run per *inserted*
 * pending — duplicate-collisions skip the side-effects, preserving
 * the old "create or no-op" semantics exactly.
 */

export type PendingEmail = { assignedId: Types.ObjectId; cleaned: CleanedEmail };

export type FlushCtx = {
  userId: Types.ObjectId;
  sourceId: Types.ObjectId;
  sourceTag: 'imap' | 'gmail';
  generateQueue: Queue;
};

export type FlushResult = { ingested: number; skippedDup: number };

/** Default flush window. 50 keeps each bulk payload comfortably under
 *  Mongo's 16MB op-size cap for any plausible mailbox; large initial
 *  syncs flush ~40x rather than 2000x. */
export const DEFAULT_FLUSH_SIZE = 50;

function buildDoc(assignedId: Types.ObjectId, cleaned: CleanedEmail, ctx: FlushCtx) {
  return {
    _id: assignedId,
    userId: ctx.userId,
    sourceId: ctx.sourceId,
    messageId: cleaned.messageId,
    threadKey: cleaned.threadKey,
    subjectTemplate: cleaned.subjectTemplate,
    rawHash: cleaned.rawHash,
    from: cleaned.from,
    to: cleaned.to,
    cc: cleaned.cc,
    subject: cleaned.subject,
    date: cleaned.date,
    text: cleaned.text,
    rawText: cleaned.rawText,
    html: cleaned.html,
    attachments: cleaned.attachments.map((a) => ({
      filename: a.filename,
      contentType: a.contentType,
      size: a.size,
      contentId: a.contentId,
    })),
    priority: cleaned.metadata.priority,
    topics: cleaned.metadata.topics,
    links: cleaned.metadata.links,
    images: cleaned.metadata.images,
    spamScore: cleaned.metadata.spamScore,
    spamSignals: cleaned.metadata.spamSignals,
    isMassMailing: cleaned.metadata.isMassMailing,
    promotionalScore: cleaned.metadata.promotionalScore,
    isPromotional: cleaned.metadata.isPromotional,
    promotionalSignals: cleaned.metadata.promotionalSignals,
    authResults: cleaned.metadata.authResults,
    logoCandidate: cleaned.metadata.logoCandidate ?? undefined,
    unsubscribeUrls: cleaned.metadata.unsubscribeUrls,
    ingestStatus: 'parsed' as const,
  };
}

export async function flushPendingEmails(
  pending: PendingEmail[],
  ctx: FlushCtx,
): Promise<FlushResult> {
  if (!pending.length) return { ingested: 0, skippedDup: 0 };

  const ops = pending.map((p) => ({
    insertOne: { document: buildDoc(p.assignedId, p.cleaned, ctx) },
  }));
  try {
    await Email.bulkWrite(ops, { ordered: false });
  } catch (err) {
    // ordered:false partial success: every entry in writeErrors must
    // be a known dup-key collision; anything else is a real failure
    // we want to surface so the job retries.
    const writeErrors = (err as { writeErrors?: Array<{ code?: number }> })
      ?.writeErrors;
    const allDup =
      Array.isArray(writeErrors) &&
      writeErrors.length > 0 &&
      writeErrors.every((e) => e?.code === 11000);
    if (!allDup) throw err;
  }

  const insertedRows = await Email.find(
    { userId: ctx.userId, _id: { $in: pending.map((p) => p.assignedId) } },
    { _id: 1 },
  ).lean();
  const inserted = new Set(insertedRows.map((d) => String(d._id)));

  let ingested = 0;
  let skippedDup = 0;
  for (const p of pending) {
    const idStr = String(p.assignedId);
    if (!inserted.has(idStr)) {
      skippedDup += 1;
      continue;
    }
    ingested += 1;
    inc(METRIC.EMAIL_INGESTED, 1, { source: ctx.sourceTag });
    await ctx.generateQueue.add(
      'generate',
      { emailId: idStr, userId: String(ctx.userId) },
      {
        attempts: 3,
        removeOnComplete: 500,
        removeOnFail: 500,
        priority: priorityForDate(p.cleaned.date ?? new Date()),
      },
    );
    const recipeFromAddr = p.cleaned.from?.address ?? null;
    const recipeBrandKey = recipeFromAddr ? senderDomainTag(recipeFromAddr) : null;
    const brandKeyLower = recipeBrandKey ? recipeBrandKey.toLowerCase() : null;
    await emitRecipeEvent({
      kind: 'email.ingested',
      userId: String(ctx.userId),
      emailId: idStr,
      from: recipeFromAddr,
      subject: p.cleaned.subject ?? '',
      brandKey: brandKeyLower,
      priority: p.cleaned.metadata.priority ?? null,
      tags: p.cleaned.metadata.topics ?? [],
    });
    // Pipeline visibility: emit one `attachment.received` per
    // attachment-bearing email so recipes can react without polling
    // Email.find. The detector events (shipment / promo) fire below
    // *only* when their respective detectors found something — this
    // mirrors the user's mental model: "tell me when something
    // happened," not "tell me every time we looked."
    if (p.cleaned.attachments.length > 0) {
      await emitRecipeEvent({
        kind: 'attachment.received',
        userId: String(ctx.userId),
        emailId: idStr,
        from: recipeFromAddr,
        subject: p.cleaned.subject ?? '',
        brandKey: brandKeyLower,
        attachmentCount: p.cleaned.attachments.length,
        contentTypes: p.cleaned.attachments.map((a) => a.contentType).slice(0, 20),
        filenames: p.cleaned.attachments.map((a) => a.filename).slice(0, 20),
        totalBytes: p.cleaned.attachments.reduce((n, a) => n + (a.size || 0), 0),
      });
    }
    try {
      const shipmentCount = await detectShipmentsForEmail(idStr);
      if (shipmentCount > 0) {
        await emitRecipeEvent({
          kind: 'shipment.detected',
          userId: String(ctx.userId),
          emailId: idStr,
          count: shipmentCount,
          from: recipeFromAddr,
          subject: p.cleaned.subject ?? '',
          brandKey: brandKeyLower,
        });
      }
    } catch (err) {
      logger.warn({ err, emailId: idStr }, 'shipment detection failed');
    }
    try {
      const promoCount = await detectPromoCodesForEmail(idStr);
      if (promoCount > 0) {
        await emitRecipeEvent({
          kind: 'promo.detected',
          userId: String(ctx.userId),
          emailId: idStr,
          count: promoCount,
          from: recipeFromAddr,
          subject: p.cleaned.subject ?? '',
          brandKey: brandKeyLower,
        });
      }
    } catch (err) {
      logger.warn({ err, emailId: idStr }, 'promo-code detection failed');
    }
  }
  pending.length = 0;
  return { ingested, skippedDup };
}
