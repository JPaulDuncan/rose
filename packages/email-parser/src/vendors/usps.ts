import type { StructuredReceipt, StructuredProduct } from '../structured.js';

/**
 * USPS shipment-confirmation parser. Not a "receipt" in the
 * purchase sense — USPS doesn't take payment — but the existing
 * ProductPurchase machinery is the closest fit for "a tracked
 * shipment with line items." The receipt extractor treats USPS
 * notifications as a degenerate purchase: zero amount, one line
 * item per package, tracking number stored in the product's
 * model-number slot.
 *
 * Why this is useful even with no amount: pages tagged #shipment
 * surface in the Shipments view today via a separate tracker
 * model, but USPS / UPS / FedEx confirmation emails ALSO produce
 * receipt-style pages, and this parser keeps them from hitting
 * the LLM extractor for content it has structurally.
 *
 * Pattern targets:
 *   • USPS tracking number (e.g. `94 0011 4 9001 4 8745 …` → 22
 *     digits) or "USPS Tracking ID:" labelled rows.
 *   • Expected delivery date "Expected Delivery: <date>".
 *   • Item description from the subject line ("Shipment from <X>").
 */

function decode(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseUspsShipment(
  html: string,
  subject: string,
): StructuredReceipt | null {
  if (!html) return null;

  // Tracking number — both label-prefixed and bare 20–34 digit forms.
  let tracking: string | null = null;
  const labeled =
    /(?:Tracking\s+(?:Number|ID|#)|USPS\s+Tracking)[:\s]*([A-Z0-9 ]{18,40})/i.exec(
      html,
    );
  if (labeled) {
    tracking = (labeled[1] ?? '').replace(/\s+/g, '');
  }
  if (!tracking) {
    // Strip non-digit / non-alpha noise, then check we have a
    // plausible-looking USPS / international shipment number.
    const bare = /\b((?:\d[\s-]?){20,34})\b/.exec(html);
    if (bare) {
      const compact = (bare[1] ?? '').replace(/[\s-]/g, '');
      if (/^\d{20,34}$/.test(compact)) tracking = compact;
    }
  }

  // Expected delivery date. Several phrasings.
  let dateRaw: string | null = null;
  for (const pat of [
    /Expected\s+Delivery[\s:]+([A-Z][a-z]+\s+\d{1,2}(?:,\s*\d{4})?)/i,
    /(?:Estimated|Expected)\s+Delivery\s+Date[\s:]+([A-Z][a-z]+\s+\d{1,2}(?:,\s*\d{4})?)/i,
    /Arriving\s+(?:on\s+)?([A-Z][a-z]+\s+\d{1,2}(?:,\s*\d{4})?)/i,
  ]) {
    const m = pat.exec(html);
    if (m) {
      dateRaw = m[1] ?? null;
      break;
    }
  }
  let expectedAt: string | null = null;
  if (dateRaw) {
    // Append the current year if the parser swallows the date as
    // "May 12" without a year.
    const withYear = /\d{4}/.test(dateRaw)
      ? dateRaw
      : `${dateRaw} ${new Date().getFullYear()}`;
    const ts = Date.parse(withYear);
    if (Number.isFinite(ts)) expectedAt = new Date(ts).toISOString().slice(0, 10);
  }

  if (!tracking && !expectedAt) {
    // Nothing structurally identifying — let the LLM handle it.
    return null;
  }

  // Item label: prefer the subject's "Shipment from <store>" hint;
  // fall back to "USPS Shipment".
  const fromMatch = /(?:shipment|package)\s+from\s+([^,!?.\n]+)/i.exec(subject);
  const shipper = fromMatch ? decode(fromMatch[1] ?? '') : null;
  const itemName = shipper ? `Shipment from ${shipper}` : 'USPS Shipment';

  const product: StructuredProduct = {
    name: itemName.slice(0, 200),
    modelNumber: tracking ? tracking.slice(0, 80) : null,
    manufacturer: 'USPS',
    category: 'service',
    amount: null, // USPS notifications don't carry purchase amount
    quantity: 1,
  };

  return {
    merchant: 'USPS',
    purchasedAt: expectedAt,
    currency: null,
    totalAmount: null,
    products: [product],
    // Lower confidence than commerce vendors — we have ID / date
    // but no price. Still above the LLM-bypass threshold (0.7) so
    // we save the call.
    confidence: tracking && expectedAt ? 0.85 : 0.75,
  };
}
