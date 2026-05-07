import type { Carrier, ShipmentStatus, TrackingEvent } from '@rose/shared';

/**
 * Carrier adapter contract. Each adapter takes a tracking number and
 * returns a normalized snapshot of the package status. Adapters that
 * can't reach their carrier (no creds, network failure, parser
 * mismatch) throw — the caller turns the throw into a `lastError` on
 * the Shipment row and leaves the prior status alone.
 */
export type CarrierTrackResult = {
  status: ShipmentStatus;
  lastEventDescription: string | null;
  lastEventAt: Date | null;
  estimatedDeliveryAt: Date | null;
  deliveredAt: Date | null;
  history: TrackingEvent[];
};

export interface CarrierAdapter {
  carrier: Carrier;
  /** Whether this adapter can run right now (creds present, etc.). */
  available(): boolean;
  track(trackingNumber: string, signal?: AbortSignal): Promise<CarrierTrackResult>;
}

import { upsAdapter } from './ups.js';
import { fedexAdapter } from './fedex.js';
import { uspsAdapter } from './usps.js';
import { dhlAdapter } from './dhl.js';

const REGISTRY: Record<Exclude<Carrier, 'unknown'>, CarrierAdapter> = {
  ups: upsAdapter,
  fedex: fedexAdapter,
  usps: uspsAdapter,
  dhl: dhlAdapter,
};

export function adapterFor(carrier: Carrier): CarrierAdapter | null {
  if (carrier === 'unknown') return null;
  return REGISTRY[carrier] ?? null;
}

export { upsAdapter } from './ups.js';
export { fedexAdapter } from './fedex.js';
export { uspsAdapter } from './usps.js';
export { dhlAdapter } from './dhl.js';
