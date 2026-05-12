# ADR 0006 — Per-vendor extractor registry between structured-data and LLM

## Status
Accepted, 2026-05-12.

## Context

Receipt extraction shipped with two tiers:

  1. **structured** — schema.org JSON-LD parsed by `parseStructuredReceipt`.
  2. **llm** — the LLM extractor over body prose.

In practice, several large senders (Amazon, Apple, USPS) emit
heavily-templated HTML with neither JSON-LD nor schema.org
microdata. The LLM tier reliably picked these up but at full LLM
cost per receipt, which is a poor cost-to-fidelity trade-off for
input that is fundamentally regex-tractable.

We could either:

  - Push harder on the LLM tier (cheaper model, smaller window).
  - Add a third per-vendor tier that runs deterministic regexes
    against vendor-specific HTML before the LLM fires.

The first option leaves a per-message LLM call on the critical
path even for inputs that haven't changed shape in five years. The
second option is cheap to build, free to run, and degrades
gracefully — when a vendor changes its template the parser
short-circuits at `confidence < 0.7` and the LLM takes over again.

## Decision

**A vendor parser registry lives between the structured pass and
the LLM fallback.**

The shape:

```ts
type VendorParser = (
  html: string,
  subject: string,
) => StructuredReceipt | null;

export const VENDOR_REGISTRY: Record<string, VendorParser> = {
  amazon: parseAmazonReceipt,
  apple: parseAppleReceipt,
  usps: parseUspsShipment,
};

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
    // A parser bug must not break the extractor pipeline.
    return null;
  }
}
```

Per parser:

  - Pure function, no side effects.
  - Reads HTML + email subject; returns a `StructuredReceipt` or
    `null`.
  - Computes a `confidence` in 0–1 reflecting how many of the
    expected signals (total, line items, date) were found.
  - The dispatch caller (`tryVendorReceiptForPage` in the worker)
    gates at `confidence >= 0.7` before persisting; below that
    threshold we fall through to the LLM.
  - The audit row gets `extractedBy: 'vendor'` so the admin
    coverage panel can split vendor vs schema.org coverage.

The same pattern can extend to other extractor families:

  - subscription parsers (`tryVendorSubscription(brandKey, html)`)
  - shipment / tracking parsers (USPS, FedEx, UPS, DHL)
  - calendar parsers (Eventbrite, Cvent, …)

Each registers under a brandKey + a `VendorParser`-shaped
signature and slots into the same try/catch/threshold harness.

## Consequences

- **Cost.** Per-page LLM call avoided for every receipt the new
  parsers catch. Admin coverage panel splits the result by audit
  field so the trend is visible.
- **Fidelity.** Deterministic parsers don't hallucinate values
  the way the LLM occasionally did on noisy promotional rows.
  Apple's "iCloud+ 200GB · $2.99" lands as a clean line item,
  not "Apple Subscription · $2.99 per month".
- **Maintenance.** A vendor changing its template breaks one
  parser. The threshold gate degrades to the LLM tier
  automatically, so a stale parser doesn't drop receipts — it
  just loses cost-savings until the regex is updated.
- **Test isolation.** Each parser is unit-testable against a
  fixture HTML string with no Mongo / queue / Redis. The 15
  tests in `packages/email-parser/src/__tests__/vendors.test.ts`
  cover happy path, navigational-link skipping, currency
  detection, header-row skipping, and dispatch-throws-safe
  behaviour.
- **Brand-key routing.** Reuses the existing `senderDomainTag()`
  helper for parsing the brand out of the From address; no new
  identity surface introduced.

## Out of scope

- LLM tuning. The vendor tier shouldn't be a substitute for
  improving the LLM extractor — it's a cheaper path for inputs
  where the LLM was overkill in the first place.
- Per-user vendor parsers. The registry is global; a user can
  customise output via the existing structured-data overrides,
  not by injecting parser code.
- Heuristic auto-detection of vendor HTML without a brandKey. If
  the From address isn't known the request falls through to the
  LLM. Adding a "sniff the HTML for vendor-tell-tales" path
  would couple the parsers to each other in ways the registry
  was designed to avoid.
