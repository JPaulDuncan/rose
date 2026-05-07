import type { CarrierAdapter, CarrierTrackResult } from './index.js';

/**
 * DHL adapter. The DHL "Shipment Tracking - Unified" API (OAuth +
 * API key from developer.dhl.com) is the supported route. Unavailable
 * until DHL_API_KEY is set; falls back to email-derived status
 * everywhere else.
 */
export const dhlAdapter: CarrierAdapter = {
  carrier: 'dhl',
  available: () => Boolean(process.env.DHL_API_KEY),
  async track(_trackingNumber): Promise<CarrierTrackResult> {
    if (!process.env.DHL_API_KEY) {
      throw new Error('DHL API not configured (set DHL_API_KEY).');
    }
    throw new Error('DHL live polling not yet implemented; using email-derived status.');
  },
};
