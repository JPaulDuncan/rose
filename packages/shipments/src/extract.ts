import type { Carrier, ShipmentStatus } from '@rose/shared';

/**
 * Tracking-number detection. The regex set below is intentionally
 * conservative — false positives turn into noisy "Detected" rows in
 * the Shipments page. Each pattern carries a carrier hint; if the
 * email body explicitly names a carrier, that wins over the regex
 * inference (handled in matchShipments below).
 */

type PatternHit = {
  carrier: Carrier;
  pattern: RegExp;
  /** Optional sanity check (carrier-specific Mod-10, etc.). Returning
   *  false drops the candidate. */
  validate?: (raw: string) => boolean;
};

const PATTERNS: PatternHit[] = [
  // UPS — `1Z` + 16 alphanumerics. Distinctive prefix, low false-positive risk.
  { carrier: 'ups', pattern: /\b1Z[0-9A-Z]{16}\b/g },
  // USPS IMpb — 20, 22, 26, 30 digits. Anchor with non-digit boundaries.
  { carrier: 'usps', pattern: /\b9[0-9]{15,29}\b/g },
  // USPS Express Mail — `EA123456789US` style.
  { carrier: 'usps', pattern: /\b[A-Z]{2}\d{9}US\b/g },
  // FedEx — 12, 15, or 20 digits. Numeric-only patterns are too
  // generic on their own; we require an explicit FedEx hint.
  { carrier: 'fedex', pattern: /\b\d{12}\b/g },
  { carrier: 'fedex', pattern: /\b\d{15}\b/g },
  { carrier: 'fedex', pattern: /\b\d{20}\b/g },
  // DHL Express — 10 or 11 digits. High false-positive risk; we only
  // accept if the email explicitly mentions DHL.
  { carrier: 'dhl', pattern: /\b\d{10,11}\b/g },
];

const CARRIER_HINTS: { carrier: Carrier; phrases: string[] }[] = [
  { carrier: 'ups', phrases: ['ups.com', 'united parcel', 'ups my choice', 'ups tracking'] },
  { carrier: 'fedex', phrases: ['fedex.com', 'fedex', 'federal express'] },
  { carrier: 'usps', phrases: ['usps.com', 'usps', 'united states postal', 'postal service'] },
  { carrier: 'dhl', phrases: ['dhl.com', 'dhl express', 'dhl ecommerce', 'dhl tracking'] },
];

/** Detect carrier hints based on email text. Returns the set of
 *  carriers explicitly mentioned, used to disambiguate ambiguous
 *  numeric patterns (e.g. 12-digit FedEx vs. random invoice number). */
export function detectCarrierHints(text: string): Set<Carrier> {
  const lower = text.toLowerCase();
  const hits = new Set<Carrier>();
  for (const { carrier, phrases } of CARRIER_HINTS) {
    if (phrases.some((p) => lower.includes(p))) hits.add(carrier);
  }
  return hits;
}

export type ShipmentMatch = {
  carrier: Carrier;
  trackingNumber: string;
};

/**
 * Find tracking-number/carrier pairs in the given email text.
 *
 * Resolution rules:
 * 1. UPS, USPS-Express, USPS-IMpb formats are distinctive enough to
 *    accept on regex alone.
 * 2. FedEx-shaped numeric runs (12/15/20 digits) only count when the
 *    email mentions FedEx — the patterns are too generic otherwise.
 * 3. DHL-shaped numeric runs (10/11 digits) likewise require a DHL
 *    hint — these are the highest false-positive risk.
 * 4. Duplicates across patterns dedupe by `(carrier, number)`.
 */
export function matchShipments(
  text: string,
  subject = '',
): ShipmentMatch[] {
  const haystack = `${subject}\n${text}`;
  const hints = detectCarrierHints(haystack);
  const out = new Map<string, ShipmentMatch>();

  for (const p of PATTERNS) {
    p.pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = p.pattern.exec(haystack)) !== null) {
      const raw = m[0];
      if (p.validate && !p.validate(raw)) continue;
      // Disambiguate generic numeric patterns by carrier hint.
      if (
        (p.carrier === 'fedex' && !hints.has('fedex')) ||
        (p.carrier === 'dhl' && !hints.has('dhl'))
      ) {
        continue;
      }
      const key = `${p.carrier}:${raw}`;
      if (!out.has(key)) {
        out.set(key, { carrier: p.carrier, trackingNumber: raw });
      }
    }
  }
  return [...out.values()];
}

/**
 * Best-effort status keyword inference from email content. Carrier
 * notification emails are extremely consistent ("Out for delivery",
 * "Delivered", "Shipment exception"); a keyword pass usually beats
 * waiting for a fragile carrier-API response.
 */
export function inferStatusFromEmail(
  text: string,
  subject = '',
): { status: ShipmentStatus; description: string } {
  const haystack = `${subject}\n${text}`.toLowerCase();
  const test = (...needles: string[]) => needles.some((n) => haystack.includes(n));

  // Order matters: more specific phrases first so "out for delivery"
  // doesn't match the looser "delivery".
  if (test('returned to sender', 'return to sender')) {
    return { status: 'returned', description: 'Returned to sender' };
  }
  if (test('exception', 'delivery attempted', 'undeliverable')) {
    return { status: 'exception', description: 'Delivery exception' };
  }
  if (test('delivered to', 'has been delivered', 'was delivered')) {
    return { status: 'delivered', description: 'Delivered' };
  }
  if (test('out for delivery', 'on its way today', 'arriving today')) {
    return { status: 'out_for_delivery', description: 'Out for delivery' };
  }
  if (test('in transit', 'on the way', 'shipped', 'has shipped', 'on its way')) {
    return { status: 'in_transit', description: 'In transit' };
  }
  return { status: 'detected', description: 'Detected from email' };
}
