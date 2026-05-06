# Plan 15 — Shared knowledge: daydream notes, sender briefs, and logos

**Status:** Shipped.
Retrospective spec.

---

## Why

Before this plan, three classes of knowledge that have no user-specific signal were nonetheless scoped per-user:

- **DaydreamNote.** Every user re-researched the same encyclopedic facts. "Wikipedia summary of Inception" is identical for everyone but each user paid the LLM synthesis cost independently.
- **Sender brief.** "NPR is a public-radio network…" is the same one-paragraph answer for every user, but each per-user `Sender` row held its own copy.
- **Logo.** Once Rose has learned that `acme.com`'s favicon lives at `https://acme.com/favicon.ico` (or extracted a higher-confidence logo from an email), there's no reason every other user has to wait for their own first email from Acme to see the logo.

Globalising these reduces wasted LLM calls and makes new users immediately productive — the system "knows things" before they've trained it from their own mail.

The user-specific parts (counts, toggles, locks, spam-marks, "I don't want to see this") stay per-user.

---

## Privacy model

Daydream notes and sender briefs are produced from **public** signals only. The prompts for both (`packages/llm/src/seed/index.ts` — `daydream synthesis`, `sender.summary`) explicitly:
- Use only the supplied evidence (Wikipedia / Wikidata / OpenAlex / etc., or the brand's own metadata + recent subject lines).
- Output neutral encyclopedic prose (no "you often get emails about…").

Subject lines that feed the sender brief are public-ish (the user's own correspondence, but the brief output drops them in favour of generalised statements). This is the same posture the daydream system has used since plan 09; making it global doesn't widen the leakage surface.

Per-user state does NOT globalise:
- `Sender.emailCount / pageCount / firstSeenAt / lastSeenAt`
- `Sender.spamMarkedCount / rescuedCount / autoQuarantine / lastMarkedAt`
- `Sender.stripAds / logoLocked / summaryLocked` (per-user overrides)

---

## Schema

### `DaydreamNote` — modified

Before:
```
{ userId, kind, subjectKey, displayName, summary, bodyMd, sources, ... }
unique: (userId, kind, subjectKey)
```

After:
```
{ firstResearchedBy, kind, subjectKey, displayName, summary, bodyMd,
  sources, forgottenBy: [ObjectId], ... }
unique: (kind, subjectKey)
```

`firstResearchedBy` is audit-only (informational). `forgottenBy` lets a user mute the note from their views without yanking it from anyone else.

### `SenderBrand` — new

```
{
  brandKey,                  // unique; same key Sender uses
  domain, name,
  addresses[], websites[],
  logoUrl, logoConfidence,
  unsubscribeUrls[], postalAddresses[],
  summary, summaryGeneratedAt, summaryModel,
  forgottenBriefBy: [ObjectId],
  firstSeenBy
}
```

### `Sender` — unchanged

Keeps everything it had. Reads of brand-global fields prefer the `SenderBrand` overlay; existing per-user values stay as fallback so legacy data doesn't disappear.

---

## Pipeline

### Daydream worker

`apps/worker/src/processors/daydream.ts:upsertNote` and `markFailed` now key on `(kind, subjectKey)`. A successful refresh from any user clears `forgottenBy: []` — the assumption is fresh content is worth re-showing to anyone who'd previously hidden it. `isFresh` reads on the same key, so any user's recent refresh keeps every other user from re-paying for the same research within `staleAfter`.

### Sender upsert

`apps/worker/src/services/senderUpsert.ts:upsertGlobalSenderBrand` (new helper) dual-writes the brand-global fields into `SenderBrand` alongside the existing per-user `Sender` writes. Logo policy: highest-confidence-wins; favicon fallback only when no logo at all is on file.

### Sender summarizer

`apps/worker/src/processors/summarizeSender.ts` writes the brief to **both** the per-user Sender row (legacy compat) AND the global `SenderBrand`. Successful write resets `forgottenBriefBy: []` for the same reason daydream does.

---

## Reads

### `/api/pages/:slug` — `senderBrands` map

Reads `SenderBrand` first (the source of truth for logos / brand names), falls back to per-user `Sender` for any addresses still mapped only there. This is the load-bearing change for the "logos shared system-wide" guarantee: a logo learned from one user's email shows for every user encountering the same sender, even users who've never received mail from the brand themselves.

### `/api/senders/*` — sender directory + detail

`mergeBrandIntoSender` overlays `SenderBrand` onto the per-user `Sender` payload. Locks (`logoLocked`, `summaryLocked`) preserve user overrides. Addresses / websites / unsubscribeUrls / postalAddresses all union across the two sources.

`/api/senders/by-address/:address` — checks per-user first, falls back to the global `SenderBrand` so a brand chip on a wiki page links to `/s/:brandKey` even when the current user has no personal Sender row.

### `/api/daydream/recent`, `/api/pages/:id/daydream`, `/api/entities/:key/daydream`

All three drop the `userId` filter and add `forgottenBy: { $ne: userId }`. The notes they return are global; only the user's mute state is private.

---

## Write paths (forget / refresh)

### Daydream

- `DELETE /api/daydream/notes/:id` — was a hard delete; now `$addToSet` on `forgottenBy` so the note stays for other users.
- Refresh path (POST endpoints / sweeper) clears `forgottenBy: []` on success.

### Sender brief

- `POST /api/senders/:brandKey/refresh` — clears the per-user `summaryLocked`, also clears the global `forgottenBriefBy: []`, then enqueues the summarize job.
- `DELETE /api/senders/:brandKey/brief` (new) — `$addToSet` on `SenderBrand.forgottenBriefBy` for the current user. The per-user `Sender` row stays; only the brief gets hidden from this user.
- `DELETE /api/senders/:brandKey` (existing) — still per-user; deletes the user's Sender row but never touches `SenderBrand`.

---

## Migration

Two boot-time idempotent migrations in `apps/api/src/services/migrations.ts`:

1. **`migrateDaydreamNotesToGlobal`** — groups by `(kind, subjectKey)`, keeps the freshest non-failed row per group (deletes the rest), stamps `firstResearchedBy` from the legacy `userId`, drops `userId`. Runs before the new unique index can build.

2. **`migrateSenderBrandsToGlobal`** — for each unique `brandKey` across all per-user Sender rows, picks the row with the most evidence (freshest summary / highest logoConfidence / longest addresses) and upserts a single `SenderBrand` row. Unions addresses / websites / unsubscribeUrls / postalAddresses across all users so the brand row is the most complete picture available. Per-user Sender rows are left in place as fallback.

Both migrations are no-ops on a fresh install and log row counts when they do work.

---

## Closeout (later that day)

The "deliberately not here" list got picked off in a third commit:

### Sender field strip

`Sender` is now per-user state only. The legacy brand-global fields
(`name`, `domain`, `addresses`, `websites`, `logoUrl`,
`logoConfidence`, `logoLocked`, `summary`, `summaryGeneratedAt`,
`summaryLocked`, `unsubscribeUrls`, `postalAddresses`) are
`$unset` by `migrateSenderStripBrandFields` at boot. Two new
override fields take their place:

- `nameOverride: string | null` — user's preferred display name
  for this brand. null = use the shared `SenderBrand.name`.
- `logoUrlOverride: string | null` — user's preferred logo. null
  = use `SenderBrand.logoUrl`.

The migration preserves user customisations:
- `logoLocked: true` rows have their `logoUrl` copied to
  `logoUrlOverride`.
- Names that differ from both the brand row and the bare
  `brandKey` default end up on `nameOverride`.
- Hand-curated summaries (`summaryLocked: true` rows) were
  already promoted onto `SenderBrand` by the earlier
  `migrateSenderBrandsToGlobal` pass — its sort order now
  prefers locked-and-non-empty summaries.

`migrateSenderBrandsToGlobal` was updated to sort
`summaryLocked: true` rows first when picking which row's data
becomes canonical.

### Promote to brand

Two new endpoints invert the per-user override flow — push your
override onto the global row so every user benefits:

- `POST /api/senders/:brandKey/promote-logo` — copies
  `logoUrlOverride` to `SenderBrand.logoUrl` (with
  `logoConfidence: 1`) and clears the per-user override since
  it's now the default.
- `POST /api/senders/:brandKey/promote-name` — same shape for
  `nameOverride → SenderBrand.name`.

Both are exposed as **Promote to brand** buttons in the
`SenderEditPanel` next to the relevant override input. Disabled
until the user has actually set an override.

### "Contributed by" attribution

`SenderBrand.firstSeenBy` and `DaydreamNote.firstResearchedBy`
audit fields are now resolved to the user's `displayName` and
included on three response surfaces:

- `/api/daydream/recent` — each note carries
  `contributedBy: string`.
- `/api/entities/:key/daydream` — single-note response carries
  it too.
- `/api/senders/:brandKey` — sender detail surfaces the same.

The UI shows each as a small italic chip in the metadata row
("contributed by Alice"), with a tooltip explaining that the
record is shared.

### Worker / API write paths after the strip

- `senderUpsert.ts` — new senders only get per-user counters
  (`emailCount`, `pageCount`, `firstSeenAt`, `lastSeenAt`).
  Brand-global fields all flow through `upsertGlobalSenderBrand`.
- `summarizeSender.ts` — reads brand metadata from
  `SenderBrand`, writes the new brief only to `SenderBrand`. The
  per-user `Sender.summary` write was redundant and is gone.
- `senders.ts` PATCH — accepts `name` (→ `nameOverride`),
  `logoUrl` (→ `logoUrlOverride`), `stripAds`. Drops the old
  `summary` parameter (the brief is brand-global; use refresh /
  forget). Auto-summarize jobs are now dedup-keyed by brand
  rather than user so concurrent first-sights from multiple
  users collapse into one job.
- Reply context (`reply.ts`) reads brand metadata from
  `SenderBrand` directly.
- Codex / Promotions / Digest routes read `SenderBrand` for
  brand-global fields and merge per-user counters from
  `Sender`.

### Done

Every "deliberately not here" item from the original plan has
shipped. The `Sender` model is genuinely thin now; the
`SenderBrand` row is unambiguously the source of truth for any
fact about a brand; users can refresh / forget / promote — and
attribution makes it visible whose work everyone's standing on.
