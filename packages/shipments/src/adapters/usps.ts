import type { CarrierAdapter, CarrierTrackResult } from './index.js';

/**
 * USPS adapter. The legacy SecureWebTools "Track/Confirm" XML API
 * (USERID-based, no OAuth) is the realistic option for self-hosters,
 * but it requires a per-deployment registration. This adapter ships
 * unavailable until USPS_USERID is set in the env so the UI can show
 * "Refresh requires USPS API credentials" rather than fail
 * mysteriously.
 */
export const uspsAdapter: CarrierAdapter = {
  carrier: 'usps',
  available: () => Boolean(process.env.USPS_USERID),
  async track(_trackingNumber): Promise<CarrierTrackResult> {
    if (!process.env.USPS_USERID) {
      throw new Error('USPS API not configured (set USPS_USERID).');
    }
    throw new Error('USPS live polling not yet implemented; using email-derived status.');
  },
};
