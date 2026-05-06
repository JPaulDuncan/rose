# 12 — Feature audit: redundancy + gaps

**Date:** 2026-05-06.
**Status:** Descriptive. Captures the application as it stands right now after roughly a dozen feature commits since the original plan files were written. No code changes are made by this document — the goal is to surface real findings that downstream work can prioritise.

This is a snapshot, not a roadmap. The Recommended priorities section at the end is opinion, not commitment.

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

### R1 — Two `extractEntitiesFromPage` implementations  *(severity: medium)*

`apps/worker/src/services/extractEntities.ts` (new, linker-driven) and `apps/worker/src/lib/discovery/entityExtraction.ts` (older, daydream-internal) both export a function with the **same name** and operate on the same input but with **different output schemas**:

| | New (`services/`) | Old (`lib/discovery/`) |
|---|---|---|
| Types | `person` / `work` / `organization` | `person` / `org` / `place` / `work` / `concept` / `other` |
| Aliases | yes | no |
| Persistence | `Page.entities[]` + `Entity` collection | `daydreamSubjects[]` only |
| Caller | `generatePage` post-persist | `daydream` processor |

The two coexist because each grew up to feed a different surface. The cost is real: every page write currently makes **two LLM extraction calls covering the same prose** (one for the linker registry, one for the daydream subject queue). The schemas don't even agree on the type set — "place" is a category in the legacy extractor but lives in `Page.places[]` for the new one.

**Suggested resolution:** Make the new extractor authoritative. The daydream processor reads `Page.entities[]` directly (already populated) instead of running its own pass; `daydreamSubjects[]` becomes a derived view over `entities[] + tags[] + topics[]` rather than an independent extraction. Drop `lib/discovery/entityExtraction.ts`. Saves ~1 LLM call per page generation; closes a confusing same-name divergence.

### R2 — `Page.threadKey` (singular, legacy) vs `Page.threadKeys[]` (plural, current)  *(severity: low)*

The `threadKey` String field is documented as "kept for migration." It's still being read by `pageAssignment.ts`:

```ts
$or: [{ threadKeys: email.threadKey }, { threadKey: email.threadKey }]
```

Risk: low — the dual lookup is correct. But every new write adds to `threadKeys[]` only; old rows that still carry `threadKey` get ignored by future logic that reads only the array form, and we've already shipped that pattern several times.

**Suggested resolution:** A one-time migration that copies `threadKey` → `threadKeys[]` and clears the legacy field. Then drop the field from the schema.

### R3 — Place data lives in three places  *(severity: low)*

For a place mention like "Brooklyn":

| Field | What it stores | Owner |
|---|---|---|
| `Page.places[]` | `{name, normKey, lat, lon, displayName, geocodedAt, failed}` | extraction + geocoding |
| `Page.entities[]` | NOT populated (extractor explicitly skips places) | linker |
| `Entity` collection | NOT populated | linker upserter |

The `/n/<key>` route handles places by special-casing — joining on `places.normKey` instead of `entities.normKey`. The auto-linker also has place-aware code paths in `Page.tsx`. Works, but the special-casing is sprawl: the `EntityResponse` type has `placeCoords`, `Entity.tsx` has `place` as a fourth type variant only used for the map, and the entity directory at `/api/entities` doesn't even know about places.

**Suggested resolution:** Add `kind: 'place'` to `Entity` model and write a place row alongside the geocode. Then `Entity.tsx` and `/api/entities` become uniform; the map inset is the only place-specific render. The place-extraction service can write both `Page.places[]` (with lat/lon) and the Entity row (without).

### R4 — Several "summary"-shaped LLM scopes overlap stylistically  *(severity: low)*

Five seed scopes write news-style narrative summaries: `generate.wiki-page`, `consolidate.topic`, `briefing.weekly`, `synthesis.meta`, `tag-digest.daily`. The explorer flagged them as "not overlapping — different aggregation levels," which is true at the data-model level. But the prompts share **a lot** of duplicated language ("inverted-pyramid", "no filler", "cite each claim", "don't invent"). Any tweak to voice or grounding rules has to be made in five places.

