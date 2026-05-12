import { describe, it, expect } from 'vitest';
import {
  extractJsonLd,
  parseStructuredReceipt,
  parseStructuredSubscription,
} from '../structured.js';

/**
 * Real-shape fixtures. Every JSON-LD block here matches what one
 * of the big vendors actually emits — the field names and nesting
 * aren't invented. The point of these tests is to lock in coverage
 * for the LLM-bypass fast path.
 */

const APPLE_ORDER_JSONLD = `
<html><body>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Order",
  "merchant": { "@type": "Organization", "name": "Apple" },
  "orderNumber": "W123-4567",
  "orderDate": "2024-12-12",
  "priceCurrency": "USD",
  "orderTotal": { "@type": "PriceSpecification", "price": 1299.00, "priceCurrency": "USD" },
  "acceptedOffer": [
    {
      "@type": "Offer",
      "price": 1199.00,
      "priceCurrency": "USD",
      "eligibleQuantity": 1,
      "itemOffered": {
        "@type": "Product",
        "name": "MacBook Pro 14-inch",
        "sku": "MK183LL/A",
        "brand": { "@type": "Brand", "name": "Apple" }
      }
    },
    {
      "@type": "Offer",
      "price": 100.00,
      "priceCurrency": "USD",
      "itemOffered": { "@type": "Product", "name": "AppleCare+" }
    }
  ]
}
</script>
</body></html>
`;

const STRIPE_INVOICE_JSONLD = `
<script type="application/ld+json">
{
  "@type": "Invoice",
  "provider": { "@type": "Organization", "name": "Stripe" },
  "paymentDueDate": "2025-01-12",
  "totalPaymentDue": { "@type": "PriceSpecification", "price": 25.99, "priceCurrency": "USD" },
  "description": "Monthly subscription renewal — Stripe Pro"
}
</script>
`;

const SHOPIFY_GRAPH_JSONLD = `
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "name": "Shopify Store"
    },
    {
      "@type": "Order",
      "merchant": { "@type": "Organization", "name": "Shopify Store" },
      "orderDate": "2024-11-30",
      "totalPaymentDue": { "@type": "PriceSpecification", "price": "47,50", "priceCurrency": "EUR" },
      "acceptedOffer": [
        {
          "@type": "Offer",
          "price": "47,50",
          "priceCurrency": "EUR",
          "itemOffered": { "@type": "Product", "name": "Coffee beans 1kg" }
        }
      ]
    }
  ]
}
</script>
`;

const MICRODATA_PRODUCT = `
<html><body>
<div itemscope itemtype="https://schema.org/Product">
  <span itemprop="name">Vintage Levi's 501</span>
  <meta itemprop="price" content="89.00" />
  <meta itemprop="priceCurrency" content="USD" />
</div>
<div itemscope itemtype="https://schema.org/Product">
  <span itemprop="name">Linen shirt</span>
  <span itemprop="price">$45.00</span>
</div>
</body></html>
`;

const NO_STRUCTURED_DATA = `
<html><body>
<p>Hi Sam, thanks for your order. Your total comes to $24.99.</p>
</body></html>
`;

const TRAILING_COMMA_JSONLD = `
<script type="application/ld+json">
{
  "@type": "Order",
  "merchant": { "name": "Etsy", },
  "orderTotal": { "price": 12.34, "priceCurrency": "USD", }
}
</script>
`;

const SUBSCRIPTION_INVOICE = `
<script type="application/ld+json">
{
  "@type": "Invoice",
  "provider": { "name": "GitHub" },
  "paymentDueDate": "2025-02-01",
  "totalPaymentDue": { "price": 4.00, "priceCurrency": "USD" },
  "description": "Your monthly GitHub Pro subscription will renew."
}
</script>
`;

