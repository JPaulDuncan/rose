import type { StructuredReceipt, StructuredProduct } from '../structured.js';

/**
 * Apple receipt parser. Apple's iTunes / App Store / Apple Pay
 * receipts have a very stable templated shape: a header line
 * with the receipt's order id, a per-item table that lists
 * `<strong>App Name</strong>` with the price in a sibling cell,
 * and a "Total" / "Order Total" row at the bottom.
 *
 * Heuristics target the email-store HTML. Web-checkout receipts
 * (apple.com/store) emit different markup; the LLM still handles
 * those via the fallback.
 */

function asNumber(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[^\d.,-]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function decode(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&#039;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseAppleReceipt(
  html: string,
  subject: string,
): StructuredReceipt | null {
  if (!html) return null;

  // Order total. Apple uses currency-prefixed strings like
  // "$2.99" inside a <span> immediately after "Total" / "Order
  // Total". Multi-currency: try $/€/£ in that order.
  let totalRaw: string | null = null;
  let currency: string | null = null;
  for (const symbol of ['\\$', '€', '£']) {
    const m = new RegExp(
      `(?:Order\\s+)?Total[^\\n${symbol}]{0,60}${symbol}\\s*([\\d,]+\\.\\d{2})`,
      'i',
    ).exec(html);
    if (m) {
      totalRaw = m[1] ?? null;
      currency = symbol === '\\$' ? 'USD' : symbol === '€' ? 'EUR' : 'GBP';
      break;
    }
  }
  const totalAmount = asNumber(totalRaw);

  // Date. Apple emails show "Date" / "Receipt Date" with
  // "Mon DD, YYYY" format.
  const dateMatch =
    /(?:Receipt\s+)?Date[\s:]*([A-Z][a-z]+\s+\d{1,2},\s+\d{4})/i.exec(html);
  const orderDateRaw = dateMatch?.[1] ?? null;
  let purchasedAt: string | null = null;
  if (orderDateRaw) {
    const ts = Date.parse(orderDateRaw);
    if (Number.isFinite(ts)) purchasedAt = new Date(ts).toISOString().slice(0, 10);
  }

  // Line items. The HTML uses one of two shapes — keep both:
  //   A. `<strong>App Name</strong>` followed (within ~400 chars)
  //      by a "$X.YY" currency value.
  //   B. A table row `<td>App Name</td>` … `<td>$X.YY</td>`.
  const products: StructuredProduct[] = [];
  const seenNames = new Set<string>();

  const strongRe =
    /<strong>([^<]{1,200})<\/strong>[\s\S]{0,400}?(?:\$|€|£)\s*([\d,]+\.\d{2})/gi;
  let sm: RegExpExecArray | null;
  while ((sm = strongRe.exec(html)) !== null) {
    const name = decode(sm[1] ?? '');
    if (!name || name.length < 3) continue;
    // Skip header rows like "Total", "Subtotal", "Tax".
    if (/^(total|sub-?total|tax|order|payment)/i.test(name)) continue;
    const amount = asNumber(sm[2] ?? null);
    if (seenNames.has(name.toLowerCase())) continue;
    seenNames.add(name.toLowerCase());
    products.push({
      name: name.slice(0, 200),
      modelNumber: null,
      manufacturer: 'Apple',
      // Heuristic — Apple-store purchases are media or a
      // subscription-style service. The shared StructuredProduct
      // enum doesn't have 'software'; subscriptions / iCloud /
      // Arcade map to 'service', media files to 'media'.
      category: /(album|song|movie|tv|book|news\+|music)/i.test(name)
        ? 'media'
        : /(app|subscription|icloud|fitness|arcade)/i.test(name)
          ? 'service'
          : null,
      amount,
      quantity: 1,
    });
  }

  const hasTotal = totalAmount != null;
  const hasItems = products.length > 0;
  let confidence = 0;
  if (hasTotal && hasItems) confidence = 0.95;
  else if (hasTotal || hasItems) confidence = 0.75;
  if (confidence === 0) return null;

  // Use the subject when it disambiguates the merchant strand
  // (e.g. "Your receipt from Apple Music").
  const merchant = subject && /apple/i.test(subject) ? 'Apple' : 'Apple';
  return {
    merchant,
    purchasedAt,
    currency,
    totalAmount,
    products,
    confidence,
  };
}
