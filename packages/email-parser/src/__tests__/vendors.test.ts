import { describe, it, expect } from 'vitest';
import {
  parseAmazonReceipt,
  parseAppleReceipt,
  parseUspsShipment,
  tryVendorReceipt,
} from '../vendors/index.js';

/* ─── Amazon ──────────────────────────────────────────────── */

const AMAZON_ORDER = `
<html><body>
  <p>Order placed: May 12, 2024</p>
  <p>Order #123-4567890-1234567</p>
  <table>
    <tr>
      <td><a href="https://www.amazon.com/gp/product/B0CGV5Q4JZ">USB-C Charging Cable, 6ft</a></td>
    </tr>
    <tr>
      <td><a href="https://www.amazon.com/dp/B07VHJK1NL">Aeropress Coffee Maker</a></td>
    </tr>
    <tr>
      <td>Order Total: $42.99</td>
    </tr>
  </table>
  <a href="https://www.amazon.com/gp/your-account/order">View your order</a>
</body></html>
`;

describe('parseAmazonReceipt', () => {
  it('extracts total + line items + date from a normal order email', () => {
    const r = parseAmazonReceipt(AMAZON_ORDER, 'Your Amazon.com order #123-4567890-1234567');
    expect(r).not.toBeNull();
    expect(r!.merchant).toBe('Amazon');
    expect(r!.totalAmount).toBe(42.99);
    expect(r!.currency).toBe('USD');
    expect(r!.purchasedAt).toBe('2024-05-12');
    expect(r!.products).toHaveLength(2);
    const charger = r!.products.find((p) => p.name.includes('USB-C'));
    expect(charger).toBeDefined();
    expect(charger!.modelNumber).toBe('B0CGV5Q4JZ');
    expect(r!.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('skips navigational link text like "View your order"', () => {
    const r = parseAmazonReceipt(AMAZON_ORDER, '');
    expect(r!.products.map((p) => p.name)).not.toContain('View your order');
  });

  it('returns null on bodies with no Amazon signals', () => {
    expect(parseAmazonReceipt('<p>Hello, world</p>', 'random')).toBeNull();
  });

  it('survives a total-only email (e.g. shipping confirmation)', () => {
    const r = parseAmazonReceipt(
      '<p>Order Total: $9.99</p>',
      'Your order ships soon',
    );
    expect(r).not.toBeNull();
    expect(r!.totalAmount).toBe(9.99);
    // Partial-shape: confidence should still pass the bypass gate
    expect(r!.confidence).toBeGreaterThanOrEqual(0.7);
  });
});

/* ─── Apple ───────────────────────────────────────────────── */

const APPLE_ORDER = `
<html><body>
  <p>Receipt Date: Dec 12, 2024</p>
  <table>
    <tr>
      <td><strong>Logic Pro</strong></td>
      <td>$199.99</td>
    </tr>
    <tr>
      <td><strong>iCloud+ 200GB</strong></td>
      <td>$2.99</td>
    </tr>
    <tr>
      <td>Subtotal</td><td>$202.98</td>
    </tr>
    <tr>
      <td>Order Total</td><td>$202.98</td>
    </tr>
  </table>
</body></html>
`;

describe('parseAppleReceipt', () => {
  it('extracts total, items + classifies subscriptions as service', () => {
    const r = parseAppleReceipt(APPLE_ORDER, 'Your receipt from Apple');
    expect(r).not.toBeNull();
    expect(r!.merchant).toBe('Apple');
    expect(r!.totalAmount).toBe(202.98);
    expect(r!.currency).toBe('USD');
    expect(r!.purchasedAt).toBe('2024-12-12');
    expect(r!.products).toHaveLength(2);
    const logic = r!.products.find((p) => p.name === 'Logic Pro');
    expect(logic).toBeDefined();
    expect(logic!.manufacturer).toBe('Apple');
    const icloud = r!.products.find((p) => p.name.startsWith('iCloud'));
    expect(icloud!.category).toBe('service');
  });

  it('reads euro totals when €-prefixed', () => {
    const html = `
      <strong>Spotify Premium</strong> €9.99
      <p>Total €9.99</p>
    `;
    const r = parseAppleReceipt(html, 'Your receipt');
    expect(r).not.toBeNull();
    expect(r!.currency).toBe('EUR');
    expect(r!.totalAmount).toBe(9.99);
  });

  it('skips Subtotal / Tax / Total header rows from the product list', () => {
    const r = parseAppleReceipt(APPLE_ORDER, '');
    expect(r!.products.map((p) => p.name)).not.toContain('Subtotal');
    expect(r!.products.map((p) => p.name)).not.toContain('Order Total');
  });

  it('returns null on bodies with no Apple-shape signals', () => {
    expect(parseAppleReceipt('<p>hello</p>', '')).toBeNull();
  });
});

/* ─── USPS ────────────────────────────────────────────────── */

const USPS_SHIPMENT = `
<html><body>
  <p>USPS Tracking Number: 9400 1112 0000 1234 5678 90</p>
  <p>Expected Delivery: May 15, 2024</p>
</body></html>
`;

describe('parseUspsShipment', () => {
  it('extracts tracking number + expected delivery from a normal notification', () => {
    const r = parseUspsShipment(USPS_SHIPMENT, 'Shipment from Etsy');
    expect(r).not.toBeNull();
    expect(r!.merchant).toBe('USPS');
    expect(r!.purchasedAt).toBe('2024-05-15');
    expect(r!.products).toHaveLength(1);
    expect(r!.products[0]!.name).toContain('Etsy');
    expect(r!.products[0]!.modelNumber).toMatch(/^\d+$/);
    expect(r!.products[0]!.modelNumber!.length).toBeGreaterThan(15);
  });

  it('returns null when neither tracking nor delivery date is found', () => {
    const r = parseUspsShipment('<p>Hello</p>', 'Greeting');
    expect(r).toBeNull();
  });

  it('handles a bare tracking number without the label', () => {
    const r = parseUspsShipment(
      '<p>9400 1112 0000 1234 5678 90</p>',
      'package',
    );
    expect(r).not.toBeNull();
    expect(r!.products[0]!.modelNumber).toBeTruthy();
  });
});

/* ─── Registry dispatch ───────────────────────────────────── */

describe('tryVendorReceipt', () => {
  it('dispatches to the right parser by brandKey', () => {
    const r = tryVendorReceipt('amazon', AMAZON_ORDER, '');
    expect(r).not.toBeNull();
    expect(r!.merchant).toBe('Amazon');
  });

  it('returns null for an unknown brandKey', () => {
    expect(tryVendorReceipt('walmart', AMAZON_ORDER, '')).toBeNull();
  });

  it('returns null when brandKey is null', () => {
    expect(tryVendorReceipt(null, AMAZON_ORDER, '')).toBeNull();
  });

  it('survives a parser throwing — bails to null rather than propagating', () => {
    // Pass invalid html that's still a string — should not throw.
    expect(tryVendorReceipt('amazon', '', '')).toBeNull();
  });
});