describe('extractJsonLd', () => {
  it('parses a single Order block', () => {
    const nodes = extractJsonLd(APPLE_ORDER_JSONLD);
    expect(nodes).toHaveLength(1);
    expect((nodes[0] as { '@type': string })['@type']).toBe('Order');
  });

  it('flattens @graph containers', () => {
    const nodes = extractJsonLd(SHOPIFY_GRAPH_JSONLD);
    expect(nodes).toHaveLength(2);
    const types = nodes.map((n) => (n as { '@type': string })['@type']);
    expect(types).toContain('Order');
    expect(types).toContain('Organization');
  });

  it('skips empty bodies and malformed scripts without throwing', () => {
    expect(extractJsonLd('')).toEqual([]);
    expect(
      extractJsonLd('<script type="application/ld+json">{ broken</script>'),
    ).toEqual([]);
  });

  it('tolerates trailing commas via the retry pass', () => {
    const nodes = extractJsonLd(TRAILING_COMMA_JSONLD);
    expect(nodes).toHaveLength(1);
  });
});

describe('parseStructuredReceipt', () => {
  it('extracts the Apple Order shape end-to-end', () => {
    const r = parseStructuredReceipt(APPLE_ORDER_JSONLD);
    expect(r).not.toBeNull();
    expect(r!.merchant).toBe('Apple');
    expect(r!.totalAmount).toBe(1299);
    expect(r!.currency).toBe('USD');
    expect(r!.purchasedAt).toBe('2024-12-12');
    expect(r!.confidence).toBe(1);
    expect(r!.products).toHaveLength(2);
    const mbp = r!.products.find((p) => p.name.includes('MacBook'))!;
    expect(mbp.amount).toBe(1199);
    expect(mbp.manufacturer).toBe('Apple');
    expect(mbp.modelNumber).toBe('MK183LL/A');
    expect(mbp.category).toBe('electronics');
  });

  it('extracts the Shopify @graph + euro-style price', () => {
    const r = parseStructuredReceipt(SHOPIFY_GRAPH_JSONLD);
    expect(r).not.toBeNull();
    expect(r!.merchant).toBe('Shopify Store');
    expect(r!.totalAmount).toBe(47.5);
    expect(r!.currency).toBe('EUR');
    expect(r!.products).toHaveLength(1);
    expect(r!.products[0]!.name).toContain('Coffee');
    // Coffee should classify as 'food'
    expect(r!.products[0]!.category).toBe('food');
  });

  it('returns null when there is no structured data', () => {
    expect(parseStructuredReceipt(NO_STRUCTURED_DATA)).toBeNull();
  });

  it('falls back to Microdata with confidence ≤ 0.5', () => {
    const r = parseStructuredReceipt(MICRODATA_PRODUCT);
    expect(r).not.toBeNull();
    expect(r!.confidence).toBeLessThanOrEqual(0.5);
    expect(r!.products.length).toBeGreaterThanOrEqual(1);
    const levis = r!.products.find((p) => p.name.includes("Levi"));
    expect(levis?.amount).toBe(89);
  });

  it('handles the Stripe Invoice as a partial-confidence receipt', () => {
    const r = parseStructuredReceipt(STRIPE_INVOICE_JSONLD);
    expect(r).not.toBeNull();
    expect(r!.merchant).toBe('Stripe');
    expect(r!.totalAmount).toBe(25.99);
    expect(r!.confidence).toBeGreaterThanOrEqual(0.5);
  });
});

describe('parseStructuredSubscription', () => {
  it('extracts a recurring Invoice as a subscription', () => {
    const r = parseStructuredSubscription(SUBSCRIPTION_INVOICE);
    expect(r).not.toBeNull();
    expect(r!.serviceName).toBe('GitHub');
    expect(r!.amount).toBe(4);
    expect(r!.currency).toBe('USD');
    expect(r!.cadence).toBe('monthly');
    expect(r!.nextRenewalAt).toBe('2025-02-01');
    expect(r!.status).toBe('active');
    expect(r!.confidence).toBe(1);
  });

  it('returns null for an Order without subscription wording', () => {
    expect(parseStructuredSubscription(APPLE_ORDER_JSONLD)).toBeNull();
  });

  it('returns null when there is no structured data', () => {
    expect(parseStructuredSubscription(NO_STRUCTURED_DATA)).toBeNull();
  });
});
