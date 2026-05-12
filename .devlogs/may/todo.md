# May todo — what's left on the branch

Comprehensive plan covering everything from the post-LLM-reduction
audit. Items are grouped by category and ordered by leverage
within each. Each item carries a design block + acceptance
criteria so any session can pick one up cold.

Status legend:
  [ ]   not started
  [~]   in progress
  [x]   done
  [-]   intentionally deferred / out of scope

---

## 1. Round out features I already shipped

### 1.1 Per-vendor receipt adapters
**[x]**

**Goal.** Catch receipts from senders who don't emit schema.org
JSON-LD (Amazon, Target, many small Shopify stores). Architecture
already supports it — `tryStructuredReceipt` falls through to
`tryVendorReceipt(html, brandKey)` before the LLM.

**Design.**
- New `packages/email-parser/src/vendors/` directory.
- One file per vendor: `amazon.ts`, `apple.ts`, `usps.ts`, etc.
- Each exports `parse(html, subject): StructuredReceipt | null`.
- Vendor dispatch: a small registry keyed by `brandKey` returns the
  matching parser, falls through to null.
- Each vendor parser is dependency-free regex + heuristics.

**Acceptance criteria.**
- At least three vendor parsers shipping (Amazon, Apple receipts,
  USPS/shipping confirmations).
- Vitest fixtures for each, ≥ 3 cases per vendor.
- `extractReceipt.ts` chains vendor pass between structured + LLM
  with `extractedBy: 'vendor'` evidence label.
- Admin extraction-stats card surfaces vendor coverage alongside
  structured / llm.

### 1.2 Wikidata Q-IDs for persons and places
**[x]**

**Goal.** Today only `Organization` + `Product` resolve. People
and places still go entirely through LLM relation extraction.

**Design.**
- Extend `wikidataResolver.ts` with `enrichEntityWikidata(userId,
  entityKey)` that runs on per-user `Entity` rows of type
  `person` / `place`.
- `Entity.wikidataId` + `wikidataConfidence` + `wikidataResolvedAt`
  fields added.
- Resolver type-hint regex: descriptions matching `person|writer|
  actor|engineer` for type=person, `city|town|region|country` for
  type=place.
- After Q-ID resolution, kick off `enrichEntityRelations(entityKey)`
  to pull person/place relations from SPARQL (spouse, parent,
  birthplace, etc.). New property map for non-org entities:
  - P26 spouse → spouse
  - P22 father, P25 mother → parent-of (reversed)
  - P3373 sibling → sibling-of
  - P19 birthplace → born-in
  - P108 employer → employer

**Acceptance criteria.**
- Entity schema carries Q-ID + confidence + resolvedAt.
- New entities of type=person/place trigger Q-ID resolution.
- Person-typed Q-IDs trigger relation enrichment using the
  person property map.
- Audit chip "wikidata" appears on person/place pages too.

### 1.3 Wire daydream backfill (currently no-op)
**[x]**

**Goal.** The `kind: 'daydream'` slot in `apps/worker/.../backfill.ts`
is a `logger.debug` and nothing else. Hook it to the existing
daydream queue so the Wikipedia-verbatim fast path picks up old
notes.

**Design.**
- In the backfill worker, when `kind === 'daydream'`, iterate the
  page's `daydreamSubjects[]` and enqueue a per-subject daydream
  job onto `rose.daydream` queue (same shape the sweeper uses).
- The daydream worker's existing `tryWikipediaVerbatim` short-
  circuits if Wikipedia returns a confident hit.
- Throttle: skip if `isFresh(...)` says the note was researched in
  the last 7 days.

**Acceptance criteria.**
- Pressing "Daydream backfill" enqueues one daydream job per
  subject on the chosen page.
- An older LLM-synthesised note re-researches and flips to
  `wikipedia:verbatim` when Wikipedia matches.

### 1.4 Subscription recipe trigger
**[x]**

**Goal.** Today recipes can fire on `email.ingested` / `page.created`
/ `tag.applied` / `time.scheduled` — but not on `subscription.created`.
Adding the event type lets users wire "tell me when Rose detects
a new subscription on my account."

**Design.**
- Add `subscription.created` and `subscription.renewed` to the
  recipe `TriggerKind` enum (`@rose/shared/schemas/recipe.ts`).
- Emit the event from `extractSubscription` when:
  - `subscription.created` — `$setOnInsert` fires (it was a brand
    new sub).
  - `subscription.renewed` — `$set` updates with a new
    `nextRenewalAt` later than the prior value.
- Plumb through `emitRecipeEvent`.
- Recipe wizard exposes the new triggers.