**Suggested resolution:** Extract a shared `SYSTEM_PROMPT_NEWS_PROSE` constant from `@rose/llm` and prepend it to each of these scopes. Each seed retains only its surface-specific instructions (what the inputs are, what the JSON shape is). Reduces drift; future style changes happen once.

### R5 — Tag canonicalisation isn't running on briefings or synthesis  *(severity: medium)*

`canonicalizeTags()` is called only in `generatePage.ts`. `briefing.ts`, `synthesizePages` (synthesis), `tagDigest.ts` and the digest email path emit tags that go straight onto pages without passing through the canonical-mapping step. So a synthesis page can end up tagged `job-postings` while the rest of the corpus has been consolidated to `job-listings` — defeating the whole point of the registry the user manages in Settings → Tags.

**Suggested resolution:** Move the canonicalisation call out of `generatePage` and into a shared helper that every surface that writes `Page.tags` calls. Three sites to update; ten lines each.

### R6 — Multiple "stuff I don't want to read by default" surfaces  *(severity: low)*

`/quarantine`, `/promotions`, and `Settings → Spam` are three separate surfaces for hiding low-value content. The flags on `Page.flags` (`hasLikelySpam`, `hasMassMailing`, `userMarkedSpam`, `autoQuarantined`, `isPromotional`) are read by all three. The user has to learn three places to look.

**Suggested resolution:** Not urgent. Keep the routes (they let bulk actions stay scoped), but add a single "Hidden content" entry point on the sidebar that shows the totals across all three buckets, with quick filters for each.

### R7 — Three discovery / curation entry points  *(severity: low)*

`Streams` (smart views), `Codex` (saved searches), and `featuredTags` (user-pinned tags on the home page) all serve "curated entry points." They're conceptually distinct (smart views are system-built, codex is user-built, featured tags are pinned categories) but the user has to map all three to a mental model of "ways I jump into my corpus."

**Suggested resolution:** Long-term UX call, not a code redundancy. Worth flagging on the next UX pass.

---

## 4. Gap findings

### G1 — Briefing/synthesis/digest pages don't get entity extraction  *(severity: medium)*

`extractEntitiesFromPage` (the new one) is wired into `generatePage` only. So the entity auto-linker and `/n/<key>` routes work on email-derived wiki pages but **not** on briefings, synthesis pages, or tag-digest section bodies. A briefing that talks about "Bill Walsh" emits no entity link.

**Fix:** Same shape as R5 — move post-persist extraction into a shared helper that every page-write surface calls. Costs one LLM call per write on those surfaces; makes the linker behaviour uniform.

### G2 — Daydream sweeper doesn't pick up linker-extracted entities  *(severity: medium)*

The new `Page.entities[]` data isn't fed into `Page.daydreamSubjects[]`. The daydream sweeper queries pages with non-empty `daydreamSubjects` to enrich; for a page where only the new extractor ran, the sweeper sees nothing to research even though entities are present. Result: the "Background" card on `/n/<key>` stays empty until the user clicks "Daydream now" by hand, even though the daydream system knows how to research entities.

**Fix:** When `runEntityExtraction` writes `Page.entities[]`, also append `{kind: 'entity', subjectKey: normaliseSubjectKey(displayName)}` to `Page.daydreamSubjects[]` (deduped against existing entries). One-line addition; closes the loop.

### G3 — No way to add an entity manually  *(severity: low)*

The Settings → Entities surface lets you edit, merge, rename, delete — but there's no "Create entity" button. Entities only come from LLM extraction. If the model misses "Bill Walsh" on every page that mentions him, the user can't add him.

**Fix:** Add a "New entity" form to Settings → Entities. Trivial: POST to a new `POST /api/entities` route that just upserts.

