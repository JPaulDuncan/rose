# 13 — DRY refactor audit

**Date:** 2026-05-06.
**Status:** Descriptive. Lists confirmed code duplications and the recommended refactors. No code changes are made by this document — it's a backlog with file:line references so any single item can be picked up independently.

This is the second audit in this devlog series. The first (`12-feature-audit.md`) catalogued feature-level redundancy and gaps. This one catalogues code-level repetition: same logic copy-pasted into multiple files, or near-identical patterns that could share a helper.

---

## 1. Summary

The codebase is in good shape. The duplications fall into three buckets:

- **Tier 1 — should fix.** Pure-function copies that can be unified with zero behavioural risk. Three items: `cosine`, daydream subject-key, slug uniqueness.
- **Tier 2 — worth fixing once a related commit lands.** Patterns where the duplication has a small but real cost (the Settings edit-row, the first-time egress banner, the `bumpAndCheckCap` counter). Won't pay back enough to do as a dedicated commit, but if the next change to either site requires touching it anyway, fold them.
- **Tier 3 — leave alone.** Idiomatic patterns (Mongoose `.lean()` + cast) and repetition that's small enough to not warrant the abstraction tax. Listed for completeness so future contributors don't waste cycles "fixing" them.

Total: 11 confirmed duplications, 3 of which warrant a dedicated cleanup commit. Estimated effort for Tier 1 is 30 minutes.

---

## 2. Tier 1 — should fix

### D1 — `cosine` similarity copied three times  *(severity: high)*

Three identical implementations of `cosine(a: number[], b: number[]) → number`:

| Site | Visibility |
|---|---|
| `apps/worker/src/services/pageAssignment.ts:52` | exported (was made public during the worker test scaffolding) |
| `apps/worker/src/services/mergeDetect.ts:32` | private |
| `apps/worker/src/processors/briefing.ts:68` | private |

Each handles the same edge cases (length mismatch, empty inputs, zero norm). The shape is short enough to copy without thinking, but the fact that three independent copies exist is a smell — the next bug in any one (overflow on a sparse vector? NaN handling?) won't propagate.

**Refactor:** Promote `pageAssignment.cosine` to `apps/worker/src/lib/vec.ts` and have `mergeDetect.ts` + `briefing.ts` import it. The existing test in `apps/worker/src/__tests__/pageAssignment.test.ts` migrates with the export. Net diff: -30 lines.

### D2 — daydream subject-key normalisation copied  *(severity: medium)*

The "displayName → daydream subjectKey" transform (`trim → lowercase → collapse whitespace`) lives in two places:

- `apps/worker/src/lib/sourceLabel.ts:27` — `normaliseSubjectKey()`, exported.
- `apps/api/src/routes/entities.ts:16` — `daydreamSubjectKey()`, private.

Plus two **inline** copies of the same transform inside `apps/api/src/routes/entities.ts:429–432` (entity merge cleanup) and `:530–533` (entity delete cleanup). The audit found those when grepping for `\.trim\(\)\.toLowerCase\(\)\.replace.*\\s\+`.

**Refactor:** Move `normaliseSubjectKey` to `packages/db/src/models/Entity.ts` (same package as `normalizeTagKey`, `titleCaseTag`) so both worker and api can import without crossing the worker boundary. Then replace the four call sites. Net diff: -15 lines.

### D3 — slug uniqueness loops copied  *(severity: medium)*

`uniqueSlug` exists in `apps/api/src/services/wiki.ts:6` (exported, uses `slugify`). `uniqueSlugForUser` is a private duplicate inside `apps/worker/src/processors/briefing.ts:151`. Same find-and-bump-suffix loop.

A third inline variant lives in the new-page branch of `apps/worker/src/processors/generatePage.ts` (where `n` increments while the slug already exists).

**Refactor:** Lift to a small `apps/worker/src/lib/slugUnique.ts` (or move to `@rose/db` so api + worker both import). Each call site becomes one line. Net diff: -25 lines.

---

## 3. Tier 2 — fold opportunistically

These are real duplications, but the abstraction has its own cost (parameterisation, type plumbing, or genuine difference in semantics) — and the audit's first principle is "don't abstract before the third copy appears with the same shape." For these, the third copy already exists; the patch is bigger than just renaming a function. Worth doing the next time a related commit touches either side.

