import type { StructuredReceipt } from '../structured.js';
import { parseAmazonReceipt } from './amazon.js';
import { parseAppleReceipt } from './apple.js';
import { parseUspsShipment } from './usps.js';

/**
 * Vendor-specific receipt parsers — the second tier of the receipt
 * cascade. Schema.org JSON-LD catches the well-templated vendors;
 * everyone else falls through to here, where a small registry of
 * per-vendor regex parsers covers the long tail.
 *
 * Each parser is keyed by the sender's `brandKey` (lowercased
 * eTLD+1 second-level label — same key `Sender.brandKey` carries)
 * and is a pure function over the email body + subject. Returning
 * null means "I don't recognise this email"; the receipt extractor
 * then falls through to the LLM as today.
 *
 * Confidence: vendor parsers ship with confidence 0.95 — almost
 * as trusted as schema.org JSON-LD (1.0) but slightly lower
 * because they're pattern-matching against templates that can
 * drift. The receipt extractor's threshold-gate (≥ 0.7) accepts
 * either.
 */

export type VendorParser = (
  html: string,
  subject: string,
) => StructuredReceipt | null;

/**
 * brandKey → parser registry. Add a new vendor by writing
 * `parseFooReceipt` in `vendors/foo.ts`, exporting it, and
 * adding an entry below. The key MUST match the brandKey that
 * `senderDomainTag` would produce for the vendor's sender
 * addresses — see `Sender.brandKey` in @rose/db for the
 * normalisation rule (eTLD+1, lowercase, second-level label).
 */
const VENDOR_REGISTRY: Record<string, VendorParser> = {
  amazon: parseAmazonReceipt,
  apple: parseAppleReceipt,
  usps: parseUspsShipment,
};

/**
 * Dispatch entry point — the receipt extractor calls this between
 * its schema.org pass and its LLM fallback. Returns null when
 * the sender isn't in the registry or the parser couldn't extract
 * anything usable; the extractor proceeds to the LLM in that case.
 */
export function tryVendorReceipt(
  brandKey: string | null,
  html: string,
  subject: string,
): StructuredReceipt | null {
  if (!brandKey) return null;
  const parser = VENDOR_REGISTRY[brandKey.toLowerCase()];
  if (!parser) return null;
  try {
    return parser(html, subject);
  } catch {
    // Parser threw — likely a template edge case we didn't
    // anticipate. Bail to the LLM rather than ship garbage.
    return null;
  }
}

/** Names of every vendor with a registered parser. Surfaced in
 *  the admin coverage panel so the operator sees which vendors
 *  have first-class support. */
export function vendorParserNames(): string[] {
  return [...Object.keys(VENDOR_REGISTRY)].sort();
}

export {
  parseAmazonReceipt,
  parseAppleReceipt,
  parseUspsShipment,
};
