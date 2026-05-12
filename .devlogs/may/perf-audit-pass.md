# Perf roadmap — May audit pass

**Date:** 2026-05-12.

Pass-through against `perf-roadmap.md`'s actionable items to
separate "already shipped" from "real backlog" from "would need
profiling before touching." Saves the next reader from
re-running the spot-checks.

## Already shipped

These items were called out as backlog in the original roadmap
but have since landed. No action needed.

- **§5.1 `.lean()` audit** — claims 67 lean calls / 171 query
  sites at time of writing. Current count: **114 lean calls in
  `apps/worker`**. The sweep happened in the interim. Remaining
  non-lean queries are mostly the legitimate "load → mutate →
  save" hydrated path or short list lookups; a blanket sweep
  would now risk false positives.
- **§5.4 index audit** — three of the four claimed-missing
  compound indexes already exist:
  - `Sender(userId, autoQuarantine)` — partial index, `Sender.ts`
  - `Page(userId, categoryId)` — partial index, `Page.ts`
  - `Email(userId, 'from.address')` — `Email.ts:203`
  The fourth — `WebDocument(userId, hostKey, expiresAt)` — landed
  this pass (the doc comment claimed it existed but the
  `schema.index()` call was missing).

## Real backlog — declined this pass with reasons

- **§7.3 batch embeddings.** Real win but needs an Ollama API
  upgrade (`/api/embeddings` is single-input; `/api/embed`
  accepts arrays). Cross-deployment compatibility check needed
  before changing the provider interface. Defer until then.

- **§5.2 projection discipline.** Per-query analysis;
  case-by-case judgement. Best handled when a specific endpoint
  is identified as slow under profiling, not as a sweep.

## Shipped in the follow-up pass

- **§5.3 bulk inserts in IMAP/Gmail sync.** Both sync workers
  now batch into `Email.bulkWrite({ordered: false})` via a
  shared `flushPendingEmails` helper in
  `apps/worker/src/lib/bulkIngestEmails.ts`. Each pending entry
  gets a pre-assigned `ObjectId`; after the bulk insert we
  refetch by `_id ∈ assignedIds` so the side-effect fan-out
  (generate-page enqueue, recipe emit, shipment + promo
  detection, metric inc) runs only for the rows that actually
  inserted — dup-key collisions on `(userId, rawHash)` skip
  cleanly. Flush window is 50, sized to stay well under
  Mongo's 16MB op cap on any plausible mailbox. ~40 round-trips
  instead of ~2000 on an initial backfill.

- **§3.1 htmlparser2 SAX pre-filter.** `quickSniff` in
  `apps/worker/src/services/extractArticle.ts` is now a real
  htmlparser2 SAX pass: counts visible text (skipping
  `script`/`style`/`noscript`/`iframe`/`template`/`svg` token
  ranges) and harvests `<title>` for keyword matching. Catches
  the cases the old regex stub missed — captcha /
  cloudflare-interstitial pages, soft-404s, and tracking-blob
  pages that *look* big but have no body text — without paying
  for the linkedom DOM build + Readability traversal on
  obviously-thin pages. Added tests for the new behaviours.

## Already-done items shipped while this audit was being written

This branch's own commits cover a couple of roadmap-adjacent
wins worth noting:

- **§4.1 `Page.outboundLinks` field replaces the lineage
  contentMd regex** — that wasn't in the original roadmap but
  is the same shape of fix (indexed lookup replacing collscan).
  See `apps/api/src/routes/pages.ts:lineage`.

- **§5.4 `(userId, outboundLinks)` index** — added alongside
  the new field.

- **Embedding rung in tag canonicaliser** — caches per-canonical
  vectors on the `TagCanonical` row, invalidating on provider
  model switch. This is the embedding-related precedent for how
  to handle the §7.3 batch-embedding rollout cleanly.

## What `12-feature-audit.md` left open

A final scan over the audit's roll-up table: 16 of 17 findings
resolved. The one deliberate skip is R7 (three discovery entry
points — UX shape unclear). No action needed from the perf
side.