**Acceptance criteria.**
- Subscription extractor emits both events with the subscription
  ID + service name + amount + cadence + status.
- Wizard's trigger picker shows the new options.
- KeyboardHelp / docs reference unchanged (no chord overlap).

### 1.5 Embedding-similarity rung in tag cascade
**[ ]**

**Goal.** The cascade comment says "exact → suffix → edit-distance
→ embedding → LLM" but the embedding rung was deferred. Today the
`TagCanonical.embedding` field exists but is unpopulated; the
cascade goes straight from edit-distance to LLM.

**Design.**
- New worker pass: a periodic sweep that walks `TagCanonical` rows
  with `embedding: null` and computes one. Same embedding model as
  Page embeddings — Mongo cosine fallback works because we already
  trust it for /search.
- Cascade insertion: after edit-distance fails, embed the unknown
  tag (one call), cosine against the ≤200 candidate canonicals
  (their embeddings join the existing fetch), accept top match
  when score ≥ 0.85.
- Persist the alias as `persistMapping(...,, 'embedding-match')`
  so the audit can show the source.

**Status note.** Skipped this iteration — depends on embedding
infra populating canonical-tag rows, which requires either a
backfill sweep or a hot-path embed during canonicalisation. Both
add LLM-adjacent cost; the suffix + edit-distance passes already
cover most of the win. Revisit when call-volume analysis shows
the LLM tail is dominated by synonym pairs.

---

## 2. Risk mitigation — tests for recent features

### 2.1 Vitest coverage for the new extractors and APIs
**[x]**

**Goal.** Zero test coverage on the past few weeks' work. Each
untested feature is a regression vector.

**Design.**
Add Vitest suites for:
- `wikidataResolver` — search response parsing, confidence scoring,
  cache key namespacing.
- `wikidataRelations` — SPARQL response parsing, property → predicate
  mapping, direction handling.
- `extractSubscription` — gated tag check, cadence inference from
  body wording, status detection.
- `extractRelations` — predicate vocabulary validation, idempotent
  evidence dedup.
- `extractReceipt` structured fast-path branching.
- `extractHtmlMetadata` extensions (covered in 1.x).
- `ontology` predicate vocabulary — `predicateByKey` lookups,
  `isSymmetric`, `activePredicates` excludes deprecated.
- `backfill` worker — kind dispatch.

**Acceptance criteria.**
- Each service has at least one test file with ≥ 4 cases per
  exported function.
- Worker `pnpm test` count goes up by a meaningful chunk (target:
  +50 tests).
- All tests pass.

---

## 3. Quality / UX rough edges

### 3.1 Triage undo
**[x]**

**Goal.** Single-key triage actions (a/s/b/p/d/r) commit
immediately. Accidental presses lose work — there's no undo.

**Design.**
- Track the last action in a `lastAction: { id, verb, prior }`
  state in the Triage component.
- `u` keypress restores: archive → unarchive endpoint; defer →
  defer with hours=0; spam → not undoable (deletes data); etc.
- Surface "Undo last action (u)" hint in the keymap strip after
  each commit.

### 3.2 Magazine "save this edition"
**[ ]**

**Goal.** Today the magazine view re-renders every load with the
current digest. Past editions don't survive.

**Design.**
- Snapshot the rendered HTML on a `POST /api/magazine/save`
  endpoint. Store in new `MagazineSnapshot` collection (userId,
  edition label, html, createdAt).
- List past editions in a small archive panel.

**Status note.** Deferred — adds a new collection + UI surface
without a strong forcing function. Lower priority than the
extraction work and tests.

### 3.3 Map clustering
**[ ]**

**Goal.** Multi-pin atlas crowds at city scale.

**Design.** Wrap `MapInset` markers in a Leaflet cluster group
(leaflet.markercluster). Adds 1 npm dep.

**Status note.** Deferred — low impact for typical archive sizes.

### 3.4 Lineage as DAG visualisation
**[ ]**

**Goal.** Today's lineage view is three stacked lists. A force-
directed graph would read better.

**Design.** Use `react-force-graph-2d` (already a dependency for
the codex graph view). Center node = current page; upstream above,
downstream below; edge colour = reason badge.

**Status note.** Deferred — list view is functional; graph view is
polish.

### 3.5 Reports filter (admin)
**[ ]**

**Goal.** Admin bug-report list is flat. Add status / kind / user
filter chips.

**Status note.** Deferred — only matters when the report list
grows past one screen.

---

## 4. Performance / scale

### 4.1 Lineage endpoint — replace contentMd regex
**[~]**

**Goal.** `$regex` over `Page.contentMd` for every page citing
this slug is O(n) over the corpus. Fine at small scale, broken
at 10K+ pages.

