import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { PromoCode, Email } from '@rose/db';
import { detectPromoCodesForEmail } from '@rose/promo-codes';
import { userIdOf } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';

export const promoCodesRouter: Router = Router();

/**
 * Promo-code list endpoint. The Promotional Codes page sorts by
 * "soonest expiring, still-active" first so urgent codes float to
 * the top — used + archived codes drop out of the default scope.
 *
 * `?expired=1` is a fourth, mutually-exclusive view: codes whose
 * expiration date has passed AND that haven't been used or
 * archived. Used by the Expired tab; codes there are pruned 30
 * days after expiry by the retention sweep.
 */
promoCodesRouter.get('/', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const includeArchived = req.query.archived === '1';
  const includeUsed = req.query.used === '1';
  const expiredOnly = req.query.expired === '1';
  const filter: Record<string, unknown> = { userId };

  if (expiredOnly) {
    // Expired tab — codes whose expiration has passed but the user
    // hasn't acted on. Sort most-recently-expired first; rendered
    // with the existing dim treatment on the card.
    filter.archivedAt = null;
    filter.usedAt = null;
    filter.expiresAt = { $ne: null, $lt: new Date() };
    const codes = await PromoCode.find(filter)
      .sort({ expiresAt: -1 })
      .limit(500)
      .lean();
    res.json({ promoCodes: codes });
    return;
  }

  if (!includeArchived) filter.archivedAt = null;
  if (!includeUsed) filter.usedAt = null;

  const codes = await PromoCode.find(filter)
    .sort({
      // Soonest expiration first (null sorts last on -1 → put nulls
      // explicitly at the bottom by mapping a synthetic field — too
      // fiddly, so do a straight sort by expiresAt asc and rely on
      // Mongo putting nulls first; then re-sort in JS for the right
      // semantics).
      expiresAt: 1,
      createdAt: -1,
    })
    .limit(500)
    .lean();
  // JS-side: nulls (no expiration) move to the bottom; expired entries
  // also drop below still-active ones so the top of the list is what
  // the user can act on right now.
  const now = Date.now();
  const sorted = [...codes].sort((a, b) => {
    const ax = a.expiresAt ? new Date(a.expiresAt).getTime() : Infinity;
    const bx = b.expiresAt ? new Date(b.expiresAt).getTime() : Infinity;
    const aExpired = ax < now;
    const bExpired = bx < now;
    if (aExpired !== bExpired) return aExpired ? 1 : -1;
    return ax - bx;
  });
  res.json({ promoCodes: sorted });
});

const PromoCodeUpdateRequest = z.object({
  used: z.boolean().optional(),
  archived: z.boolean().optional(),
  description: z.string().max(500).optional(),
  discount: z.string().max(80).nullable().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
});

/**
 * Manual edits + state changes. The page surfaces "Mark used",
 * "Archive", "Restore" buttons and an inline edit affordance for the
 * description / discount when the extractor's heuristic guess is
 * off; this endpoint is the one path for all of those.
 */
promoCodesRouter.patch(
  '/:id',
  validateBody(PromoCodeUpdateRequest),
  async (req, res) => {
    const userId = new Types.ObjectId(userIdOf(req));
    if (!Types.ObjectId.isValid(req.params.id ?? '')) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    const code = await PromoCode.findOne({ _id: req.params.id, userId });
    if (!code) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const body = req.body as z.infer<typeof PromoCodeUpdateRequest>;
    if (body.used !== undefined) code.usedAt = body.used ? new Date() : null;
    if (body.archived !== undefined) code.archivedAt = body.archived ? new Date() : null;
    if (body.description !== undefined) code.description = body.description;
    if (body.discount !== undefined) code.discount = body.discount ?? null;
    if (body.expiresAt !== undefined) {
      code.expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
    }
    await code.save();
    res.json({ ok: true, promoCode: code });
  },
);

promoCodesRouter.delete('/:id', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  if (!Types.ObjectId.isValid(req.params.id ?? '')) {
    res.status(400).json({ error: 'invalid_request' });
    return;
  }
  await PromoCode.deleteOne({ _id: req.params.id, userId });
  res.json({ ok: true });
});

/**
 * Backfill scan: walk the user's existing emails and run extraction.
 * Surfaced from the empty state on the page so a fresh install can
 * harvest codes without waiting for new mail.
 */
/**
 * Backfill scan: walk the user's existing emails and run extraction.
 * Surfaced from the empty state on the page so a fresh install can
 * harvest codes without waiting for new mail to arrive.
 */
promoCodesRouter.post('/scan', async (req, res, next) => {
  try {
    const userId = new Types.ObjectId(userIdOf(req));
    // Cap at 2k recent emails by default so a one-click scan doesn't
    // tie up the process for hours on a huge mailbox.
    const limit = Math.min(Number((req.body as { limit?: number })?.limit ?? 2000), 5000);
    const emails = await Email.find({ userId })
      .select('_id')
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    let total = 0;
    for (const e of emails) {
      total += await detectPromoCodesForEmail(String(e._id));
    }
    res.json({ ok: true, scannedEmails: emails.length, codesUpserted: total });
  } catch (err) {
    next(err);
  }
});
