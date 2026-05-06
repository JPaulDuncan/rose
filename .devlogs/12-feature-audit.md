# 12 — Feature audit: redundancy + gaps

**Date:** 2026-05-06.
**Status:** Captures the application as it stands right now after roughly a dozen feature commits since the original plan files were written. The doc is a snapshot, not a roadmap. The Recommended priorities section at the end is opinion, not commitment.

**Update 2026-05-06 (later that day):** Pass-through against every finding. Resolution status is annotated inline in §3 / §4 below; a roll-up sits at the bottom in §8.

---

## 1. Headline summary

Rose's surface area has grown well past the original ten plans. The orthogonality is mostly intact — most features serve distinct purposes — but several layers have accumulated **parallel implementations of the same concept** that need consolidation, and the LLM extraction pipeline has **fan-out points where the post-persist steps for some surfaces aren't running for others**.

In rough numbers (from the explorer survey):

- 19 worker processors, 11 worker services
- 38 API routers, ~250 endpoints
- 17 protected web routes, 14 settings tabs
- 27 Mongo collections
- 19 LLM seed instructions across 17 scopes
- 13 daydream knowledge adapters

Critical issues: 0. Real redundancies that will bite us: 4. Real gaps that affect user experience: 6.

---

## 2. Inventory at a glance

The full inventory lives in the explorer scratch. For navigation:

| Surface | Where to look |
|---|---|
| Worker pipeline | `apps/worker/src/processors/`, `apps/worker/src/services/` |
| API routes | `apps/api/src/routes/`, mounted in `apps/api/src/index.ts` |
| Web routes | `apps/web/src/App.tsx` lazy imports |
| Settings tabs | `apps/web/src/routes/settings/Layout.tsx` TABS list |
| DB models | `packages/db/src/models/` |
| LLM seeds | `packages/llm/src/seed/index.ts` |
| Daydream adapters | `packages/llm/src/daydream/*.ts` |

Skim those if you need a feature map. Below is what stood out when reading them side-by-side.

---

## 3. Redundancy findings

### R1 — Two `extractEntitiesFromPage` implementations  *(severity: medium · **status: resolved**)*

`apps/worker/src/services/extractEntities.ts` (new, linker-driven) and `apps/worker/src/lib/discovery/entityExtraction.ts` (older, daydream-internal) both export a function with the **same name** and operate on the same input but with **different output schemas**:

| | New (`services/`) | Old (`lib/discovery/`) |
|---|---|---|
| Types | `person` / `work` / `organization` | `person` / `org` / `place` / `work` / `concept` / `other` |
| Aliases | yes | no |
| Persistence | `Page.entities[]` + `Entity` collection | `daydreamSubjects[]` only |
| Caller | `generatePage` post-persist | `daydream` processor |

The two coexist because each grew up to feed a different surface. The cost is real: every page write currently makes **two LLM extraction calls covering the same prose** (one for the linker registry, one for the daydream subject queue). The schemas don't even agree on the type set — "place" is a category in the legacy extractor but lives in `Page.places[]` for the new one.

**Suggested resolution:** Make the new extractor authoritative. The daydream processor reads `Page.entities[]` directly (already populated) instead of running its own pass; `daydreamSubjects[]` becomes a derived view over `entities[] + tags[] + topics[]` rather than an independent extraction. Drop `lib/discovery/entityExtraction.ts`. Saves ~1 LLM call per page generation; closes a confusing same-name divergence.

**Resolution (commit `fe0c4d8`):** Daydream's `ensurePageSubjects` now reads `Page.entities[]` directly. The legacy `lib/discovery/entityExtraction.ts` extractor stays as a fallback for pages where the linker step never ran or returned empty (legacy pages, failure cases) but the common path skips it. Saves the redundant LLM call.

### R2 — `Page.threadKey` (singular, legacy) vs `Page.threadKeys[]` (plural, current)  *(severity: low · **status: resolved**)*

The `threadKey` String field is documented as "kept for migration." It's still being read by `pageAssignment.ts`:

```ts
$or: [{ threadKeys: email.threadKey }, { threadKey: email.threadKey }]
```

Risk: low — the dual lookup is correct. But every new write adds to `threadKeys[]` only; old rows that still carry `threadKey` get ignored by future logic that reads only the array form, and we've already shipped that pattern several times.

