# Web Integration: Topic-Aware Synthesis

This devlog designs how Rose ingests the open web alongside the
user's email, internal pages, and library, then synthesises a
single per-topic page that frames external information through the
lens of what the user actually receives.

The motivating example: a user gets an email mentioning **Iran**.
Rose already produces a topic page from that mail. The proposal is
that the same page also pulls in the latest news on Iran (AP, BBC,
Reuters, …), the current weather in Tehran if relevant, and prior
context the system has accumulated, and presents it as one coherent
article — citations included, the user's email anchoring the
"why this matters to me" framing.

Author: Claude. Targets the build at `199ebe4`. Implementation lives
behind feature flags and is gated by per-user opt-in; the system is
useless if scraping is enabled by default and the user finds Rose
hammering AP News on day one.

---

## TL;DR

Rose already has 80% of the pieces. **SearXNG is bundled**, the worker
already runs **`@mozilla/readability` + `jsdom`** through
`fetchAndParse.ts` and `websiteSync.ts`, **LibraryDocument** is a
per-user crawl cache with `(userId, urlHash)` uniqueness, and the
daydream pipeline already federates over adapter sources via
`apps/worker/src/lib/discovery/libraryAdapter.ts`. The Topic Watch
feature already does scheduled topic-driven page generation.

What's missing is the **glue that turns a topic on a page into a
bounded crawl, scores the resulting documents against the topic,
optionally recurses N levels, and feeds the corpus to a multi-source
synthesis prompt that produces a unified page**. Most of that is one
new worker, one new prompt, two model fields, and a careful
politeness layer.

The recommended stack — all open-source, all already-used or
adjacent:

- **Discovery:** SearXNG (bundled) + RSS/Atom from `rssSync.ts` + the
  user's existing per-source feeds.
