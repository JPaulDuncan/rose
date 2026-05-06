# Plan 12 — Tag canonicalisation + named-entity linking

**Status:** Shipped.
This is a retrospective spec — the implementation exists. Documented
here so a future contributor isn't surprised by the page-write
pipeline's post-persist steps.

---

## Why both in one doc

Two features that each give the user a curated taxonomy on top of
LLM output:

- **Tag canonicalisation.** Without it the LLM emits `job-listings`
  on one page and `job-postings` on the next; tag pages fragment.
  Solved by mapping every emitted tag onto a per-user canonical
  registry with explicit aliases.
- **Named-entity extraction.** Tags answer "what's this about".
  Entities answer "who / what specifically". "Bill Walsh", "Inception",
  "NPR" each get their own /n/<key> page that aggregates references.

They share the same pattern: a per-user registry, an LLM extraction
step at page-write time, a Settings surface for manual edits, and
prose auto-linking on the page view.

## Data model

### `TagCanonical` collection
```
{
  userId: ObjectId,
  canonical: String,        // kebab key — what's stored on Page.tags
  displayName: String,      // human label — what the UI renders
  aliases: [String],        // other kebab keys that fold here
  pageCount: Number,        // best-effort, lazy
  embedding?: [Number]      // future: similarity-based settings UI
}
```
Unique on `(userId, canonical)`; index on `(userId, aliases)`.

### `Entity` collection
```
{
  userId: ObjectId,
  key: String,              // kebab — URL slug at /n/<key>
  displayName: String,      // surface form ("Wait Wait... Don't Tell Me!")
  type: 'person' | 'work' | 'organization',
  aliases: [String],
  pageCount: Number,
  lastSeenAt: Date
}
```
Unique on `(userId, key)`; index on `(userId, type, pageCount)` for
type-filtered directory queries.

### `Page` extensions
- `tags[]`: stores canonicals only, post-mapping.
- `entities[]`: `{name, normKey, type, displayName}` for prose
  auto-linking + the right-rail Mentions card.
- `entitiesExtractedFromHash`: SHA of contentMd at last extraction;
  identical hash → skip the LLM call.

## Pipeline

After every successful page write (`generatePage` and the briefing
processor as of plan 12 audit pass 1):

1. **Categorize step** emits free-form tags.
2. **`canonicalizeTags(userId, tags)`** —
   - Direct lookup: any input that matches an existing
     `canonical` or `aliases` resolves to its canonical.
   - Unknowns batched into a single `tag.canonicalize` LLM call
     with the user's top-80 canonicals as anchor list.
   - LLM returns `{tag, canonical, displayName, isNew}` mappings.
   - New canonicals upsert; new aliases `$addToSet`-merge.
   - Failure path: passthrough (the tags ship as-is).
3. **`runPostWriteEntityExtraction(userId, page, hash)`** —
   - Skip when `entitiesExtractedFromHash === hash`.
   - LLM call (`extract.entities` seed) returns up to 12 named
     entities with type + alternate forms.
   - `Page.entities[]` replaces wholesale; Entity rows upsert.
   - Adds `{kind:'entity', subjectKey:<displayName>}` to
     `Page.daydreamSubjects[]` (deduped, capped at 24) so the
     daydream sweeper picks the page up automatically.

## API surface

### Tag management — under `/api/tags/canonicals/`
```
GET    /                 — list canonicals + emergent (in pages but
                           with no canonical row yet)
PATCH  /:canonical       — update displayName / aliases
POST   /:canonical/merge — fold source into target; rewrites
                           Page.tags across the corpus
POST   /:canonical/rename — rename canonical key + Page.tags rewrite
DELETE /:canonical?purgeFromPages= — drop row, optionally strip
                           from pages
```

### Entity management — under `/api/entities/`
```
POST   /                 — manual create (G3, audit pass 2)
GET    /                 — directory, ?type=person|work|organization
GET    /:key             — aggregated detail: pages, related, place
                           coords if it's a known place
PATCH  /:key             — update displayName / type / aliases
POST   /:key/merge       — fold source into target
POST   /:key/rename      — rename canonical key
DELETE /:key?purgeFromPages= — drop row, optionally strip
GET    /:key/daydream    — fetch cached "what is this" note
POST   /:key/daydream    — enqueue a direct entity-research job
                           (rate-limited via shared llmForceLimiter)
```

The merge/rename endpoints share a "snapshot affected ids → $pull
source → $addToSet target on those ids only" pattern so an unbounded
`$addToSet` against `tags: { $ne: target }` can never dump the
target onto every other page in the corpus.

## Web surface

- `/n/:key` — entity detail page. Type badge (per-type colour),
  hero MapInset for places with coords, page list, related entities
  ranked by co-occurrence, Background brief from daydream.
- `/t/:tag` — tag page (existed before plan 12; payload now
  hydrated with display names).
- **Settings → Tags** — list, filter, edit, merge, rename, delete.
- **Settings → Entities** — same shape; filter pills by type;
  manual create form.
- **Page right rail** — new "Mentions" card grouped by type
  (People / Works / Organizations). Places live in their own card
  above (with map).
- **Auto-linker** — unified Linker over tags + entities + places.
  One regex per page. Tags route to `/t/<canonical>`, entities and
  places route to `/n/<normKey>`. Plural tolerance preserved for
  tags only; entity matching is exact.

## LLM seed instructions

- `tag.canonicalize` (scope `tag-canon`)
- `extract.entities` (scope `entities`)

Both are user-clonable from Settings → Instructions; the canonical
behaviour falls back to passthrough when the seed isn't wired up.

## Failure modes

- LLM call fails → tags ship raw / entities stay empty. Page
  persists. The `entitiesExtractedFromHash` field is not bumped on
  failure, so the next pass will retry.
- Alias collision with another entity / canonical's primary key →
  PATCH endpoint returns 409 with a "use Merge" hint rather than
  silently fragmenting the row's identity.
- Daydream subject-key collision (entity's displayName collapses to
  the same whitespace-form as another entity) → first writer wins;
  subsequent same-key extractions dedupe via the seen-set in
  `runPostWriteEntityExtraction`.

## What's not (yet) here

- **Synthesis pages** don't run entity extraction (the synthesis
  route lives in the API process, not the worker; would need a
  cross-process queue or a code-package move). Briefings DO get
  extraction. Audit-doc G1 is partial.
- **Tag canonicalisation runs on `generatePage` only.** Briefings
  and synthesis emit hard-coded tags (`['briefing', ...]` /
  `['synthesis']`) that don't need mapping; tag-digest content
  doesn't emit tags. So the gap is narrower than the audit's R5
  initial framing.
- **Entity-display-name change in the editor doesn't propagate**
  to historical PageRevisions. Live pages reflect the change
  (PATCH mirrors onto Page.entities); revisions are append-only by
  design.
