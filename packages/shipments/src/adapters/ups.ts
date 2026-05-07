import type { ShipmentStatus, TrackingEvent } from '@rose/shared';
import type { CarrierAdapter, CarrierTrackResult } from './index.js';

/**
 * UPS tracking via the same JSON endpoint the ups.com website uses.
 * No auth required for the public consumer view, but treat this as
 * best-effort: UPS rotates the schema occasionally and rate-limits
 * by IP, so the adapter throws cleanly on shape mismatches and the
 * caller surfaces it as `lastError`.
 */

const UPS_ENDPOINT = 'https://www.ups.com/track/api/Track/GetStatus?loc=en_US';
const TIMEOUT_MS = 10_000;

type UpsResponse = {
  statusCode?: string;
  trackDetails?: Array<{
    packageStatus?: string;
    packageStatusType?: string;
    progressBarType?: string;
    scheduledDeliveryDate?: string;
    scheduledDeliveryDayCMSKey?: string;
    deliveredDate?: string;
    deliveredDayCMSKey?: string;
    shipmentProgressActivities?: Array<{
      activityScan?: string;
      date?: string;
      time?: string;
      location?: string;
    }>;
  }>;
};

function mapStatus(ups: string | undefined): ShipmentStatus {
  if (!ups) return 'unknown';
  const v = ups.toLowerCase();
  if (v.includes('delivered')) return 'delivered';
  if (v.includes('out for delivery')) return 'out_for_delivery';
  if (v.includes('exception') || v.includes('attempt')) return 'exception';
  if (v.includes('returned')) return 'returned';
  if (v.includes('in transit') || v.includes('on the way') || v.includes('origin scan')) {
    return 'in_transit';
  }
  return 'unknown';
}

function parseUpsDateTime(date: string | undefined, time: string | undefined): Date | null {
  if (!date) return null;
  // UPS returns dates like "20260507" and times like "14:32".
  const m = date.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${time ?? '00:00'}:00`;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t) : null;
}

export const upsAdapter: CarrierAdapter = {
  carrier: 'ups',
  available: () => true,
  async track(trackingNumber, signal): Promise<CarrierTrackResult> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    if (signal) signal.addEventListener('abort', () => ctrl.abort(), { once: true });
    try {
      const res = await fetch(UPS_ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': 'Rose-Shipments/1.0',
        },
        body: JSON.stringify({
          Locale: 'en_US',
          TrackingNumber: [trackingNumber],
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        throw new Error(`UPS returned ${res.status}`);
      }
      const data = (await res.json()) as UpsResponse;
      const detail = data.trackDetails?.[0];
      if (!detail) {
        throw new Error('UPS returned no tracking details');
      }
      const status = mapStatus(detail.packageStatus ?? detail.packageStatusType);
      const history: TrackingEvent[] = (detail.shipmentProgressActivities ?? []).map(
        (act) => ({
          at: parseUpsDateTime(act.date, act.time)?.toISOString() ?? null,
          status: mapStatus(act.activityScan),
          description: act.activityScan ?? '',
          location: act.location ?? null,
          source: 'carrier-api',
        }),
      );
      const lastActivity = detail.shipmentProgressActivities?.[0];
      const lastEventAt = lastActivity
        ? parseUpsDateTime(lastActivity.date, lastActivity.time)
        : null;
      const eta = parseUpsDateTime(detail.scheduledDeliveryDate, undefined);
      const delivered = parseUpsDateTime(detail.deliveredDate, undefined);
      return {
        status,
        lastEventDescription: detail.packageStatus ?? lastActivity?.activityScan ?? null,
        lastEventAt,
        estimatedDeliveryAt: eta,
        deliveredAt: delivered ?? (status === 'delivered' ? lastEventAt : null),
        history,
      };
    } finally {
      clearTimeout(timer);
    }
  },
};