- **Static fetching:** `undici` (Node's modern HTTP client) +
  `robots-parser` (npm) for robots.txt.
- **Content extraction:** Mozilla Readability (already a dep) +
  `@postlight/parser` as a fallback for sites Readability mishandles.
- **JS-rendered fallback:** Jina Reader (`r.jina.ai` Docker image
  — open source, MIT) as the lightweight escape hatch; **Playwright**
  as a heavier rarely-used option, gated behind a setting.
- **Markdown:** `turndown` for HTML→Markdown so the synthesised page
  reads as prose, not stripped text.
- **Embedding + scoring:** existing `@rose/llm` providers and
  `apps/worker/src/lib/vec.ts:cosine` — same path the article
  embedder uses.
- **Rate limiting:** BullMQ rate limiter per host, plus a Redis
  token bucket for the global crawler budget.
- **Recursion:** bounded BFS over a frontier scored by topic
  similarity; depth and total-fetch caps are hard ceilings.
- **Synthesis:** new `synthesise.topic-page` instruction that
  consumes (user emails + internal pages + web docs) and produces
  the same `PageGenerationDraft` shape we already validate.

Worth noting up front: this proposal is large enough that it would
ship in **four phases** (`apps/worker/src/processors/topicResearch.ts`
→ recursion → adaptive triggers → user controls). Phases 1–2 are the
core; 3–4 are quality-of-life. Phase 1 alone is ~3 days of work.

---

## 1. Goals & non-goals

### Goals

- Given a topic on a Rose page (e.g. `Iran`), enrich that page with
  current web context drawn from open sources.
- Cite every external claim with a clickable link back to the
  source, treated identically to how `Page.citations` already
  handles internal email citations.
- Compose **one** synthesised page per topic per user, anchored by
  the user's actual mail. The user reads "Iran — what it means for
  me," not "Iran — Wikipedia summary."
- Reuse the existing Page / Recipe / Watch / Library models so
  research surfaces are first-class, not bolted on.
- Be a polite citizen: respect robots.txt, rate-limit per host,
  identify ourselves with a contactable User-Agent, cache
  aggressively.
- Be safe: don't follow links inside spam emails, refuse to enrich
  pages from quarantined senders, gate via per-user toggle.

### Non-goals (explicit)

- **Not** a general-purpose web archive. We don't replicate
  Common Crawl. We fetch what's needed for a topic, with clear
  budgets, and let TTL evict.
- **Not** a fact-checker or sentiment classifier. We surface what
  reputable sources say with citations; we don't try to adjudicate.
- **Not** a paywalls-bypasser. Articles behind paywalls get a
  link-preview only; we never strip cookies or use archive.org as a
  laundromat. This is principled, but it's also a legal hygiene
  concern for a self-hosted product.
- **Not** real-time. Topic research runs on a queue; the user sees
  a "Research in progress" affordance and the page updates when the
  worker finishes.

---

## 2. What we already have

The proposal extends existing infrastructure rather than starting
fresh. Concrete references in the codebase:

| Capability                        | Where it lives                                           |
| --------------------------------- | -------------------------------------------------------- |
| Federated meta-search (SearXNG)   | `packages/llm/src/daydream/searxng.ts`                   |
| HTML fetch + Readability extract  | `apps/worker/src/processors/fetchAndParse.ts:124`        |
| Website crawler / sync            | `apps/worker/src/processors/websiteSync.ts`              |
| Per-user document cache           | `packages/db/src/models/LibraryDocument.ts`              |
| Scheduled topic page generation   | Topic Watch (`Recipe.importedFrom = 'topic-watch'`)      |
| Multi-source consolidation prompt | `packages/llm/src/seed/index.ts` (consolidate template)  |
| Cosine-similarity helpers         | `apps/worker/src/lib/vec.ts`                             |
| Per-page external sources field   | `Page.externalSources` (rendered by `ExternalSourcesSection` in `Page.tsx`) |
| Embedding-driven taxonomy         | `apps/worker/src/services/taxonomySnap.ts`               |

The new feature is plugging the gaps between these:

1. A **topic-research orchestrator** that, given a topic + a
   triggering page, produces a corpus of relevant web documents.
2. A **scoring/relevance loop** over that corpus, optionally
   recursive.
3. A **synthesis prompt** that fuses the corpus with the user's
   own pages and the source emails.

---

## 3. Architecture overview

```
                  ┌──────────────────────────┐
                  │  Triggering signal       │
                  │  (email ingest, watch    │
                  │  fire, recipe action,    │
                  │  user "Research" click)  │
                  └────────────┬─────────────┘
                               │
                               ▼
         ┌──────────────────────────────────────────┐
         │ TopicResearch worker                     │
         │ (apps/worker/src/processors/             │
         │   topicResearch.ts — NEW)                │
         │                                          │
         │ 1. Resolve topic label + centroid        │
         │ 2. Generate query plan (LLM-assisted)    │
         │ 3. Discover URLs (SearXNG, RSS, sitemap) │
         │ 4. Fetch + extract  (FetchPool service)  │
         │ 5. Embed + score against centroid        │
         │ 6. (optional) recurse depth ≤ N          │
         │ 7. Synthesise page via new prompt        │
         │ 8. Update Page.externalSources +         │
         │    Page.contentMd + Page.citations       │
         └─────────────────┬────────────────────────┘
                           │
                           ▼
                ┌─────────────────────┐
                │ Page document        │
                │ (existing model)     │
                │  + new fields:       │
                │  externalCitations,  │
                │  researchState,      │
                │  lastResearchedAt    │
                └─────────────────────┘
```

The orchestrator is **one BullMQ worker**. The fetch pool is a
single shared service used by both the orchestrator and the
existing `websiteSync` / `rssSync` workers, so the politeness layer
is shared rather than re-implemented per-call-site.

---

## 4. Tooling & open-source choices

The decision tree is "what's the minimum we can ship that handles
80% of the long tail?" Concretely:

### 4.1 Search / discovery

- **SearXNG (bundled)** is our primary. It federates Brave, DuckDuckGo,
  Bing, Google, Wikipedia, Reddit, GitHub, etc., already runs in
  Docker (`infra/compose/docker-compose.yml`), and `searxng.ts`
  already wraps it. **Use this first.** Free, open source, MIT.
- **RSS/Atom feeds** for sites we already poll (`rssSync.ts`). Topic
  research can discover via SearXNG and then check whether the
  hostname has an RSS feed cached, preferring the structured
  source for follow-up polling.
- **Sitemap.xml** for breadth-first discovery on a user-pinned site
  (e.g. user wants Rose to track everything from `apnews.com/world`).
  `sitemap` (npm, MIT) parses it cleanly.

We deliberately **skip** paid APIs (Brave Search API, Tavily, Exa,
SerpAPI) for the OSS path. They're better at relevance ranking but
the cost-per-topic adds up for a self-hosted personal newspaper.
SearXNG covers the use case and degrades gracefully.

### 4.2 HTTP fetching

- **`undici`** (Node's standard HTTP client, MIT). Faster and
  better-behaved than `node-fetch`; supports HTTP/2; exposes
  fine-grained timeout/abort. Already a transitive dep.
- **`robots-parser`** (npm, MIT). Trivial wrapper for `robots.txt`
  enforcement. We fetch and cache the robots policy per host on the
  first request, refresh every 24h.
- **`got-scraping`** is an alternative that handles header
  fingerprinting / TLS quirks and is what Crawlee uses internally.
  Worth keeping in our back pocket if SearXNG-discovered URLs
  hit a lot of bot blockers — but `undici` is enough for round one.

### 4.3 Content extraction

The hard part. Three tiers:

1. **Tier 1 — `@mozilla/readability` + `jsdom`** (already used in
   `fetchAndParse.ts`). MIT. Works for ~70% of news sites and most
   blogs. Extracts the main article + clean text, drops chrome.

2. **Tier 2 — `@postlight/parser`** (formerly Mercury Parser, MIT,
   Postlight handed it off; npm `@postlight/parser`). Different
   heuristics; catches sites Readability misses (lots of JS frameworks
   that pre-render but generate odd DOM trees).

3. **Tier 3 — Jina Reader** (`jina-ai/reader`, Apache-2.0, has a
   Docker image). Small Go service that hits a URL, runs a headless
   browser, returns clean Markdown. We'd add it as a sidecar in
   `infra/compose/docker-compose.yml` like SearXNG, with a
   `JINA_READER_URL` env. Use it only when Tiers 1+2 produce
   suspiciously thin content (< 300 chars), to keep the headless
   cost bounded.

This three-tier waterfall is the same shape as our existing email-body
extraction strategy — Readability first, fallback to plain-text — and
fits naturally into a single `extractArticle(url, html)` helper.

We deliberately **don't** make Playwright the default. It's powerful
but every fetch carries a real CPU/memory cost. If Tier 3 isn't
enough we'd add a `playwright` profile but gate it behind a separate
toggle and run it only on user-pinned high-priority watches.

### 4.4 Markdown

- **`turndown`** (MIT) converts HTML→Markdown. Used for the final
  representation of fetched articles so the synthesis prompt sees
  prose-shaped text rather than HTML. Already lightweight enough to
  run in-worker.

### 4.5 Crawler / queue framework

Two options:

- **Roll our own** on top of BullMQ. We already have the queue
  primitives, rate limiter, and Redis. The full feature set we
  need (URL frontier, dedup, per-host limits, depth tracking) is
  ~300 lines.
- **Crawlee** (`apify/crawlee`, MIT). Production-grade. Handles
  every gnarly thing — request queue, request handlers, sessions,
  proxy rotation, browser pool, cookie jars. Heavier dependency
  graph; would compete with BullMQ for the worker's mental model.

**Recommendation:** roll our own. The orchestrator's needs are
narrow (topic-bounded fetch, synthesise, done), the integration with
existing BullMQ queues is cleaner, and the DRY across `websiteSync`
(crawl a single site) and `topicResearch` (crawl a topic across
sites) ends up at one shared `FetchPool` service. Adding Crawlee
would mean managing two crawler frameworks. Revisit only if we end
up needing browser pools at scale.

### 4.6 Tools we considered and rejected

- **Trafilatura** (Python). Best-in-class content extraction. Skip
  because adding a Python sidecar to a TypeScript stack is friction
  we don't need yet; Readability + Postlight + Jina covers ≥90%.
- **Newspaper3k** (Python). Same reasoning.
- **Firecrawl**. Open-source and excellent, but it's a whole
  microservice with its own orchestrator. We'd be overshooting.
  If we ever need a managed scrape-as-a-service, this is where we'd
  go — but Phase 1 doesn't justify it.
- **Common Crawl**. Free archived web. Useful for historical
  context but out of scope for "what's happening with Iran *now*."
- **YaCy / OpenSearch self-host**. Indexed search, not topic-driven
  fetch. Would be a nice second-stage adjunct (build our own
  topic-pinned index), but premature.

---

## 5. Data model changes

Two new fields on `Page`, one new collection, optional reuse of an
existing one. Cheap.

### 5.1 New: `WebDocument` (proposed)

We *could* reuse `LibraryDocument`, but its semantics today are
"user added a Library Source and we pulled the corpus from it." Web
research is "Rose pulled this on its own to enrich a topic." Mixing
them muddies retention semantics — the user's `LibraryDocument`s
should not get TTL-evicted while research artefacts can be.

```ts
// packages/db/src/models/WebDocument.ts
{
  userId: ObjectId,         // per-user since search results vary
  url: string,
  urlHash: string,          // SHA-256(url) — index unique on (userId, urlHash)
  hostKey: string,          // eTLD+1 from tldts; per-host rate limits
  title: string,
  contentMd: string,        // Turndown-ised, capped (e.g. 30k chars)
  contentHash: string,      // SHA-256 of contentMd; stable on re-fetch
  fetchedAt: Date,
  expiresAt: Date,          // TTL index → automatic eviction
  embedding: number[],
  embeddingModel: string,
  fetchDepth: number,       // 0 for topic-direct, 1+ for recursion
  parentUrl: string | null, // for ↑ depth tracking
  // Provenance: which topic / page / job pulled this in.
  topicLabel: string,
  triggeringPageId: ObjectId | null,
  // Discovery metadata
  discoveredVia: 'searxng' | 'rss' | 'sitemap' | 'recursion' | 'manual',
  searchQuery: string | null,
  // Politeness
  robotsAllowed: boolean,   // false-> we kept the row but didn't fetch body
}
```

TTL index: `expiresAt` → MongoDB auto-evicts. Default 14 days; user
can pin "always keep" via a future affordance.

### 5.2 `Page` additions

```diff
+   researchState: 'idle' | 'queued' | 'running' | 'failed',
+   lastResearchedAt: Date | null,
+   webDocumentIds: ObjectId[],   // refs into WebDocument
```

The synthesised content goes into the existing `contentMd` and
`citations` (which already supports an opaque `kind` discriminator
for email vs web). New field for web sources keeps backfill clean.

`Page.externalSources` already exists (from the Topic Watch
implementation) — we reuse it to surface the web docs in the right
rail's `<ExternalSourcesSection>`.

---

## 6. Pipeline / flow

### 6.1 Triggering

A topic research run can be initiated four ways:

1. **Email-driven.** When `generatePage` produces a page whose
   topics include a strong-signal topic (extracted topic occurs in
   ≥2 sentences AND topic centroid cosine to email body ≥ 0.7), we
   enqueue a `topic.research` job *if* the user has the feature
   enabled and the sender isn't quarantined.
2. **Watch-driven.** Topic Watches already fire on a schedule and
   already invoke external search — wire them into the new
   pipeline instead of the inline path.
3. **Recipe action.** New action `web.research` available in the
   Recipe wizard. The user can opt in per-rule.
4. **Manual.** A "Research" button on any topic page.

In all four cases the queue payload is the same:
`{ userId, pageId, topicLabel, depth, budgetTokens }`.

### 6.2 Query plan generation

The first worker step turns the topic into 3–5 search queries. A
short LLM call with a dedicated low-temperature prompt:

```
Given a topic (one phrase) and a brief context excerpt (the
triggering email's first 500 chars), produce 3–5 web search queries
that would surface (a) the latest news on the topic, (b) authoritative
background context, (c) any topical sub-questions the user's email
implied. No query may be longer than 8 words.
```

The output is fed into SearXNG, deduped, and yields the initial URL
frontier. We also harvest URLs from any RSS feeds the user is
subscribed to whose titles match the topic — those are higher-trust
than fresh search results.

### 6.3 Fetch pool

A new `apps/worker/src/services/fetchPool.ts` service. Public API:

```ts
fetchPool.fetch(url): Promise<FetchResult>
fetchPool.batchFetch(urls, opts): AsyncIterable<FetchResult>
```

Internals:

- **Per-host rate limit** via Redis sorted set: minimum 1 request
  per second per `hostKey` by default, bumped to 0.25/s for
  high-traffic hosts (apnews.com, bbc.com, …) we know are tolerant.
- **Robots.txt**: cached per `hostKey` for 24h. If disallowed, the
  WebDocument row is created with `robotsAllowed=false` and no body.
- **HTTP**: `undici` with `Accept-Encoding: gzip, br`, timeout 30s,
  3 retries with exponential backoff for 5xx / network errors,
  honour `Retry-After`.
- **User-Agent**: `Rose/<version> (+https://rose.local; bot)`. The
  contact URL is the user's own Rose instance — operators can
  document a takedown procedure there if asked.
- **Conditional GET**: store `etag` and `last-modified` on
  `WebDocument`; subsequent fetches send `If-None-Match` /
  `If-Modified-Since` so unchanged content returns 304 and we skip
  re-extraction.
- **Content-Type filter**: only accept `text/html`, `application/xhtml+xml`,
  `application/rss+xml`, `application/atom+xml`. Reject binaries
  outright.
- **Size cap**: 5 MB per fetch. Larger payloads abort.

### 6.4 Extraction waterfall

```ts
async function extractArticle(url, html, jinaUrl?) {
  let result = readability(html);
  if (!isThin(result)) return { ...result, tier: 1 };

  result = postlight(html);
  if (!isThin(result)) return { ...result, tier: 2 };

  if (jinaUrl) {
    result = await jinaReader(url);  // headless render
    if (!isThin(result)) return { ...result, tier: 3 };
  }

  return null;  // give up; surface as a link-only entry
}
```

`isThin` checks `< 300 chars`, `< 50 words`, or content that's
mostly `Subscribe / Sign in / 403`. Tier 3 is opt-in (Jina sidecar
required). When all tiers fail, the WebDocument row is still created
with title-only — the synthesis prompt can surface a "see also" link
even without the body.

### 6.5 Embed + score

For each fetched document with extractable content:

```ts
const vec = await provider.embed(model, `${title}\n${contentMd.slice(0, 8000)}`);
const score = cosine(vec, topicCentroid);
if (score < TOPIC_THRESHOLD) {
  // Store but mark off-topic; useful for "discarded" debug log,
  // not surfaced to synthesis.
  doc.offTopic = true;
}
```

`topicCentroid` is the mean of:

- The triggering email's embedding (when present).
- All existing `Page.embedding` for pages tagged with the topic.
- The topic-label string's embedding (covers cold start).

Threshold: 0.55 default, configurable. We deliberately don't filter
hard — borderline matches still go to the synthesis step but are
rate-limited (top-K by score).

### 6.6 Recursion

Bounded BFS:

```ts
const frontier = new PriorityQueue<FrontierItem>(byScore);
seedFromSearch(frontier, queries);

while (!frontier.empty() && fetchedCount < BUDGET && elapsed < TIMEOUT) {
  const next = frontier.pop();
  if (visited.has(next.urlHash)) continue;
  if (next.depth > MAX_DEPTH) continue;

  const result = await fetchPool.fetch(next.url);
  visited.add(next.urlHash);

  if (!result.body) continue;
  const article = await extractArticle(next.url, result.body);
  if (!article) continue;

  const doc = await persistWebDocument(article, next);
  fetchedCount++;
  if (doc.offTopic) continue;  // don't recurse from off-topic neighbours

  if (next.depth < MAX_DEPTH) {
    for (const link of harvestLinks(article, next.url)) {
      const score = scoreCandidate(link, topicCentroid);
      if (score >= RECURSE_THRESHOLD) {
        frontier.push({ ...link, depth: next.depth + 1, score });
      }
    }
  }
}
```

`scoreCandidate` is heuristic-only at the link stage (no embed
call yet — too expensive at scale). It uses anchor-text overlap with
topic-label tokens, hostname trust score (we maintain a small
allowlist of known-good news / reference hosts that get a +0.1
boost), and depth penalty. The actual embed-cosine happens after
fetch.

Defaults:
- `MAX_DEPTH = 1` (so: search → first article → maybe one link
  level deeper from inside that article).
- `BUDGET = 25` total fetches per research run.
- `TIMEOUT = 5 min` wall-clock.
- `RECURSE_THRESHOLD = 0.4` for link-time pre-scoring.
- `TOPIC_THRESHOLD = 0.55` for keep/discard after fetch.

These are all overridable per-watch; the user can pin a beefier
budget on a topic they really care about.

### 6.7 Synthesis

The new prompt template `synthesise.topic-page` lives in
`packages/llm/src/seed/index.ts`. It takes:

```
Topic: {{topic_label}}
User's recent mail referencing the topic:
{{labeled_emails}}              # e1, e2, … with citation tokens

Existing internal pages on this topic:
{{internal_pages}}              # i1, i2, … each with title + summary + tags

Web documents (newest first, scored by topic relevance):
{{web_documents}}               # w1, w2, …  url + title + extracted prose

Existing categories:
{{existing_categories}}
```

The instruction insists every claim cites at least one of e?, i?, w?
labels. Output is the existing `PageGenerationDraft` shape — title,
summary, contentMd, tags, suggestedCategory — which means the
existing parsing / persistence path Just Works.

Worth restating: the **user's email always anchors the lede**. The
lede paragraph is required to start with a one-line "Updated <date>
— <one sentence framing the topic for *this user*'s context>" and
the prompt explicitly references the source email when one exists.
This is the difference between "an Iran wikipedia page" and "Iran,
through the lens of the email you got from your cousin in Tehran."

### 6.8 Persistence

Same as the regular generation path. The page becomes a
topic-mode page (already supported by `findTopicPageForItem` in
`pageAssignment.ts`); the `Page.externalSources` array gets the
top web docs by score; `Page.citations` is a unified map keyed by
`e?` / `i?` / `w?` identifiers each pointing to either an Email
ObjectId, a sibling Page, or a WebDocument.

The existing `<SourcesSection>` and `<ExternalSourcesSection>`
components already render this; minor work to add a `kind: 'web'`
icon variant.

---

## 7. Politeness & safety

This deserves its own section because the failure modes here are
embarrassing and legally fraught.

### 7.1 robots.txt

Hard requirement. `robots-parser` evaluates each URL before we
fetch. Disallow → no fetch, log with `robotsAllowed=false`. We
respect `Crawl-delay` if present (override our default rate limit
upward, never downward).

### 7.2 Rate limiting

Per-host token bucket in Redis. Burst of 5, refill 1/s. High-traffic
hosts (apnews, reuters, bbc — small allowlist we maintain) bumped
to 0.25/s steady-state to avoid looking like an attack to their
WAFs.

Per-user global cap: 200 fetches/day default, bumpable in settings.

### 7.3 User-Agent / contact

Every request carries `User-Agent: Rose/<version> (+<instance-url>;
bot)`. The instance URL is the user's own Rose; the operator can
publish a contact / takedown procedure there. This is the polite
move and it's also operator self-protection — if a host is annoyed,
they have a clear address to ask us to stop.

### 7.4 No paywall circumvention

If a fetch returns 401/402/403 *or* the extracted text contains
known-paywall markers ("Subscribe to read", "Sign in to continue"),
we stop. The WebDocument row is preserved with title-only so the
synthesis prompt can surface a "see also" link, but we don't go
hunting for archive.org mirrors. This is a values choice; it's also
a "we don't want to be in court" choice.

### 7.5 Quarantine integration

The existing spam / quarantine system already tracks `Sender.autoQuarantine`
and `Page.flags.userMarkedSpam`. **No** research runs trigger off
emails from quarantined senders. **No** links inside spam-flagged
emails get followed even on user-initiated runs. The `liftQuarantineForBrand`
helper we already have stays the source of truth.

### 7.6 Content filtering

Not a value judgment — a hygiene one:

- Adult-content hostnames blocked unless explicitly allowlisted by
  the user (rare but real concern when topics are ambiguous).
- Known-malicious hostnames (we sync a small denylist from
  `urlhaus.abuse.ch` weekly) get auto-rejected.
- Pages that respond with `Content-Security-Policy: ...` headers
  obviously malformed get treated like Tier-3 only — we don't run
  Readability against them.

### 7.7 Per-user opt-in

The whole feature is gated behind `User.settings.webResearch.enabled`,
default `false`. The first time the user creates a Topic Watch we
offer to enable it. Nothing else turns it on automatically.

---

## 8. UX surface

The user-visible product is small — most of the system is invisible
research.

### 8.1 Page view changes

- A new pill in the article header: **"Researched <relative time>"**
  with a refresh icon. Click → enqueue a research run with toast
  "Research queued — page will update when it's done."
- The right-rail `<ExternalSourcesSection>` already exists; new
  entries just flow into it.
- A "What was researched" details disclosure under Provenance shows
  the queries that were run, count of fetched docs, count discarded
  as off-topic, count blocked by robots. Helpful for trust calibration.

### 8.2 Topic Watch settings

The existing Watch creation flow already exposes a sources picker.
We add web-research as a source type with controls for:

- Search engine: SearXNG / future paid options.
- Max depth (0–3, default 1).
- Max fetches per run (5, 25, 100).
- Allowed hostnames (free-form list; default empty = anything).
- Recurse links: yes / no.

### 8.3 Settings → Research

A new sub-page under Settings. Toggles for the per-user opt-in,
global daily fetch budget, the small allowlist of high-traffic
hosts, and a manual "Test fetch" affordance for debugging.

### 8.4 Codex → Web sources

A new tab on `/codex` that lists `WebDocument` rows grouped by
hostname, sorted by recency. This is the "what has Rose been
reading" view — useful for transparency, and it also gives the user
a direct surface to forget specific cached docs ("don't pull from
that site again") which propagates to the per-user denylist.

---

## 9. Failure modes & open questions

### Failure modes we've thought about

1. **Topic drift.** Search query for "Iran" returns a tourism page
   from 2009. Defence: cosine threshold post-fetch, strong recency
   weighting in the LLM prompt ("prefer the past 30 days unless the
   topic is historical"), and the `lastModified` HTTP header is fed
   into the score.
2. **Partisan / unbalanced sources.** When a topic is politically
   charged, SearXNG can return a skewed slate. We add a lightweight
   diversity heuristic: when synthesising, the prompt is told the
   hostnames of all surfaced docs and instructed to flag if all
   docs come from one ideological camp. The user-visible render
   surfaces this as a banner.
3. **Hallucination in synthesis.** Same risk we already manage on
   Page generation. Mitigated by: required citation per claim,
   strict JSON output validated by Zod, low temperature (0.3), and
   the existing `extractJson` + `PageGenerationDraft.parse` guard
   rails.
4. **Cost blow-up.** Every research run is bounded by `BUDGET` (25
   fetches default) + per-user daily cap (200) + LLM token budget
   on synthesis (15k input tokens). Worst-case research of 25 docs
   at 8k chars each is well under 200k input tokens — fits in any
   reasonable Ollama deployment.
5. **Privacy.** All fetches go out from the server. The user's
   self-hosted instance' IP correlates with their topic interest.
   We're not solving this — it's the cost of running a personal
   crawler. Document it in the settings page.

### Open questions

- **Should the WebDocument cache be global (cross-user) or
  per-user?** Per-user is simpler; cross-user dedup saves
  bandwidth but complicates retention (when does it get purged?
  what if user A wants to forget but user B doesn't?). The proposal
  goes per-user. Revisit at scale.
- **Headless browser as a service or in-process?** Jina Reader is a
  separate Docker container — same pattern as SearXNG, lightweight,
  known-good. Putting Playwright in-process is heavier. Phase 1
  ships with Jina-only Tier 3.
- **Citation IDs.** Right now `Page.citations` keys are like
  `e1`, `e2`. Web docs would be `w1`, `w2`. Internal page refs in
  the new synthesis prompt would be `i1`, `i2`. Three namespaces in
  one map; the existing schema accepts arbitrary string keys, so
  this is a prompt-and-render change, no migration.
- **What happens if a user disables research mid-flight?** The job
  is allowed to complete (we don't kill in-flight runs); subsequent
  enqueues are no-ops. Not great if the user disabled it because
  Rose is currently misbehaving — secondary affordance: "Cancel
  active research" button on the page.

---

## 10. Phased build plan

Staged so each phase is shippable and uses the prior phase as a
foundation.

### Phase 1 — Core fetch + synthesis (≈3 days)

- New `WebDocument` model + indexes.
- New `apps/worker/src/services/fetchPool.ts` (undici, robots,
  rate limit, conditional GET, content-type filter).
- New `apps/worker/src/services/extractArticle.ts` (Readability →
  Postlight → null waterfall; Tier 3 stub).
- New `apps/worker/src/processors/topicResearch.ts` orchestrator.
  Initial version: SearXNG → fetch → embed → score →
  synthesis → page update. **No recursion yet.** Fixed budget.
- New `synthesise.topic-page` instruction in `@rose/llm` seed.
- New `Page.researchState` + render the "Researched <time>" pill.
- Manual trigger only ("Research" button on a topic page).
- Per-user opt-in toggle.

### Phase 2 — Recursion + auto-trigger (≈2 days)

- BFS frontier with link scoring.
- Auto-trigger from `generatePage` when topic signal is strong.
- Topic Watch wiring — new "research" source type in the Watch
  builder.
- Refresh button → enqueues, page UI shows queued/running.

### Phase 3 — Quality of life (≈2 days)

- Jina Reader sidecar container, Tier 3 in extractor.
- Diversity / partisan-skew banner in synthesis.
- Codex → Web sources tab.
- "Forget this hostname" denylist propagation.
- `lastModified` recency weighting.

### Phase 4 — Power user (later)

- User-specific allowlist of preferred hostnames per topic.
- Sitemap-based "track everything from this section" mode.
- Optional Playwright tier behind a separate toggle.
- Cross-user WebDocument dedup with per-user provenance.

---

## 11. What the user sees in the Iran example

To close: walk through what the user actually experiences with the
fully-built feature.

1. User receives an email from a colleague: *"Did you see the news
   out of Tehran today? Looks rough."*
2. Email lands in Rose; ingest pipeline produces a page titled
   *"Iran, 2026-05-08"* (topic-mode, anchored on the user's mail).
3. Auto-trigger fires because (a) topic is high-signal and (b)
   user has research enabled.
4. `topicResearch` queues. Within 5 min:
   - SearXNG queries: `Iran latest news`, `Iran Tehran 2026`,
     `Iran political situation May 2026`, `Iran economy news`.
   - 25 URLs fetched, 18 pass robots+content checks, 14 above
     topic threshold.
   - Recursion follows 4 high-scoring links from AP / BBC / Reuters
     coverage; 3 land above threshold.
   - Synthesis prompt fires with: 1 source email, 0 prior internal
     pages on Iran, 17 web documents.
5. Page updates in place:
   - Title: *"Iran"*.
   - Lede: *"Updated 2026-05-08 — Iran's political situation
     intensified this week as [latest event from synthesis], the
     subject of the message your colleague flagged in your inbox
     today."*
   - Body: 4–5 paragraphs synthesising the web sources, every claim
     cited `[w3]`, `[w7, w12]` etc., closing with a "Background"
     paragraph from older Reuters / BBC coverage.
   - Right rail: the source email (e1), 17 external sources grouped
     by hostname.
   - "Researched 2 minutes ago" pill in the header.
6. User opens the page, scans the lede, follows two `[w]` links to
   AP for the original reporting, marks the page as a favourite —
   which, via the existing favouriting machinery, also creates an
   implicit Topic Watch so the next morning the page is auto-refreshed
   with overnight developments.

The synthesis is the user's own personal newspaper desk. The web
provides the wire feed; the user's mail provides the framing; Rose
is the editor.

---

*Generated against the snapshot at `199ebe4`. References in this doc
to specific files / lines reflect the codebase as-of that commit; if
files move, the architecture is the same but the citations are
stale.*
