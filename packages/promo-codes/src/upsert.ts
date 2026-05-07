import type { Logger } from 'pino';
import { Types } from 'mongoose';
import { Email, PromoCode, SenderBrand } from '@rose/db';
import { senderDomainTag } from '@rose/email-parser';
import { extractPromoCodes } from './extract.js';

/**
 * Scan a single email for promo codes and upsert any matches into the
 * PromoCode collection. Idempotent — the unique (userId, code, brand)
 * index makes re-runs no-ops, and updates merge in fresh metadata
 * (description, expiration) only when the email is more recent than
 * the row we already have.
 */
export async function detectPromoCodesForEmail(
  emailId: string,
  logger?: Pick<Logger, 'debug'>,
): Promise<number> {
  const email = await Email.findById(emailId)
    .select('userId subject text from createdAt date')
    .lean();
  if (!email) return 0;
  const userId = email.userId as unknown as Types.ObjectId;
  const text = email.text ?? '';
  const subject = email.subject ?? '';
  if (!text && !subject) return 0;

  const eventDate = email.date ?? (email as { createdAt?: Date }).createdAt ?? new Date();
  const codes = extractPromoCodes(text, subject, new Date());
  if (codes.length === 0) return 0;

  const fromAddr = (email.from as { address?: string | null } | null)?.address ?? null;
  const brand = (fromAddr ? senderDomainTag(fromAddr) : null)?.toLowerCase() ?? null;

  let brandLabel: string | null = null;
  if (brand) {
    const brandDoc = await SenderBrand.findOne({ brandKey: brand })
      .select('name')
      .lean();
    brandLabel = (brandDoc?.name as string | undefined) ?? null;
  }

  let count = 0;
  for (const ex of codes) {
    try {
      const filter = brand
        ? { userId, code: ex.code, brand }
        : { userId, code: ex.code, brand: null };
      const existing = await PromoCode.findOne(filter);
      if (!existing) {
        await PromoCode.create({
          ...filter,
          brandLabel,
          description: ex.description,
          discount: ex.discount,
          expiresAt: ex.expiresAt,
          emailId: email._id,
          pageId: null,
        });
        count += 1;
      } else {
        const update: Record<string, unknown> = {};
        const eventTime = eventDate.getTime();
        const existingTime =
          ((existing as { updatedAt?: Date }).updatedAt as Date | undefined)?.getTime() ?? 0;
        if (eventTime >= existingTime) {
          if (ex.description) update.description = ex.description;
          if (ex.discount) update.discount = ex.discount;
          if (ex.expiresAt) update.expiresAt = ex.expiresAt;
          if (brandLabel && !existing.brandLabel) update.brandLabel = brandLabel;
          update.emailId = email._id;
        }
        if (Object.keys(update).length > 0) {
          await PromoCode.updateOne({ _id: existing._id }, { $set: update });
          count += 1;
        }
      }
    } catch (err) {
      logger?.debug({ err, code: ex.code, brand }, 'promo upsert race');
    }
  }
  return count;
}