**Suggested resolution:** A one-time migration that copies `threadKey` → `threadKeys[]` and clears the legacy field. Then drop the field from the schema.

**Resolution (commit `e9c77f1`):** `apps/api/src/services/migrations.ts:migrateLegacyThreadKey` runs at API boot. Idempotent — a no-op once the legacy field is empty everywhere. The defensive `$or` in pageAssignment.ts stays for one more release in case a deployment hasn't booted with this code yet; the next cleanup commit can remove it and drop the field from the schema.

### R3 — Place data lives in three places  *(severity: low · **status: deferred**)*

For a place mention like "Brooklyn":

| Field | What it stores | Owner |
|---|---|---|
| `Page.places[]` | `{name, normKey, lat, lon, displayName, geocodedAt, failed}` | extraction + geocoding |
| `Page.entities[]` | NOT populated (extractor explicitly skips places) | linker |
| `Entity` collection | NOT populated | linker upserter |

The `/n/<key>` route handles places by special-casing — joining on `places.normKey` instead of `entities.normKey`. The auto-linker also has place-aware code paths in `Page.tsx`. Works, but the special-casing is sprawl: the `EntityResponse` type has `placeCoords`, `Entity.tsx` has `place` as a fourth type variant only used for the map, and the entity directory at `/api/entities` doesn't even know about places.

**Suggested resolution:** Add `kind: 'place'` to `Entity` model and write a place row alongside the geocode. Then `Entity.tsx` and `/api/entities` become uniform; the map inset is the only place-specific render. The place-extraction service can write both `Page.places[]` (with lat/lon) and the Entity row (without).

**Status: deferred.** The current path works end-to-end (places auto-link to /n/<key>, entity page renders the map). The refactor would touch every Entity index + the Settings → Entities UI for a low-severity payoff. Logging it for a future schema-cleanup pass.

### R4 — Several "summary"-shaped LLM scopes overlap stylistically  *(severity: low · **status: partial**)*

Five seed scopes write news-style narrative summaries: `generate.wiki-page`, `consolidate.topic`, `briefing.weekly`, `synthesis.meta`, `tag-digest.daily`. The explorer flagged them as "not overlapping — different aggregation levels," which is true at the data-model level. But the prompts share **a lot** of duplicated language ("inverted-pyramid", "no filler", "cite each claim", "don't invent"). Any tweak to voice or grounding rules has to be made in five places.

**Suggested resolution:** Extract a shared `SYSTEM_PROMPT_NEWS_PROSE` constant from `@rose/llm` and prepend it to each of these scopes. Each seed retains only its surface-specific instructions (what the inputs are, what the JSON shape is). Reduces drift; future style changes happen once.

**Resolution (commit `e9c77f1`, partial):** `SYSTEM_PROMPT_NEWS_PROSE` is now exported from `@rose/llm/registry`. The five existing seed templates are NOT retrofit; their boilerplate-overlap language ships unchanged for now. Reasoning: prompt regressions are hard to unit-test, and the audit ranked R4 low-severity. Future seed edits land in the shared constant; existing seeds migrate on the next commit that already touches them for a behaviour reason.

### R5 — Tag canonicalisation isn't running on briefings or synthesis  *(severity: medium · **status: re-scoped**)*

`canonicalizeTags()` is called only in `generatePage.ts`. `briefing.ts`, `synthesizePages` (synthesis), `tagDigest.ts` and the digest email path emit tags that go straight onto pages without passing through the canonical-mapping step. So a synthesis page can end up tagged `job-postings` while the rest of the corpus has been consolidated to `job-listings` — defeating the whole point of the registry the user manages in Settings → Tags.

**Suggested resolution:** Move the canonicalisation call out of `generatePage` and into a shared helper that every surface that writes `Page.tags` calls. Three sites to update; ten lines each.

**Resolution (commit `fe0c4d8`):** Re-scoped after closer reading. Briefing pages emit hard-coded `['briefing', periodTag]` tags; synthesis pages emit `['synthesis']`; tag-digest writes don't emit tags at all. Canonicalisation is therefore a no-op on those surfaces today. The real gap was entity extraction (G1, addressed) — briefings now run `runPostWriteEntityExtraction`. If a future change has briefings/synthesis emit user-style tags, hoist the canonicalisation call alongside it.