**Design.**
- Maintain a `Page.outboundLinks: string[]` field — slugs this
  page references in its contentMd. Indexed.
- Populate via a tiny new post-write hook that regexes contentMd
  once at write time and stores the result.
- Lineage `cited-by` query becomes `Page.find({ outboundLinks:
  this.slug })` — single indexed lookup.
- Backfill: walk every Page once, set outboundLinks from contentMd.
  Add the backfill kind `outboundLinks` to the admin panel.

**Acceptance criteria.**
- New field + index added; populated on every page write going
  forward.
- Backfill rewrites historical pages.
- Lineage query rewritten; regex pass removed.

**Status note.** Implemented field + write-time population; full
backfill kind is wired but visual update to lineage requires the
index to populate first. **Marked done at the code-shipping
level — production usage will require running the backfill.**

### 4.2 Relations read path — single aggregation
**[ ]**

**Goal.** Today the API fetches up to 200 relations, then for
each unique endpoint does per-row lookups via Entity + Organization
collections. Three queries minimum, more under high fanout.

**Design.** Convert to a single `$lookup` aggregation joining
relations → entities + organizations → pages-for-evidence. One
round trip, indexes still kick in.

**Status note.** Deferred — current path is acceptable up to a
few hundred relations per entity. Revisit when a user's entity
page exceeds that.

### 4.3 Daydream alignment query — pipeline-shape it
**[ ]**

**Goal.** Today the alignment query collects up to 5,000 interest
keys application-side then `$in`s against `DaydreamNote`. Mongo
could keep the join entirely server-side.

**Design.** Express the user's interest derivation (Page.daydreamSubjects
∪ Sender.brandKey ∪ Entity.key) as a single aggregation pipeline
with `$lookup` into DaydreamNote.

**Status note.** Deferred — current shape is bounded at 5,000
keys which keeps the $in tractable.

### 4.4 Worker mode documentation
**[~]**

**Goal.** No docs on `WORKER_MODE=all|llm|io|cpu|bg`. New
deployer doesn't know what to set.

**Status note.** Covered in section 5.2 below; will land as part
of the worker mode ADR.

---

## 5. Observability / ops

### 5.1 Backfill progress monitor
**[x]**

**Goal.** Admin presses Backfill → watches the static chart
refresh every 60 s? Want a "X of Y jobs completed" live indicator.

**Design.**
- New API: `GET /api/admin/queue-stats?queue=rose.backfill`
  returns BullMQ job counts (waiting / active / completed / failed).
- Admin UI: after a backfill, polls every 2 s for 60 s, shows a
  small status pill below the row.

### 5.2 Worker mode ADR + README updates
**[x]**

**Goal.** Document the worker process split (`all`, `llm`, `io`,
`cpu`, `bg`) so deployers know what they're choosing.

**Design.** New `.devlogs/may/worker-modes.md` + add a short
section to the root README.

### 5.3 Metrics dashboard
**[ ]**

**Goal.** Queue depths, LLM latency, error rates, retry counts
over time would tell us which knobs to turn.

**Design.** A `/api/admin/metrics` endpoint that exposes process
counters + a small admin chart panel. Or wire into
Prometheus/OTel; out of scope for now.

**Status note.** Deferred — would benefit from an external
metrics store; not worth bolting onto Mongo.

### 5.4 Structured-logging conventions
**[ ]**

**Status note.** Deferred — current logs work; no forcing function.

---

## 6. Documentation

### 6.1 .devlogs ADRs for recent plans
**[x]**

**Goal.** The plan mentioned `.devlogs/` for ADRs. None of the
post-Plan-11 work is documented there.

**Design.** Short ADRs (≤ 1 page each) for:
- Weather sharing (already shipped)
- Map snapshot + static images (already shipped)
- Lineage (already shipped)
- Ontology layer (relations + Wikidata) (already shipped)
- Backfill mechanism (already shipped)
- Worker modes (new — see 5.2)

### 6.2 README refresh
**[x]**

**Goal.** README hasn't been touched in ages. New contributor
won't know what extractors exist, how the post-write pipeline
works, or what `extractedBy` means.

**Design.** Add a short "Pipeline" section describing the
extractor chain + the structured-data fast paths.

---

## 7. Things explicitly out of scope

- Federation features (Rose-to-Rose page beam, trust circles) —
  big design surface, not pressing.
- Per-user customisable predicate vocabulary — current admin-
  managed config is fine for a small instance.
- Real-time multi-user editing — single-editor optimistic is
  the v1 contract.
- Mobile native apps — PWA only if time permits.
