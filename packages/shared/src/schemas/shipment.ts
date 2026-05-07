import { z } from 'zod';

/**
 * Shipment-tracking schemas. Rose detects tracking numbers in
 * incoming emails (carrier-specific regexes), upserts a `Shipment`
 * row, and lets the user refresh status either by inferring from
 * subsequent emails or by querying the carrier directly.
 */

export const Carrier = z.enum(['ups', 'fedex', 'usps', 'dhl', 'unknown']);
export type Carrier = z.infer<typeof Carrier>;

export const ShipmentStatus = z.enum([
  'detected',
  'in_transit',
  'out_for_delivery',
  'delivered',
  'exception',
  'returned',
  'unknown',
]);
export type ShipmentStatus = z.infer<typeof ShipmentStatus>;

export const TrackingEvent = z.object({
  at: z.string().nullable(),
  status: ShipmentStatus,
  description: z.string(),
  location: z.string().optional().nullable(),
  /** What surfaced this event — `email` or `carrier-api`. */
  source: z.enum(['email', 'carrier-api']).default('email'),
});
export type TrackingEvent = z.infer<typeof TrackingEvent>;

export const Shipment = z.object({
  _id: z.string(),
  userId: z.string(),
  carrier: Carrier,
  trackingNumber: z.string(),
  /** Display label — usually inferred from the first email's subject. */
  label: z.string().nullable(),
  status: ShipmentStatus,
  trackingUrl: z.string(),
  lastEventDescription: z.string().nullable(),
  lastEventAt: z.string().nullable(),
  estimatedDeliveryAt: z.string().nullable(),
  deliveredAt: z.string().nullable(),
  history: z.array(TrackingEvent),
  sourceEmailIds: z.array(z.string()),
  lastCheckedAt: z.string().nullable(),
  lastError: z.string().nullable(),
  pollCount: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Shipment = z.infer<typeof Shipment>;

/** Build the carrier's public tracking URL for a given number. */
export function trackingUrlFor(carrier: Carrier, trackingNumber: string): string {
  const tn = encodeURIComponent(trackingNumber);
  switch (carrier) {
    case 'ups':
      return `https://www.ups.com/track?tracknum=${tn}`;
    case 'fedex':
      return `https://www.fedex.com/fedextrack/?trknbr=${tn}`;
    case 'usps':
      return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${tn}`;
    case 'dhl':
      return `https://www.dhl.com/en/express/tracking.html?AWB=${tn}`;
    default:
      return `https://www.google.com/search?q=${tn}+package+tracking`;
  }
}

/** Carrier-pretty-print. */
export const CarrierLabels: Record<Carrier, string> = {
  ups: 'UPS',
  fedex: 'FedEx',
  usps: 'USPS',
  dhl: 'DHL',
  unknown: 'Unknown',
};

/** Status to short human label, used in the UI grouping. */
export const StatusLabels: Record<ShipmentStatus, string> = {
  detected: 'Detected',
  in_transit: 'In transit',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
  exception: 'Exception',
  returned: 'Returned',
  unknown: 'Unknown',
};