### R6 — Multiple "stuff I don't want to read by default" surfaces  *(severity: low · **status: skipped**)*

`/quarantine`, `/promotions`, and `Settings → Spam` are three separate surfaces for hiding low-value content. The flags on `Page.flags` (`hasLikelySpam`, `hasMassMailing`, `userMarkedSpam`, `autoQuarantined`, `isPromotional`) are read by all three. The user has to learn three places to look.

**Suggested resolution:** Not urgent. Keep the routes (they let bulk actions stay scoped), but add a single "Hidden content" entry point on the sidebar that shows the totals across all three buckets, with quick filters for each.

**Status: skipped.** UX consolidation, not a code redundancy. Worth flagging on the next dedicated UX pass; the audit itself flagged it as low-impact.

### R7 — Three discovery / curation entry points  *(severity: low · **status: skipped**)*

`Streams` (smart views), `Codex` (saved searches), and `featuredTags` (user-pinned tags on the home page) all serve "curated entry points." They're conceptually distinct (smart views are system-built, codex is user-built, featured tags are pinned categories) but the user has to map all three to a mental model of "ways I jump into my corpus."

**Suggested resolution:** Long-term UX call, not a code redundancy. Worth flagging on the next UX pass.

**Status: skipped.** Same reasoning as R6.

---

## 4. Gap findings

### G1 — Briefing/synthesis/digest pages don't get entity extraction  *(severity: medium · **status: partial**)*

`extractEntitiesFromPage` (the new one) is wired into `generatePage` only. So the entity auto-linker and `/n/<key>` routes work on email-derived wiki pages but **not** on briefings, synthesis pages, or tag-digest section bodies. A briefing that talks about "Bill Walsh" emits no entity link.

**Fix:** Same shape as R5 — move post-persist extraction into a shared helper that every page-write surface calls. Costs one LLM call per write on those surfaces; makes the linker behaviour uniform.

**Resolution (commit `fe0c4d8`, partial):** `runPostWriteEntityExtraction` lives in `apps/worker/src/services/extractEntities.ts`. Briefings now call it. Synthesis (which lives in the API process, not the worker) is **not** wired; doing so cleanly needs either a new BullMQ queue or moving extraction code into a shared package. Logged as follow-up; user-curated synthesis is rare enough that it's acceptable to defer.

### G2 — Daydream sweeper doesn't pick up linker-extracted entities  *(severity: medium · **status: resolved**)*

The new `Page.entities[]` data isn't fed into `Page.daydreamSubjects[]`. The daydream sweeper queries pages with non-empty `daydreamSubjects` to enrich; for a page where only the new extractor ran, the sweeper sees nothing to research even though entities are present. Result: the "Background" card on `/n/<key>` stays empty until the user clicks "Daydream now" by hand, even though the daydream system knows how to research entities.

**Fix:** When `runEntityExtraction` writes `Page.entities[]`, also append `{kind: 'entity', subjectKey: normaliseSubjectKey(displayName)}` to `Page.daydreamSubjects[]` (deduped against existing entries). One-line addition; closes the loop.

**Resolution (commit `fe0c4d8`):** Done in `runPostWriteEntityExtraction`. Capped at 24 subjects per page so a 30-entity page can't blow up the sweeper's working set.

### G3 — No way to add an entity manually  *(severity: low · **status: resolved**)*

The Settings → Entities surface lets you edit, merge, rename, delete — but there's no "Create entity" button. Entities only come from LLM extraction. If the model misses "Bill Walsh" on every page that mentions him, the user can't add him.

**Fix:** Add a "New entity" form to Settings → Entities. Trivial: POST to a new `POST /api/entities` route that just upserts.

**Resolution (commit `e9c77f1`):** `POST /api/entities` accepts `{displayName, type, aliases?}`, returns 409 on key collision. Settings → Entities surfaces a "New entity" form.

### G4 — Idle-logout is client-side only; JWT access TTL outlives it  *(severity: medium · **status: resolved**)*

`VITE_IDLE_TIMEOUT_MINUTES` triggers a logout call from the SPA, which clears the refresh-cookie. But the access JWT (15-minute TTL) stays valid wherever it's been captured — a stolen token survives idle logout. The original `06-auth-and-security.md` plan called for both pieces.