### G4 — Idle-logout is client-side only; JWT access TTL outlives it  *(severity: medium)*

`VITE_IDLE_TIMEOUT_MINUTES` triggers a logout call from the SPA, which clears the refresh-cookie. But the access JWT (15-minute TTL) stays valid wherever it's been captured — a stolen token survives idle logout. The original `06-auth-and-security.md` plan called for both pieces.

**Fix:** Server-side last-activity tracking on every authenticated request. Reject when `(now - lastActivity) > IDLE_TIMEOUT`. Either via Redis (one write per request, fast) or a `User.lastActivityAt` field with a low write rate (only update once per N seconds). Pair with the existing client-side timer for UX symmetry.

### G5 — No worker tests, no e2e tests  *(severity: medium)*

The test suite is `pnpm --filter @rose/api test` — 41 tests. The worker has zero unit tests, and there's no Playwright surface despite the original plan calling for it. Worker bugs (the BullMQ jobId `:` collision, the merge-action `addToSet`-on-everything bug, the recent "unknown source" bug) all shipped because no automated test caught them.

**Fix:** A worker `vitest` suite that exercises at least the assignment ladder, the merge-detection short-circuits, and the tag-canonicalisation passthrough fallback. Doesn't need e2e — unit-level tests against in-memory Mongo (`mongodb-memory-server`) would have caught every recent worker regression.

### G6 — Entity-merge orphans daydream notes  *(severity: low)*

When `POST /api/entities/:key/merge` deletes the source entity, any DaydreamNote with `kind: 'entity'` and `subjectKey: <source displayName>` becomes orphaned (the page-list view at `/n/<target>` will never show it because the lookup uses `target`'s displayName). Same problem on Settings → Tags merge for tag-keyed daydream notes (`kind: 'tag'`).

**Fix:** During merge, also `DaydreamNote.deleteMany({ kind, subjectKey: sourceDisplay })` — or rewrite to point at the target. Trivial.

### G7 — No rate limiting on most authenticated endpoints  *(severity: medium)*

The original `06-auth-and-security.md` plan listed `express-rate-limit` as required. It's installed and used on `/api/auth/*`. It's not used on, say, `/api/pages/:id/daydream` (which we just rate-limited in-memory by hand) or `/api/search` (which can be expensive). The fixed in-memory rate limit on Daydream Now is per-process; multiple worker dynos would not share the limit.

**Fix:** Replace the in-memory map with a Redis-backed limiter (the package supports it) and apply globally via a middleware tier with stricter limits on expensive routes.

### G8 — Page export doesn't include entity / tag-canonical / merge-suggestion data  *(severity: low)*

`apps/api/src/routes/dataIo.ts` exports user data; it covers user settings, saved searches, spam policy, featured tags. It doesn't export `Entity`, `TagCanonical`, or `Page.mergeSuggestions[]`. A user who sets up curated entity + tag taxonomies and then exports loses that work.

**Fix:** Add the three collections to the export payload and the import path.

### G9 — Briefings/synthesis pages skip merge-detection  *(severity: low)*

`mergeDetect.ts` excludes `groupingMode: { $nin: ['briefing', 'synthesis'] }`. Two briefings on the same week would never get flagged as duplicates. That's intentional — they're consolidations themselves — but the flip side is that nothing prevents a regen from spawning a duplicate briefing.

**Fix:** Add a per-`groupingMode` uniqueness check upstream (in the briefing scheduler) rather than relying on merge-detection.

### G10 — No PWA manifest despite the service worker  *(severity: low)*

`apps/web/public/app-sw.js` exists and registers from `main.tsx`. There's no `manifest.json`, no install prompt, no `apple-touch-icon`. So Rose installs as a regular browser-bookmarked page, not a PWA. Original plan promised "PWA only if time permits" — clearly didn't.

**Fix:** Author `manifest.json` + add the standard meta tags + a small icon set. ~30 minutes of work, uniformly nice for self-hosted users on phones.

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
