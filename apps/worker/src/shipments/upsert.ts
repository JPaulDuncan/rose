import { Types } from 'mongoose';
import { Email, Shipment } from '@rose/db';
import { trackingUrlFor, type Carrier } from '@rose/shared';
import { matchShipments, inferStatusFromEmail } from '@rose/shipments';
import { logger } from '../lib/logger.js';

/**
 * Scan a single email row for tracking numbers and upsert any
 * matching shipments. Idempotent — running it twice on the same
 * email won't double-record events because the per-email status
 * inference always lives at the same `(carrier, tracking)` row.
 *
 * Status precedence on update:
 * - 'delivered' / 'returned' are sticky; once set we never regress.
 * - 'out_for_delivery' / 'exception' overwrite older 'in_transit'.
 * - Lower-confidence states never overwrite a more advanced one.
 */
const STATUS_RANK: Record<string, number> = {
  detected: 0,
  unknown: 1,
  in_transit: 2,
  out_for_delivery: 3,
  exception: 4,
  returned: 5,
  delivered: 6,
};

export async function detectShipmentsForEmail(emailId: string): Promise<number> {
  const email = await Email.findById(emailId)
    .select('userId subject text from createdAt')
    .lean();
  if (!email) return 0;
  const userId = email.userId as unknown as Types.ObjectId;
  const haystack = email.text ?? '';
  const subject = email.subject ?? '';
  const matches = matchShipments(haystack, subject);
  if (matches.length === 0) return 0;

  const inferred = inferStatusFromEmail(haystack, subject);
  const eventDate = (email as { createdAt?: Date }).createdAt ?? new Date();
  let count = 0;

  for (const match of matches) {
    const carrier = match.carrier as Carrier;
    const trackingUrl = trackingUrlFor(carrier, match.trackingNumber);

    // Look up first to compare status ranks; we only "advance" the
    // status, never regress it. If no shipment exists yet, create one.
    const existing = await Shipment.findOne({
      userId,
      carrier,
      trackingNumber: match.trackingNumber,
    });

    if (!existing) {
      try {
        await Shipment.create({
          userId,
          carrier,
          trackingNumber: match.trackingNumber,
          label: subject || null,
          status: inferred.status,
          trackingUrl,
          lastEventDescription: inferred.description,
          lastEventAt: eventDate,
          deliveredAt: inferred.status === 'delivered' ? eventDate : null,
          history: [
            {
              at: eventDate,
              status: inferred.status,
              description: inferred.description,
              source: 'email',
            },
          ],
          sourceEmailIds: [email._id],
        });
        count += 1;
      } catch (err) {
        // Race on the unique index — fall through to update path.
        logger.debug({ err, trackingNumber: match.trackingNumber }, 'shipment upsert race');
      }
      continue;
    }

    const newRank = STATUS_RANK[inferred.status] ?? 0;
    const oldRank = STATUS_RANK[existing.status] ?? 0;
    const update: Record<string, unknown> = {};
    if (newRank > oldRank) {
      update.status = inferred.status;
      update.lastEventDescription = inferred.description;
      update.lastEventAt = eventDate;
      if (inferred.status === 'delivered' && !existing.deliveredAt) {
        update.deliveredAt = eventDate;
      }
    }
    await Shipment.updateOne(
      { _id: existing._id, userId },
      {
        ...(Object.keys(update).length > 0 ? { $set: update } : {}),
        $addToSet: { sourceEmailIds: email._id },
        $push: {
          history: {
            at: eventDate,
            status: inferred.status,
            description: inferred.description,
            source: 'email',
          },
        },
      },
    );
    count += 1;
  }
  return count;
}