**Fix:** Server-side last-activity tracking on every authenticated request. Reject when `(now - lastActivity) > IDLE_TIMEOUT`. Either via Redis (one write per request, fast) or a `User.lastActivityAt` field with a low write rate (only update once per N seconds). Pair with the existing client-side timer for UX symmetry.

**Resolution (commit `fe0c4d8`):** New `IDLE_TIMEOUT_MINUTES` env var (default 5). `requireAuth` middleware reads/writes per-user lastActivity in Redis with a 5s write throttle. Stale → 401 `session_idle_timeout`. login / register / refresh seed the timestamp; logout clears it. Plan doc at `.devlogs/plans/14-idle-logout.md`.

### G5 — No worker tests, no e2e tests  *(severity: medium · **status: partial**)*

The test suite is `pnpm --filter @rose/api test` — 41 tests. The worker has zero unit tests, and there's no Playwright surface despite the original plan calling for it. Worker bugs (the BullMQ jobId `:` collision, the merge-action `addToSet`-on-everything bug, the recent "unknown source" bug) all shipped because no automated test caught them.

**Fix:** A worker `vitest` suite that exercises at least the assignment ladder, the merge-detection short-circuits, and the tag-canonicalisation passthrough fallback. Doesn't need e2e — unit-level tests against in-memory Mongo (`mongodb-memory-server`) would have caught every recent worker regression.

**Resolution (commit `e9c77f1`, partial):** vitest scaffold in apps/worker with 21 pure-function unit tests across `pageAssignment` (`isAutomatedSender`, `isSpecificTopic`, `cosine`), `extractPlaces` (`hashContent`), and the new `lib/sourceLabel` (the helpers behind the recent "unknown source" bug). e2e Playwright not added — leaving as a separate gap; if shipped it'd cover the golden path login → upload .eml → page renders → search hits.

### G6 — Entity-merge orphans daydream notes  *(severity: low · **status: resolved**)*

