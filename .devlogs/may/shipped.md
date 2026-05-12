# May session — shipped

Single-session pass through every item in `todo.md`. Each section
links the relevant commits + lays out the surface area so a future
reader doesn't have to git blame to find the moving parts.

## 1.1 Per-vendor receipt adapters

Schema.org JSON-LD catches the well-templated vendors; per-vendor
parsers now catch Amazon / Apple / USPS too. Receipt extraction
cascade is now:

  1. `parseStructuredReceipt` — schema.org JSON-LD
  2. `tryVendorReceipt(brandKey, html, subject)` — per-vendor regex
  3. LLM fallback

Each stage gates at confidence ≥ 0.7. `ProductPurchase.extractedBy`
gained a `'vendor'` label distinct from `'structured'` and `'llm'`,
and the admin coverage panel splits vendor-coverage out separately.

**Files**
- `packages/email-parser/src/vendors/{amazon,apple,usps,index}.ts`
- `packages/email-parser/src/__tests__/vendors.test.ts` (15 tests)
- `apps/worker/src/services/extractReceipt.ts` (vendor pass + audit)
- `packages/db/src/models/ProductPurchase.ts` (extractedBy enum)
- `apps/api/src/routes/admin.ts`, `apps/web/src/routes/{Product,settings/Admin}.tsx`

## 1.2 Wikidata Q-IDs for persons + places

`Entity.wikidataId` + `.wikidataConfidence` + `.wikidataResolvedAt`.
The resolver's kind dispatch grew `'person'` and `'place'`, with
type-hint regexes calibrated against typical Wikidata descriptions.
Resolution chains into `enrichEntityRelations(userId, entityKey)`,
which fetches SPARQL relations using a new per-kind property map:

  - person: P108 employer, P26 spouse, P19 birthplace,
            P22/P25 parents, P40 child, P3373 sibling
  - place:  P17 country, P131 admin entity

Confirmed triples land in `EntityRelation` with
`wikidataConfirmed: true` so they're visible to every user. The
`/n/<key>` Wikidata badge now renders for all four entity types
because the API surfaces `wikidataId` at the top level of the
response, not just nested under `org`.

**Files**
- `packages/db/src/models/Entity.ts`
- `apps/worker/src/services/{wikidataResolver,wikidataRelations}.ts`
- `apps/worker/src/services/extractEntities.ts` (person chain)
- `apps/worker/src/processors/generatePage.ts` (place chain)
- `apps/api/src/routes/entities.ts`, `apps/web/src/routes/Entity.tsx`

## 1.3 Daydream backfill no longer a no-op

The admin "Daydream" button used to log and exit. It now enqueues
a `kind: 'page'` job onto `rose.daydream` per page, respecting the
three skip gates the sweeper already enforces (user disabled, no
subjects, spam flag). The daydream worker's daily call cap stays
honest because it gates downstream of the queue.

**Files**
- `apps/worker/src/processors/backfill.ts`

## 1.4 Subscription recipe triggers

Two new event kinds — `subscription.created` and
`subscription.renewed` — emit from the subscription extractor's
upsert path. New trigger schemas in `@rose/shared` carry
`serviceContains` + `categories` config; the wizard exposes them
as standalone trigger types.

The dispatcher routes the new kinds through the existing cooldown
+ dedup machinery. Subject key = `sub:<id>:<kind>` so a creation
and a renewal of the same row fire independently.

**Files**
- `packages/shared/src/schemas/recipe.ts`
- `packages/shared/src/lib/recipeMatchers.ts`
- `apps/worker/src/services/extractSubscription.ts`
- `apps/worker/src/processors/recipes.ts`
- `apps/web/src/components/RecipeWizard.tsx`, `apps/web/src/routes/settings/Recipes.tsx`

## 2.1 Test pass

51 new tests across three pure-function suites:

- `apps/api/src/__tests__/ontologyVocab.test.ts` — predicate
  vocabulary regression. Pins keys, subject/object types,
  symmetry, Wikidata URI shapes, and the vocabulary-version date.
- `apps/api/src/__tests__/recipeMatchers.test.ts` — trigger +
  condition matchers, including the new subscription cases and
  the `evaluateRecipe` composite gate.
- `apps/worker/src/__tests__/wikidataResolver.test.ts` — refactor
  lifted the resolver scoring into a pure `scoreWikidataHit`
  helper; tests cover every kind × every confidence tier.

Existing suites still pass: 45 email-parser, 124 worker (16 new),
76 api (35 new).

## 3.1 Triage undo

`u` reverses the most recent reversible action. Each verb owns
its own reverse: archive ↔ unarchive, defer ↔ defer 0h, spam-mark
↔ DELETE spam/sender, block ↔ DELETE spam/block. Up to ten
actions held in a per-component ref. Toasts now include "press u
to undo" so the affordance is discoverable.

Page generation has no clean reverse, so it records no undo
entry. Reply is interactive and outside the undo flow.

**Files**
- `apps/web/src/routes/Triage.tsx`

## 4.1 Page.outboundLinks

`GET /api/pages/:id/lineage`'s inbound query used to regex-scan
every page's `contentMd`. Pages now carry an indexed multikey
`outboundLinks` field (array of slugs) populated at write time;
the lineage endpoint switches to `$in` over the index. New
backfill kind `outbound-links` refreshes the cache on historical
pages. The extractor is a one-screen module with a unit test
covering dedup, ordering, self-exclusion, the 200-link cap, and
the empty / null cases.

**Files**
- `packages/db/src/models/Page.ts` (field + index)
- `apps/worker/src/services/outboundLinks.ts` + tests
- `apps/worker/src/processors/{generatePage,backfill}.ts` (populate)
- `apps/api/src/routes/{admin,pages}.ts` (lineage rewrite + new kind)

## 5.1 Queue-stats endpoint + admin pill

`GET /api/admin/queue-stats` walks every BullMQ queue and returns
`{ totals, queues[] }` job counts. The admin panel polls every
5s, rendering a green/amber/red totals pill plus an expandable
per-queue table ranked by failed count then backlog size.

**Files**
- `apps/api/src/routes/admin.ts`
- `apps/web/src/routes/settings/Admin.tsx`

## Out of scope (deferred)

- **1.5 Embedding-similarity tag cascade.** The deterministic
  cascade (exact / aliases / canonical match) already covers
  most cases; embedding similarity would need its own evaluation
  pass before tuning. Deferred.
- **Resolver fetch-mock tests.** The scoring math is unit-tested
  via `scoreWikidataHit`; the fetch + cache plumbing is best
  exercised in integration, which would need a redis fixture.
  Deferred.
