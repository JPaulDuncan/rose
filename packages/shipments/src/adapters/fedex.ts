import type { CarrierAdapter, CarrierTrackResult } from './index.js';

/**
 * FedEx adapter. The supported path is the FedEx Track API v1 (OAuth
 * client-credentials), which requires a developer account. This
 * adapter reports unavailable until FEDEX_CLIENT_ID and
 * FEDEX_CLIENT_SECRET are set in the worker env. Until then the
 * email-keyword inference is what powers the FedEx column on the
 * Shipments page.
 */
export const fedexAdapter: CarrierAdapter = {
  carrier: 'fedex',
  available: () =>
    Boolean(process.env.FEDEX_CLIENT_ID && process.env.FEDEX_CLIENT_SECRET),
  async track(_trackingNumber): Promise<CarrierTrackResult> {
    if (!process.env.FEDEX_CLIENT_ID || !process.env.FEDEX_CLIENT_SECRET) {
      throw new Error('FedEx API not configured (set FEDEX_CLIENT_ID / FEDEX_CLIENT_SECRET).');
    }
    throw new Error('FedEx live polling not yet implemented; using email-derived status.');
  },
};