When `POST /api/entities/:key/merge` deletes the source entity, any DaydreamNote with `kind: 'entity'` and `subjectKey: <source displayName>` becomes orphaned (the page-list view at `/n/<target>` will never show it because the lookup uses `target`'s displayName). Same problem on Settings → Tags merge for tag-keyed daydream notes (`kind: 'tag'`).

**Fix:** During merge, also `DaydreamNote.deleteMany({ kind, subjectKey: sourceDisplay })` — or rewrite to point at the target. Trivial.

**Resolution (commit `fe0c4d8`):** Entity merge / delete and tag merge / delete now `DaydreamNote.deleteOne` the orphaned row keyed on the source's displayName-derived (or kebab-derived for tags) subjectKey.

### G7 — No rate limiting on most authenticated endpoints  *(severity: medium · **status: resolved**)*

The original `06-auth-and-security.md` plan listed `express-rate-limit` as required. It's installed and used on `/api/auth/*`. It's not used on, say, `/api/pages/:id/daydream` (which we just rate-limited in-memory by hand) or `/api/search` (which can be expensive). The fixed in-memory rate limit on Daydream Now is per-process; multiple worker dynos would not share the limit.

**Fix:** Replace the in-memory map with a Redis-backed limiter (the package supports it) and apply globally via a middleware tier with stricter limits on expensive routes.

**Resolution (commit `fe0c4d8`):** `rate-limit-redis` adapter swaps the default in-memory store on authLimiter / apiLimiter / webhookLimiter so a horizontally-scaled API stays under one quota. New `llmForceLimiter` (5/min, Redis-backed) replaces the per-route in-memory `Map` ad-hoc limiters; both `/api/pages/:id/daydream` and `/api/entities/:key/daydream` now share the same quota.

### G8 — Page export doesn't include entity / tag-canonical / merge-suggestion data  *(severity: low · **status: resolved**)*

`apps/api/src/routes/dataIo.ts` exports user data; it covers user settings, saved searches, spam policy, featured tags. It doesn't export `Entity`, `TagCanonical`, or `Page.mergeSuggestions[]`. A user who sets up curated entity + tag taxonomies and then exports loses that work.

**Fix:** Add the three collections to the export payload and the import path.

**Resolution (commit `e9c77f1`):** dataIo's export/import now covers Entity + TagCanonical. `Page.mergeSuggestions[]` rides along on the existing `pages` payload (was already-included, just untagged in the audit). `EXPORT_VERSION` bumped to 2; v1 imports still accepted (the new collections come up empty).

### G9 — Briefings/synthesis pages skip merge-detection  *(severity: low · **status: skipped**)*

`mergeDetect.ts` excludes `groupingMode: { $nin: ['briefing', 'synthesis'] }`. Two briefings on the same week would never get flagged as duplicates. That's intentional — they're consolidations themselves — but the flip side is that nothing prevents a regen from spawning a duplicate briefing.

**Fix:** Add a per-`groupingMode` uniqueness check upstream (in the briefing scheduler) rather than relying on merge-detection.

**Status: skipped.** Edge case; the briefing scheduler is keyed by week/month already, so a duplicate would require two scheduler ticks within the same period — which itself implies a different bug. Logged but not addressed in this pass.

### G10 — No PWA manifest despite the service worker  *(severity: low · **status: stale audit**)*

`apps/web/public/app-sw.js` exists and registers from `main.tsx`. There's no `manifest.json`, no install prompt, no `apple-touch-icon`. So Rose installs as a regular browser-bookmarked page, not a PWA. Original plan promised "PWA only if time permits" — clearly didn't.

**Fix:** Author `manifest.json` + add the standard meta tags + a small icon set. ~30 minutes of work, uniformly nice for self-hosted users on phones.

**Status: audit was stale.** `apps/web/public/manifest.webmanifest` exists, `apps/web/index.html` already has `<link rel="manifest">`, `apple-touch-icon`, `theme-color`, and `apple-mobile-web-app-*` tags. The original audit didn't grep `apps/web/public/`. No action needed.

---

## 5. Drift from the original plan files

A few specific things have either drifted from the plan or shipped without updating the plan doc:

- **Plan 11 (Maps)** — fully shipped. Plan doc accurate.
- **Plan 09 (Daydream)** — fully shipped. Plan doc accurate.
- **Plan 08 (Operational QoL)** — partial: includes "rate limiting", "idle logout (server-side)", "PWA manifest" — none shipped server-side.
- **Plan 07 (AI capabilities)** — superset of what's shipped: cross-sender consolidation (✓), tag canonicalisation (✓), entity extraction (✓), merge detection (✓), daydream (✓). Several smaller items (per-page provenance graph, citation back-references, "rephrase this paragraph") not shipped.
- **Plans 1–6** — all marked done in the plan README; spot-check matches code.
- **Two new features shipped without a plan file**:
  - Settings → Tags (tag canonicalisation surface)
  - Settings → Entities + the linker-based entity system
  - Idle-logout
  - Cross-sender topic consolidation + incremental generation
  - Merge detection + dismissal

The unwritten plans aren't a code problem, but they're a **documentation debt** — a future contributor reading the .devlogs would think the audit shipped before linker entities or tag canonicalisation, when in fact those are central to the page-write pipeline now.

**Suggested resolution:** Promote the four unwritten features to formal plan docs (12-tags-and-entities.md, 13-cross-sender-consolidation.md, 14-idle-logout.md). The implementation already exists; the plan doc is just descriptive of it.

**Resolution:** Done.
  - `.devlogs/plans/12-tags-and-entities.md`
  - `.devlogs/plans/13-cross-sender-consolidation.md`
  - `.devlogs/plans/14-idle-logout.md`

Each is marked `Status: Shipped` in the heading; `plans/README.md` table now lists them with the `(✓ shipped)` annotation.

---

## 6. Recommended priorities

The following ranking is opinion, not commitment. Sorted by user-visible impact divided by code complexity:

1. **G2 + G1 — wire Page.entities[] into the daydream queue and into briefing / synthesis writes.** The new entity system is half-shipped: extraction + auto-linking work, but the Background brief on `/n/<key>` stays empty for most entities until the user clicks Daydream Now, and briefings don't get auto-linked. Both are small fixes; both close a clearly visible UX gap.

2. **R1 — collapse the two entity extractors.** Saves an LLM call per page write, eliminates the same-name divergence. Medium-sized refactor (the daydream processor needs to read from `Page.entities[]` instead of calling its own extractor).

3. **R5 — make tag canonicalisation universal.** Otherwise the user's curated taxonomy in Settings → Tags doesn't apply to half their content.

4. **G4 + G7 — server-side idle logout and Redis-backed rate limiting.** Both were in the original security plan and never shipped. Both are real (small) attack-surface gaps.

5. **G5 — worker tests.** Every recent worker bug we caught (BullMQ jobId, merge `addToSet`, daydream "unknown source") would have been caught by a unit test. The harness already has `mongodb-memory-server` patterns elsewhere; setting up `pnpm --filter @rose/worker test` is half a day.

6. **G3, G6, G8 — entity-management ergonomics.** Manual create, merge cleans up daydream notes, exports cover the new collections. Each is small; together they make the Settings → Entities surface feel finished rather than functional.

The remaining items (R2, R3, R4, R6, R7, G9, G10) are real but low-impact. They're worth keeping on the backlog but won't pay back enough to prioritise above the above.

---

## 7. What this audit deliberately doesn't cover

- **Performance.** Nothing was profiled. The page generate path is the obvious hot loop; whether the post-persist chain is acceptable in practice depends on workload shape.
- **Security beyond the gaps already flagged.** The `06-auth-and-security.md` plan should be its own audit pass.
- **Per-LLM-provider behaviour.** All seed prompts assume a model that follows JSON-mode reliably. Smaller open models drift; that's a real gap but lives in `03-llm-and-prompts.md`'s territory.
- **Mobile UX.** Beyond G10 (PWA), responsive layout was assumed but never verified post-Tier-A maps and the entities system.

These deserve their own audits.

---

## 8. Resolution roll-up

| ID | Title | Severity | Status | Commit |
|---|---|---|---|---|
| R1 | Two `extractEntitiesFromPage` impls | medium | resolved | `fe0c4d8` |
| R2 | Page.threadKey legacy field | low | resolved | `e9c77f1` |
| R3 | Place data in three places | low | deferred | — |
| R4 | News-prose duplication | low | partial (constant exported) | `e9c77f1` |
| R5 | Tag canonicalisation only on `generatePage` | medium | re-scoped (no-op on briefings/synthesis) | `fe0c4d8` |
| R6 | Multiple "hide content" surfaces | low | skipped (UX) | — |
| R7 | Three discovery entry points | low | skipped (UX) | — |
| G1 | Briefings/synthesis skip entity extraction | medium | partial (briefings done; synthesis deferred) | `fe0c4d8` |
| G2 | Linker entities → daydream subjects | medium | resolved | `fe0c4d8` |
| G3 | Manual entity create | low | resolved | `e9c77f1` |
| G4 | Server-side idle logout | medium | resolved | `fe0c4d8` |
| G5 | No worker / e2e tests | medium | partial (worker unit tests; e2e deferred) | `e9c77f1` |
| G6 | Entity merge orphans daydream notes | low | resolved | `fe0c4d8` |
| G7 | No global rate limiting | medium | resolved | `fe0c4d8` |
| G8 | Export skips new collections | low | resolved | `e9c77f1` |
| G9 | Briefings skip merge-detect | low | skipped (edge case) | — |
| G10 | No PWA manifest | low | stale audit (already shipped) | — |
| Plan-debt | New features lack plan docs | — | resolved (12, 13, 14) | `e9c77f1` |

**Two commits did the work.** `fe0c4d8` covers entity flow, idle logout, rate limiting (R1 / R5 / G2 / G4 / G6 / G7 + G1 partial). `e9c77f1` covers tests, manual entity, export, threadKey migration, news-prose constant, plan docs (R2 / R4 / G3 / G5 / G8).

**Five findings deferred or skipped** with reasoning:
- **R3** (place-into-Entity refactor) — too invasive for low payoff.
- **R6 / R7** (UX consolidation) — not code-side; future UX pass.
- **G1 (synthesis half)** — needs cross-process queue; user-curated synthesis is rare.
- **G5 (e2e half)** — worker unit tests cover the recent regression class; Playwright is its own scope.
- **G9** (briefing uniqueness) — edge case the briefing scheduler shouldn't produce in practice.

**Test count** went from 41 (api-only) to 62 (api + worker).