### D4 — Settings → Tags / Entities inline-edit panels  *(severity: high in absolute LOC; medium in priority)*

`apps/web/src/routes/settings/Tags.tsx` lines 155–410 and `apps/web/src/routes/settings/Entities.tsx` lines 266–522 share roughly **70% structural overlap**:

- Same edit-vs-display dual-mode row.
- Same comma-separated-aliases input + normaliser.
- Same Save / Cancel / Rename / Merge / Delete button cluster.
- Same confirm-dialog wording template.
- Same mutations + invalidation pattern.

**The shape:**

```
EditableRowPanel<T extends { canonicalKey: string; displayName: string; aliases: string[] }>
```

with per-callsite slots for the type select (Tags has none; Entities has 4 options) and the API base path.

**Refactor:** Extract to `apps/web/src/components/CanonicalEditor.tsx`. Both Settings tabs become ~80 lines each instead of ~350. Worth it next time either tab gets a feature added (which will be another fork in the road if not unified now).

**Reason to defer:** The two pages have small but real divergences (Entities has type, Tags doesn't; placeholder copy; query keys). A naïve unification would force render-prop or slot complexity that costs as much as it saves. Worth a thoughtful design pass — not a fast win.

### D5 — First-time egress acknowledgement banner  *(severity: medium)*

`apps/web/src/routes/settings/Daydream.tsx:123–148` and `apps/web/src/routes/settings/Maps.tsx:89–123` both render the same amber banner with the same conditional (`form.enabled && !settings?.enabled && !acceptedExplainer`):

```jsx
<div className="rounded border border-amber-200 bg-amber-50 p-3 …">
  <div className="font-medium">Heads-up before you enable</div>
  <ul className="mt-1 list-disc pl-4">{children}</ul>
  <button onClick={onAccept}>Got it</button>
</div>
```

Only the bullet contents differ.

**Refactor:** Extract to `apps/web/src/components/EgressAcknowledgement.tsx` taking a `wantsToEnable: boolean`, `onAccept: () => void`, and `children` (the bullets). The `wantsToEnable` flag can live in the component as a `useState` if we accept the same first-time-only semantics across surfaces. Net diff: −60 lines per page that adopts.

**Reason to do soon:** Both routes have stable APIs (the Daydream / Maps settings shapes are unlikely to change in lockstep). Low coupling, high mechanical reuse — the next "opt-in feature with egress" (federated chat? external sender enrichment?) will repeat the same banner.

### D6 — `bumpAndCheckCap` copied between daydream + describeImages  *(severity: medium)*

`apps/worker/src/processors/daydream.ts:83` defines `bumpAndCheckCap(userId, cap): boolean` — an in-process daily-call counter for LLM-cost gating. `apps/worker/src/services/describeImages.ts:17` has an **exact duplicate** with a different `Map`.

Both maps are per-process, so a multi-worker deployment would let a user blow past the cap N times where N = number of workers. The fix path therefore touches both or neither.

**Refactor:** Move to `apps/worker/src/lib/dailyCap.ts` keyed on `(userId, kind)` so the same helper backs both LLM-call surfaces. Bonus path: back it with Redis the same way `llmForceLimiter` is now (avoids the multi-worker leak). Net diff: a refactor + a real bug fix in the same change.

### D7 — `dataIo` import path repeats per-collection ID-remap  *(severity: medium)*

`apps/api/src/routes/dataIo.ts:205–279` has roughly the same `.map(x => ({ ...x, _id: new Types.ObjectId(), userId }))` pattern repeated for ~7 collections, plus `Model.insertMany(arr, { ordered: false })` calls.

**Refactor:** A small `importCollection<TModel>(rawList, { userId, remap, model })` helper eats roughly 60 lines. The function signature has to handle a few collection-specific quirks (`Page.userId`, `Conversation.messages` cross-references, `Event.pageId` remap), so it isn't a pure one-liner — but the boilerplate is mostly there.

**Reason to defer:** Import is a low-traffic code path. The existing repetition is annoying but not error-prone (each block is short enough to grep). Worth folding when either the export schema bumps version (3+) or a new per-user collection lands.

---

## 4. Tier 3 — leave alone

Listed so future contributors don't try to "fix" these:

### N1 — Mongoose `.lean()` casts everywhere

177 call sites across the codebase use the pattern `await Model.find(...).lean() as unknown as TArrayShape`. This is idiomatic for Mongoose's typed queries when `InferSchemaType` doesn't carry through `.lean()` perfectly. Centralising would lose type inference. **Don't unify.**

### N2 — `normalizeTagKey` vs `normalizePlaceKey` look similar but aren't

`packages/db/src/models/TagCanonical.ts:9` produces kebab keys (`Job Listings → job-listings`). `apps/worker/src/lib/geocode.ts:89` collapses whitespace only (`Times Square → times square`). They serve different purposes — kebab is for URL slugs / `Page.tags` storage; the place-key is for in-memory dedup. The names are misleading but the divergence is intentional. **Don't unify.** Consider renaming `normalizePlaceKey` to `normalizePlaceCacheKey` to make the difference obvious — that's a Tier 1 rename if anyone touches the file.

### N3 — `titleCaseTag` is already centralised

The audit candidate "title-casing display names" came up because we have inline title-casing for entities in places. On inspection, **all of them already import `titleCaseTag`** from `@rose/db`. No duplication to fix.

### N4 — In-memory rate-limit maps are gone

The legacy `Map<userId, number[]>` pattern has been fully replaced by the Redis-backed `llmForceLimiter` middleware. No leftovers to clean up.

### N5 — Snapshot + `$pull` + `$addToSet` pattern

`apps/api/src/routes/tags.ts` (merge: 213–223; rename: 299–311) and `apps/api/src/routes/entities.ts` (merge: 380–419, with arrayFilters + dedupe pass) share the same defensive pattern, but the two implementations diverge meaningfully:

- Tags merge does a simple two-step (snapshot ids → `$pull` source → `$addToSet` target).
- Entities merge does three steps (rewrite via arrayFilters → `$pull` target to dedupe → `$addToSet` target back).

The Entities approach is safer (handles pages that already had both source and target) but the asymmetry is intentional: tags can't have type drift, entities can. **Don't unify** without first deciding on one canonical safe-rewrite shape and applying it both directions. That's a bigger refactor than the duplication is worth fixing.

---

## 5. Recommended order of operations

1. **D1 + D2 + D3 in one commit.** Pure refactors, ~70 lines net deletion. ~30 minutes. Add a unit test for each newly-extracted helper while at it.
2. **D6 (`bumpAndCheckCap`).** Same commit or the next one. Low risk, real value (closes the multi-worker leak if you also Redis-back it).
3. **D5 (egress banner).** Worth doing whenever the next opt-in-feature settings tab is built. Standalone is fine too.
4. **D4 (Settings edit-row).** Defer until the next time either Tags or Entities settings page gets a feature added.
5. **D7 (dataIo remap).** Defer until import schema needs version 3.

Combined: **Tier 1 alone** would land as a single 200-line commit (mostly deletions) with 30 lines of new test code. **Tiers 1 + 2 together** would be a more substantial 400-line refactor over 2–3 commits.

---

## 6. What this audit deliberately doesn't cover

- **Worker processor scaffolding.** Every processor file ends with `worker.on('failed', ...)` + `worker.on('error', ...)` boilerplate. That's ~5 lines × 19 processors = ~95 lines of handler wire-up. A `mountStandardWorkerHandlers(worker, name)` helper would shave ~70 lines but at the cost of one more layer to read through. Subjective; left to the next operator-experience audit.
- **CSS class duplications.** Many Tailwind utility runs repeat. A class extractor (`@apply` or `clsx` constants) would help. Out of scope — that's a styling audit.
- **Test fixture duplication.** The existing 41 + 21 tests are mostly pure-function unit tests with minimal fixtures, so this isn't a problem yet. Will be once Mongo-backed integration tests land.

---

## 7. Closing note

DRY is a tool, not a target. Every "extract this" suggestion above has been weighed against the cost of having to read through one more layer of indirection. The Tier 3 section is as load-bearing as the Tier 1 section: the goal is to fix the duplications worth fixing and explicitly *not* fix the rest, so future contributors aren't tempted to abstract away patterns that pay their own way.
