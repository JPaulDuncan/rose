import type { StructuredReceipt, StructuredProduct } from '../structured.js';

/**
 * Amazon order-confirmation parser. Amazon doesn't emit schema.org
 * for most marketplaces — the templates are stable HTML tables.
 * Targets the "Your Amazon.com order of [item]" / "Your order with
 * Amazon — #123-456-7890" shapes that have been roughly
 * unchanged for years.
 *
 * Pattern signatures we look for, in order:
 *   • Order total in a "Order Total: $123.45" row
 *   • Order number in a "Order #123-4567890-1234567" line
 *   • Per-item rows in `<td class="product-title">` or h2 anchors
 *     that link to /gp/product/<ASIN>
 *   • Order date from the email body's standard "Placed on
 *     <date>" line
 *
 * Confidence floors at 0.7 even when only the total is found —
 * partial Amazon data is still meaningfully better than letting
 * the LLM hallucinate. Returns null only when nothing useful
 * came back.
 */

function asNumber(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[^\d.,-]/g, '');
  if (!cleaned) return null;
  // US-style $123.45 dominates; comma is thousands separator.
  const n = Number(cleaned.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function decode(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseAmazonReceipt(
  html: string,
  subject: string,
): StructuredReceipt | null {
  if (!html) return null;

  // ── Order total. The order-summary table consistently has a
  // "Order Total:" / "Grand Total:" row right before the dollar
  // amount in bold.
  const totalRaw =
    /(?:Order\s+Total|Grand\s+Total)[^$]{0,40}\$\s*([\d,]+\.\d{2})/i.exec(
      html,
    )?.[1] ??
    /Total\s+for\s+this\s+order[^$]{0,40}\$\s*([\d,]+\.\d{2})/i.exec(
      html,
    )?.[1] ??
    null;
  const totalAmount = asNumber(totalRaw);

  // ── Order date — "Placed on" / "Order placed:" line.
  let orderDate: string | null = null;
  const datePatterns = [
    /Placed\s+on\s+([A-Z][a-z]+\s+\d{1,2},\s+\d{4})/,
    /Order\s+placed:?\s+([A-Z][a-z]+\s+\d{1,2},\s+\d{4})/,
    /Order\s+date:?\s+([A-Z][a-z]+\s+\d{1,2},\s+\d{4})/,
  ];
  for (const pat of datePatterns) {
    const m = pat.exec(html);
    if (m) {
      orderDate = m[1] ?? null;
      break;
    }
  }
  // Normalise to ISO if recognised.
  let purchasedAt: string | null = null;
  if (orderDate) {
    const ts = Date.parse(orderDate);
    if (Number.isFinite(ts)) purchasedAt = new Date(ts).toISOString().slice(0, 10);
  }

  // ── Line items. Amazon order emails surface each item via a
  // link to /gp/product/<ASIN>; the visible link text is the
  // product title. We capture every <a> linking to /gp/product/
  // or /dp/<ASIN> and harvest its display text.
  const products: StructuredProduct[] = [];
  const seenAsins = new Set<string>();
  const linkRe =
    /<a\b[^>]*href\s*=\s*["'][^"']*\/(?:gp\/product|dp)\/([A-Z0-9]{8,14})[^"']*["'][^>]*>([\s\S]{1,500}?)<\/a>/gi;
  let lm: RegExpExecArray | null;
  while ((lm = linkRe.exec(html)) !== null) {
    const asin = lm[1] ?? '';
    if (!asin || seenAsins.has(asin)) continue;
    const inner = (lm[2] ?? '').replace(/<[^>]+>/g, ' ');
    const name = decode(inner);
    if (!name || name.length < 3) continue;
    // Skip purely navigational link text like "View your order"
    // or "Track package" that happens to live next to a /dp/ link.
    if (/(view\s+(your\s+)?order|track\s+package|return|sign\s+in)/i.test(name)) {
      continue;
    }
    seenAsins.add(asin);
    products.push({
      name: name.slice(0, 200),
      modelNumber: asin,
      manufacturer: null,
      category: null,
      amount: null,
      quantity: 1,
    });
  }

  // Confidence: full data (total + at least one item + a date) is
  // the strong case. Total alone or one item alone is still useful
  // enough to bypass the LLM.
  const hasTotal = totalAmount != null;
  const hasItems = products.length > 0;
  const hasDate = !!purchasedAt;
  let confidence = 0;
  if (hasTotal && hasItems && hasDate) confidence = 0.95;
  else if (hasTotal && hasItems) confidence = 0.85;
  else if (hasTotal || hasItems) confidence = 0.75;
  if (confidence === 0) return null;

  // Subject can disambiguate "Amazon.com" vs "Amazon Music" vs
  // Whole Foods. Keep it simple: brand string from subject if it
  // contains "Amazon", else "Amazon".
  const merchant = /amazon/i.test(subject) ? 'Amazon' : 'Amazon';

  return {
    merchant,
    purchasedAt,
    currency: 'USD', // Amazon US default; multi-region is a future expansion
    totalAmount,
    products,
    confidence,
  };
}
