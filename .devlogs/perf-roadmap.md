# Performance Roadmap

A full-stack performance audit of Rose with the
`web-integration-feature.md` proposal in mind. Where UX-Review-1 was
about ergonomics and the web-integration doc was about a new
feature, this is about the underlying engine — the latency, throughput,
and resource ceiling we already have today and what the web-research
feature will demand of it.

The user asked for "extensive and explicit." This document is. Each
finding has a code reference, an estimated impact, an estimated
effort, and the trade-off / failure mode of the change. Numbers are
estimates derived from the codebase shape and well-known
characteristics of the libraries involved; treat them as
order-of-magnitude until benchmarked.

Author: Claude. Targets `9a3e213`. The roadmap closes with a phased
rollout plan ordered by impact-per-day-of-effort.

---

## 0. TL;DR

Rose is built on a stack (TypeScript, Node, Mongoose, BullMQ, Redis,
Ollama) where the bottleneck pattern is consistent: **one Node
process running 24 BullMQ workers on a single event loop, doing
CPU-bound work (jsdom/Readability/cosine math) inline with I/O-bound
work (LLM streaming, IMAP, HTTP fetch).** When everything is light,
this works fine. When the web-research feature lands (25 fetches +
25 jsdom parses + 25 embeds + a synthesis prompt per topic, multiple
topics in flight), the contention will become visible.

Five changes account for ~80% of the wins:

1. **Split the worker monolith into 4 specialised processes** (LLM,
   I/O, CPU, background) — each its own container, scaled
   independently. Stops the event loop being a shared bottleneck.
2. **Move jsdom/Readability into a `worker_threads` pool** so HTML
   parsing never blocks the event loop. Optionally escalate from
   `htmlparser2` first.
3. **Run a second Ollama container** dedicated to embeddings, and
   batch embedding requests where possible. Stops generation/embed
   GPU thrash.
4. **Audit every Mongoose query for `.lean()` and projections;
   convert all bulk inserts to `bulkWrite`**. Recovers ~30% of
   ingest latency.
5. **Pre-normalise embeddings into `Float32Array` + materialised
   `TopicCentroid` collection** so taxonomy snap and page assignment
   stop scanning + recomputing per request.

The language (TypeScript / Node) imposes a real ceiling on the
hot CPU paths but we are nowhere near it yet. **Don't rewrite.**
The right escalation, *if* hot loops eventually become CPU-bound
even after the above, is a single Rust addon via `napi-rs` for
HTML extraction + cosine — ~1 week of work, ~10–20x speedup on the
specific loop, no other code changes.

Total estimated win from the recommended changes: **5–10x throughput
on ingest, ~3x reduction in p95 page-generate latency, comfortably
absorbs the web-research feature's ~25x fetch volume per topic
research run.**

---

## 1. Diagnosis: where the time goes today

Before listing fixes, the realistic profile of an ingest-and-generate
flow on the current build:

```
1. IMAP fetch: ~50–500ms per email (network I/O).
2. mailparser parse: ~5–30ms.
3. cleanBody / signature strip / quote strip: ~5–20ms (regex chains).
4. Mongoose .save() of Email doc: ~10–50ms (round-trip + index updates).
5. assignment lookup (page-by-thread, then template, then centroid):
   ~10–80ms (multiple find calls, a cosine scan over up to 50 candidates).
6. enqueue generatePage: ~5ms.
7. generatePage worker (concurrency 2):
   - Load assignment: ~20ms
   - Load email corpus + categories: ~30–100ms
   - Build prompt: ~5ms
   - Ollama generation streaming: 3–30 SECONDS (the long pole)
   - Parse JSON: ~5ms
   - canonicalize tags / category (sometimes another LLM call): 200ms–10s
   - Page upsert + revision insert: 30–100ms
   - postWriteHooks enqueue: ~5ms
8. postWriteHooks worker:
   - Embed page: 100–500ms (Ollama embed)
   - Update centroids, propagate tags, etc.: 50–200ms
9. embedPage worker (concurrency 4): 100–500ms.
```

The wall-clock from email-arrives to page-visible is dominated by
the LLM generation call (step 7) — **3–30s**. Everything else is
single-digit-percent at best. So why does any of the rest matter?

**Because it's all happening on one event loop.** When step 7's
prompt-building does a regex sweep over a 200KB email body, that
blocks every other worker for ~50ms. When step 9's embed call's
JSON.parse on the response chews 30ms, it stalls every IMAP heartbeat
in flight. The system *feels* fast at low load and degrades
non-linearly under burst — exactly the failure mode that masks
itself in dev and surfaces in prod.

The web-research feature, where one user action creates ~25 HTTP
fetches + 25 HTML parses + 25 embeds + 1 long synthesis prompt,
cranks every dimension of this contention by an order of magnitude.

---

## 2. Process & concurrency topology

### 2.1 Today: one Node process, 24 workers, one event loop

`apps/worker/src/index.ts:43` boots all 24 workers in a single
process. Concurrency settings vary per worker
(`apps/worker/src/processors/*.ts`):

| Worker            | Concurrency | Class       |
| ----------------- | ----------- | ----------- |
| generatePage      | 2           | LLM-heavy   |
| embedPage         | 4           | Embed       |
| imapSync          | 2           | I/O         |
| gmailSync         | 1           | I/O         |
| rssSync           | (default 1) | I/O         |
| websiteSync       | 1           | I/O + jsdom |
| slackSync         | 2           | I/O         |
| discordSync       | 2           | I/O         |
| gcalSync          | 1           | I/O         |
| daydream          | 1           | LLM-heavy   |
| recipes           | 4           | Mixed       |
| pushNotify        | 4           | I/O         |
| sendOutbound      | 2           | I/O         |
| webhookDeliver    | (default 1) | I/O         |
| digestEmail       | 1           | LLM-heavy   |
| briefing          | 1           | LLM-heavy   |
| fetchAndParse     | 4           | I/O + jsdom |
| postWriteHooks    | 2           | Mixed       |
| librarySync       | 2           | I/O         |
| libraryEmbed      | 4           | Embed       |
| tagDigest         | 1           | LLM-heavy   |
| cleanup           | 1           | Light       |
| weatherSnapshots  | 1           | Light       |
| summarizeSender   | (default 1) | LLM-heavy   |

In aggregate this thread can have **up to 41 concurrent jobs** if
every queue is busy. They all share the event loop and the V8 heap.
A 400ms jsdom parse pauses everything.

### 2.2 Recommendation: four specialised processes

Split into four worker classes, each its own container and
horizontally scalable:

| Process         | Replicas | Concurrency / process | Workers                                                                                       |
| --------------- | -------- | --------------------- | --------------------------------------------------------------------------------------------- |
| `worker-llm`    | 1–4      | low (2)               | generatePage, summarizeSender, briefing, daydream, digestEmail, tagDigest, recipes (LLM step) |
| `worker-io`     | 2–8      | high (8–16)           | imap/gmail/rss/website/slack/discord/gcal/library/sync, fetchAndParse fetch, web research fetch |
| `worker-cpu`    | 1–4      | `os.cpus().length`    | embedPage, libraryEmbed, postWriteHooks, web-extract (jsdom/Readability)                       |
| `worker-bg`     | 1–2      | mixed                 | cleanup, weatherSnapshots, pushNotify, sendOutbound, webhookDeliver                            |

BullMQ supports this without code changes — `new Worker(queueName,
processor, { connection: redis })` only subscribes to the queue
named, so you split by registering different start-functions in
different process entry points.

**Implementation:**

```ts
// apps/worker/src/index.llm.ts
import { startGeneratePageWorker } from './processors/generatePage.js';
import { startSummarizeSenderWorker } from './processors/summarizeSender.js';
// ... only the LLM-heavy starts
async function main() {
  await connectMongo();
  startGeneratePageWorker();
  startSummarizeSenderWorker();
  // ...
}

// apps/worker/src/index.io.ts — only the I/O starts
// apps/worker/src/index.cpu.ts — only the CPU starts
// apps/worker/src/index.bg.ts — only the bg starts
```

Plus four Dockerfiles
(`infra/docker/worker-llm.Dockerfile`, …) — each is identical
except for the `CMD` line — and a docker-compose update to spin up
the four services with `replicas:` counts.

The shared boot logic (Mongo connect, repeatable reconciler, queue
declarations) extracts into `apps/worker/src/lib/bootstrap.ts` so
each entry point is 5–10 lines.

**Impact:** ~3–5x throughput on realistic mixed workloads. The
event-loop contention disappears. CPU pegging on jsdom no longer
stalls IMAP heartbeats; LLM stalls don't queue-starve embedding.

**Effort:** 1 day, mostly mechanical. Risk: low — BullMQ workers
are independent, no shared state.

**Trade-off:** more containers to operate. For a single-user
self-hosted deploy this is overkill; gate behind a `WORKER_MODE`
env so the existing single-process boot remains the default for
solo users.

### 2.3 Concurrency tuning per process

The current per-worker concurrencies are best-effort defaults. With
the topology above, defaults can change:

- **`worker-llm` concurrency 2 stays** (matches Ollama's parallel
  capacity).
- **`worker-io` concurrency goes to 16** — I/O-bound work scales
  super-linearly with concurrency until you hit per-host limits.
- **`worker-cpu` concurrency = `os.cpus().length`** — CPU-bound
  tasks should match physical core count. Set via env so a small
  VPS can drop it.
- **`worker-bg` stays at 2** — leave headroom for the rest.

### 2.4 BullMQ gotchas to fix while we're here

- **`getRepeatableJobs(0, 5000, true)`** in
  `apps/worker/src/services/sourceScheduleReconciler.ts:75` is
  unbounded; once a user has more than 5000 repeatables we silently
  drop the rest. Page through it.
- **Lock duration vs job runtime**: `generatePage` has
  `lockDuration: 5 * 60_000` and runs LLM calls that can exceed it.
  When the lock expires mid-job, BullMQ thinks the worker died and
  the job stalls. Bump to 10 min, or use `extendLock()` periodically
  while the LLM is streaming.
- **`stalledInterval: 60_000` + `maxStalledCount: 1`** kills jobs
  on the second stall. With LLM jobs this is too aggressive. Bump
  `maxStalledCount` to 2 for LLM-heavy workers.

---

## 3. CPU-bound hot paths

### 3.1 jsdom + Readability is the worst offender

`fetchAndParse.ts:124` and `:246` and `websiteSync.ts:190` all do
`new Readability(document).parse()` against a `JSDOM(html).document`.
jsdom is a JavaScript reimplementation of a browser DOM — written
in JavaScript. Parsing a 200KB marketing email is **150–400ms of
pure event-loop hogging** in steady state, occasionally spiking to
2s on layout-heavy pages. The web-research feature does this 25x
per topic.

**Fix in two layers:**

#### Layer A: htmlparser2 first

Most "give me the largest text block + title + canonical link"
heuristics work fine against a streamed token stream. `htmlparser2`
is 10–50x faster than jsdom for the same input — it's a SAX-style
event parser, no DOM is constructed. Pair with `dom-serializer`
when you need a partial DOM tree.

```ts
// apps/worker/src/services/extractArticle.ts
export async function extractArticle(html: string, url: string) {
  // Tier 0: ultra-fast metadata-only sniff. Determines if the
  // page is even worth parsing further (rejects 403s, captcha
  // pages, link farms).
  const sniff = quickSniff(html); // htmlparser2 SAX, < 5ms
  if (sniff.thin) return null;

  // Tier 1: Readability against a partial DOM constructed only
  // from <article>, <main>, or the largest <div> in the body.
  // Our own implementation; ~20ms median.
  const tier1 = await fastReadability(html);
  if (!isThin(tier1)) return tier1;

  // Tier 2: full jsdom + Mozilla Readability. Slow but thorough;
  // ~150ms median. ESCALATES into a worker_threads pool — see 3.2.
  const tier2 = await jsdomPool.run({ html, url });
  if (!isThin(tier2)) return tier2;

  return null;
}
```

`@postlight/parser` is a viable Tier-2 replacement — it ships its
own light DOM and is faster than jsdom + Mozilla. Worth A/B-ing.

**Impact:** ~70% of pages exit at Tier 0 or Tier 1, saving
~120ms per page on average. Over 25 web-research fetches that's
3 seconds reclaimed per topic run.

**Effort:** 2 days (write the fastReadability heuristic, integrate
the pool, A/B against current behaviour on a corpus).

#### Layer B: worker_threads pool for Tier 2

When jsdom is unavoidable, run it off the event loop. Node's
built-in `worker_threads` is the right primitive — no transpilation,
no IPC overhead beyond `postMessage`.

```ts
// apps/worker/src/services/jsdomPool.ts
import { Worker } from 'worker_threads';
import { join } from 'path';

class JsdomPool {
  private workers: Worker[] = [];
  private queue: Array<{...}> = [];
  // Pool size: 4 by default, configurable via env.
  // Each worker has its own V8 heap, so jsdom GC doesn't pollute
  // the main process.
}
```

The worker script (`apps/worker/src/services/jsdomWorker.ts`) is
~30 lines: receive `{html, url}`, run jsdom + Readability, postMessage
the extracted text back, loop.

**Impact:** zero event-loop blocking from jsdom. Wall-clock per
parse is unchanged but the whole rest of the worker keeps moving.
The hidden gain: GC stops freezing the main process when jsdom
allocates and drops 50MB of DOM nodes per parse.

**Effort:** 1 day. Risk: low; jsdom is stateless per-call.

**Trade-off:** memory floor goes up by ~30MB per pool worker
(four threads × 30MB ≈ 120MB resident). Worth it.

### 3.2 Regex chains in body cleaning

`cleanBody`, `stripAdSectionsStrict`, `sanitizeHtml`,
`extractSubjectTemplate`, `senderDomainTag`, and the various tag
filters in `@rose/email-parser/src/metadata.ts` all run regex chains
over potentially-large strings. Specific concerns:

- `Email.tsx`'s `sanitizeHtml` (the SPA-side one) has 8 sequential
  `.replace` passes plus a regex `replace(/<a\b...>/, …)` callback.
  For a 500KB HTML body that's ~80ms in the renderer. **It runs in
  the iframe sandbox already**, so this is less critical for prod
  perf, but it does spike React render times.
- `@rose/email-parser`'s `cleanBody` runs ~15 regex passes. Each
  pass allocates a new string. For a typical newsletter body,
  ~30ms. For a 1MB outlook signature thread, ~300ms.

**Two cheap wins:**

1. **Combine regex passes** where possible. Multiple `.replace`s
   that don't depend on each other can be merged into a single
   alternation. Reduces string allocations.
2. **Switch to `re2` for hot regexes**. `re2` is Google's regex
   library with linear-time guarantees and a Node binding (`re2`
   on npm). It's faster than V8's regex for big inputs and immune
   to ReDoS. Replace selectively — V8 regex is fine for short
   strings.

**Impact:** moderate. Saves ~20ms per ingest, ~500ms per very-large
email.

**Effort:** half day for the regex audit, half day for the re2
swap.

### 3.3 JSON.parse on LLM streams

In `generatePage.ts`, the streamed Ollama response is buffered into
a single string, then `JSON.parse(extractJson(buffered))`. For long
synthesis outputs (15k chars), JSON.parse is ~10–30ms — synchronous,
on the main event loop.

**Fix:** since the Ollama stream is line-delimited NDJSON with a
final `done: true`, we can parse incrementally. `stream-json` (npm,
MIT) is the standard streaming JSON parser. Or, simpler: collect
the buffer but **defer the parse via `setImmediate()`** so the
event loop tick yields between LLM streaming and parse.

**Impact:** small but real — ~10ms reclaimed per generation on the
main event loop. Free.

**Effort:** half day.

### 3.4 Cosine similarity loops

`apps/worker/src/lib/vec.ts:cosine` is correct but called in tight
loops:

- `pageAssignment.ts:findPageForEmail` runs cosine over up to 50
  candidate page centroids per ingest.
- `taxonomySnap.ts:suggestTaxonomy` runs cosine over every tag
  centroid (potentially hundreds) and every category centroid per
  generation.
- The web-research scoring loop will run cosine over 25–100
  fetched docs against the topic centroid.

The current implementation:

```ts
function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}
```

For 768-dim `nomic-embed-text` vectors, that's ~2300 ops per
comparison. V8 JIT-compiles this fine; ~3μs per call. But
**boxed `number[]` is the issue**: each element is an
8-byte double + 8-byte boxed pointer + V8's hidden-class metadata.
A 768-dim `number[]` is ~12KB; cache-miss heavy.

**Fix:**

1. **Store as `Float32Array`** at write time. `Float32Array(768)` is
   3KB contiguous, cache-friendly. Halves memory, doubles speed for
   the cosine loop.
2. **Pre-normalise** vectors at write time. Store unit vectors;
   cosine = dot product. Saves the `Math.sqrt` per call.

```ts
// Mongoose: store as Buffer, view as Float32Array
embedding: { type: Buffer, default: null, select: false },
embeddingDim: { type: Number, default: 0 },

// In code:
const view = new Float32Array(emb.buffer, emb.byteOffset, emb.length / 4);
```

3. **Batch SIMD via WASM**. `node-tfidf` and `simd-vector` are
   available. For our scale, probably overkill — Float32Array +
   pre-normalisation is sufficient.

**Impact:** taxonomy snap goes from ~50ms (200 tags × 768 dims) to
~10ms. Page assignment under 5ms. Memory footprint of embeddings
halves. Real improvement under web-research load.

**Effort:** 1 day (migration script for existing embeddings + code
changes).

**Trade-off:** Float32 has 7-digit precision vs Float64's 15. For
cosine similarity this is well within noise. Confirmed by every
embedding-search system in production (Pinecone, Qdrant, Weaviate
all use Float32).

### 3.5 Native escalation for the truly hot loop

If, after all of the above, cosine + Readability are *still* the
hot loop in flame graphs, the right move is a Rust addon via
`napi-rs` exporting two functions:

- `extract_article(html: &str) -> Option<Article>` — wraps
  `readability` (the Rust crate) over `kuchikiki` parser.
- `cosine_batch(query: &[f32], corpus: &[&[f32]]) -> Vec<f32>` —
  batched cosine using SIMD via `wide` or `glam`.

Compiles to a `.node` file Node loads natively. No JS-call overhead
beyond the bridge. ~10–20x speedup on the hot loop.

**This is the only place a native sidecar is recommended.** Don't
do it until you have flame graphs proving the loop is the bottleneck;
the maintenance overhead of a Rust crate in a TS monorepo is real.

**Effort:** 1 week including build pipeline integration. Don't ship
this in Phase 1 of the perf roadmap; defer until measurement says
it's needed.

---

## 4. Memory & GC

Node's V8 heap is tuned for general-purpose web servers, not for
data-pipeline workloads where 500KB email bodies + 12KB embeddings +
30MB jsdom DOMs churn through 100x per minute. Symptoms:

- Long major GC pauses (occasionally 50–200ms) during which
  *everything* stops.
- RSS climbing slowly over hours from fragmentation.
- OOM-kill on small VPS deploys after a long sync.

### 4.1 Tune V8 explicitly

Add to the worker's `NODE_OPTIONS`:

```bash
NODE_OPTIONS="--max-old-space-size=2048 --max-semi-space-size=64"
```

- `max-old-space-size`: cap at 2GB instead of V8's default
  (1.5GB on most systems). For the LLM worker with big prompts.
- `max-semi-space-size`: bump from 16MB to 64MB. The young
  generation handles short-lived allocations like jsdom's per-parse
  DOM. Bigger semi-space means fewer minor GCs but each takes
  longer; 64MB is the empirical sweet spot for this kind of
  workload.

**Impact:** ~30% reduction in GC time. Fewer 100ms pause spikes.

**Effort:** 5 minutes. Validate with `--trace-gc`.

### 4.2 Reduce allocations on hot paths

- The cosine fix in 3.4 is also a memory fix — Float32Array halves
  embedding memory.
- `Mongoose .lean()` (covered in 5) returns plain objects, not
  hydrated Documents. Saves ~10KB per Email doc in the working set
  during ingest sweeps.
- String concatenation in template rendering. `renderTemplate` in
  `@rose/llm` does many `replace` passes over an ever-growing
  string. Switch to a single buffered `Array.join` strategy.
- `Buffer.from(jsonString, 'utf8')` instead of repeatedly slicing
  strings when we know we're going to send via HTTP.

### 4.3 Streams instead of buffers

Multiple sites read entire response bodies into memory:

- LLM streaming buffers the whole completion before parsing.
- Email body fetches buffer the entire IMAP message.
- HTTP downloads in `fetchAndParse.ts` `await response.text()`.

All of these can be progressive. For HTML extraction, `htmlparser2`
streams; for LLM, our wrapper already exposes `onToken` callbacks.
For IMAP, `imapflow` exposes a stream-mode body fetch.

**Impact:** lower peak memory under burst, especially for 5MB news
articles or long synthesis prompts.

**Effort:** moderate; depends on call site.

### 4.4 Avoid the working-set blowup on Email

`Email.html` and `Email.rawText` live on the Email document. A
heavy user has tens of thousands of emails; their `Email` collection
fills with HTML payloads. Every `.find({userId})` without a
projection pulls those bodies into the worker's memory.

**Fix:**

- Audit every `Email.find` for explicit `.select('-html -rawText')`
  unless the body is needed.
- Long-term: move bodies to a separate `EmailBody` collection
  (or GridFS) keyed on `emailId`, lazily joined. Email queries that
  don't need the body never load it. Compress bodies at rest with
  zstd.

**Impact:** big. Worker RSS drops noticeably for heavy users; query
latency on `Email.find` halves (less data over the wire).

**Effort:** 2 days for the migration + dual-write transition + cleanup.

---

## 5. MongoDB & Mongoose

### 5.1 `.lean()` audit

We have 67 `.lean()` calls and 171 query call sites in the worker.
Math: ~104 queries don't lean. Some rightly hydrate (we mutate and
save), but a meaningful fraction return docs that get read-only
treated. **Mongoose Document hydration is ~5x slower than plain
object** for objects with many fields.

**Action:** sweep `apps/worker/src/processors/*.ts` and add `.lean()`
to every query whose result isn't `.save()`d. Use `as unknown as`
cast where TS friction shows up.

**Impact:** ~20–40% off ingest-path latency. Free.

**Effort:** 2 hours, careful eyes-on. Risk: low; types catch most
mistakes.

### 5.2 Projection (`.select()`) discipline

Same idea as `.lean()`: explicitly project the fields you need.
Especially for queries that return many docs.

```ts
// Bad — pulls everything including html, rawText, embedding
const emails = await Email.find({ userId, threadKey });

// Good
const emails = await Email.find({ userId, threadKey })
  .select('_id from to subject date threadKey priority')
  .lean();
```

The most-impactful targets:

- `Email.find` everywhere (most callers don't need `.html`)
- `Page.find` (most callers don't need `.contentMd` or `.embedding`)
- `Sender.find` (often a count/exists check, not a body)

### 5.3 Bulk operations

`apps/worker/src/processors/imapSync.ts` and `gmailSync.ts` insert
emails one-at-a-time:

```ts
for (const msg of messages) {
  await Email.create({...}); // round-trip per email
}
```

Switch to:

```ts
await Email.bulkWrite(
  messages.map((m) => ({
    insertOne: { document: {...} },
  })),
  { ordered: false },
);
```

`ordered: false` lets the driver continue past dupes (which are
expected — `messageId` unique conflicts when the same email is
re-fetched). For 100 emails, this is **5x faster** end-to-end (one
round-trip vs 100).

**Impact:** large for big mailbox initial syncs. Modest steady-state.

**Effort:** 2 hours per sync worker.

### 5.4 Index audit

I'd bet a coffee that the following queries are doing collection
scans on real data:

- `Sender.find({ userId, autoQuarantine: true })` — used in
  `generatePage.ts:1042`. Need `(userId, autoQuarantine)` compound.
- `Page.aggregate` in `generatePage.ts:538` (counts per category) —
  needs `(userId, categoryId)` compound, not just the existing
  `(userId)`.
- `Email.find({ userId, 'from.address': addr })` in spam.ts:308 —
  needs `(userId, from.address)`.
- `WebDocument.find({ userId, hostKey, expiresAt: {$gt: ...} })`
  (proposed) — needs `(userId, hostKey, expiresAt)`.

**Action:** run `db.<col>.find(...).explain('executionStats')` for
each hot query in dev, look for `COLLSCAN`, add indexes
accordingly. Build them in the migration in `infra/`. Use partial
indexes where applicable (e.g. only index `autoQuarantine: true`
to keep the index small).

**Impact:** big on heavy users; difference between 50ms and 5s for
large `Page` collections.

**Effort:** half day.

### 5.5 Streaming cursors for sweeps

`reputationSweep`, `daydreamSweeper`, `cleanup`, `tagDigest` all
iterate over potentially-large collections. Today they use
`.find().lean()` which returns the entire result set. For a heavy
user's `Page` collection, that's hundreds of MB.

**Fix:** use cursors:

```ts
const cursor = Page.find({...}).select('_id ...').lean().cursor();
for await (const doc of cursor) {
  // process one at a time
}
```

Memory stays bounded regardless of collection size.

**Impact:** large for heavy users; eliminates OOM risk on sweeps.

**Effort:** half day.

### 5.6 Connection pooling

Mongoose connection pool defaults to `maxPoolSize: 100`. With four
worker processes that's potentially 400 simultaneous Mongo
connections — Mongo's default limit is 65536 but the *useful*
limit is much lower (each connection has a server-side cost).

Set per-process `maxPoolSize: 25`, surface as env. Total: 100
connections regardless of process count.

**Effort:** 1 hour.

---

## 6. Redis & BullMQ

### 6.1 Redis connection sharing

Today we have one shared `redis` client (`apps/worker/src/lib/redis.ts`)
used by all 24 workers and BullMQ itself. ioredis multiplexes well,
but BullMQ's blocking commands (BLPOP, BRPOP) hold a connection
during the wait — at high concurrency this starves other clients.

**Fix:** BullMQ already separates its own connection pool. Make
sure we pass the right config:

```ts
new Worker(name, processor, {
  connection: { host, port, password },  // BullMQ creates its own
});
```

Not `connection: redis` (sharing the global client). BullMQ's
docs warn against this; we currently do it.

**Effort:** 1 hour. Pure config change.

### 6.2 Rate limiter for fetch pool

The web-research fetch pool needs per-host rate limiting. BullMQ's
built-in rate limiter is per-queue — good for "max 100 outbound
emails per minute" but coarse. Per-host rate limits want a Redis
token bucket:

```ts
async function rateLimit(host: string): Promise<void> {
  const bucket = `rate:${host}`;
  const now = Date.now();
  const refillRate = HOST_RATES.get(host) ?? 1; // tokens/sec
  // Lua script: atomic bucket refill + decrement.
  // Returns wait-ms if no token available.
  const waitMs = await redis.eval(LUA_BUCKET, 1, bucket, refillRate, now);
  if (waitMs > 0) await sleep(waitMs);
}
```

Lua script lives in `apps/worker/src/lib/rateLimit.lua`. Atomic,
robust, ~50μs per call.

### 6.3 Queue priorities

BullMQ supports per-job priorities. Today we use it for the
ingest-by-date backfill (lower number = higher priority). Extend:

- Web-research jobs default priority 100 (low). User-initiated
  refresh = priority 10 (high).
- Cleanup / sweepers priority 200 (lowest).
- Push notifications priority 5 (highest, user-visible).

This matters when queues back up during a burst.

### 6.4 Watch for Redis as a bottleneck

With four worker processes and the rate limiter, Redis call volume
goes up. Single-instance Redis handles ~100k ops/sec, plenty. But
if you ever cluster, the `bull` keyspace must stay on one shard
(BullMQ requires it). Use Redis Cluster hash tags: `{rose:bull}:queue:foo`.

---

## 7. LLM (Ollama) throughput

### 7.1 Two Ollama instances

Today one Ollama container serves both generation (`llama3.1:8b`)
and embedding (`nomic-embed-text`). Ollama 0.5+ supports keeping
multiple models resident, but on a single GPU there's swap thrash
when alternating. Symptom: first embed call after a generation is
~2x slower because the embed model must reload.

**Fix:** two Ollama containers, two env vars:

```
OLLAMA_GENERATE_URL=http://ollama-gen:11434
OLLAMA_EMBED_URL=http://ollama-embed:11434
```

The provider resolver in `apps/worker/src/lib/providers.ts` already
routes by use case. Just two URLs.

If the host has one GPU, you can either (a) split GPU memory
between the two containers (most embedding models fit in 2GB; gen
model needs 8–16GB; works on 24GB cards) or (b) put the embed model
on CPU — `nomic-embed-text` runs at ~30 docs/sec on a modern CPU,
which is plenty.

**Impact:** generation latency stable, embedding latency 2x faster
when interleaved.

**Effort:** 1 hour (compose change + env wiring).

### 7.2 `OLLAMA_NUM_PARALLEL`

Default is 1 — one inference at a time. Bump to 4. Multiple
worker-llm processes can then run concurrent generations against
the same backend.

```yaml
ollama-gen:
  environment:
    - OLLAMA_NUM_PARALLEL=4
    - OLLAMA_KEEP_ALIVE=24h
    - OLLAMA_FLASH_ATTENTION=1
```

`OLLAMA_KEEP_ALIVE=24h` keeps the model resident; otherwise Ollama
unloads after 5 min idle and the next call eats a 30s reload.

`OLLAMA_FLASH_ATTENTION=1` enables flash attention if the model
supports it; ~30% throughput improvement on long contexts.

**Impact:** large at scale; under load multiple worker-llm processes
can saturate the GPU.

**Effort:** 5 minutes.

### 7.3 Batch embeddings

`nomic-embed-text` accepts an array of inputs in a single request.
We currently call once per text. The post-pass in
`taxonomySnap.ts:snapTagsByEmbedding` loops `await
provider.embed(model, t)` per novel tag — that's N round-trips.

**Fix:** add `provider.embedBatch(model, texts: string[])` and use
it everywhere we have multiple texts to embed:

- snapTagsByEmbedding (novel tags array)
- libraryEmbed when processing a batch of docs
- web-research fetched-docs embedding

10x speedup on those paths.

**Effort:** half day (provider implementation + call-site updates).

### 7.4 Speculative early synthesis

For web-research, we don't strictly need *all* fetched docs
embedded before we start the synthesis prompt. The top-K by
pre-embed-score (anchor-text + hostname trust) are likely to be the
most relevant. Start the synthesis prompt the moment those K are
embedded; backfill the rest afterward.

This is a wall-clock win — the synthesis is the long pole, so
overlapping it with the embed tail saves seconds.

**Effort:** moderate; needs careful pipeline coordination.

### 7.5 Streaming-aware token budgeting

The synthesis prompt for web-research can run 15k–30k input tokens.
At Ollama's 8k default context, that overflows silently — Ollama
truncates. **Set `num_ctx`** explicitly per model:

```ts
provider.generate({ model, prompt, options: { num_ctx: 32000 } })
```

`llama3.1:8b` supports 128k context. Set `num_ctx: 32000` for
synthesis, `8000` for short tasks (saves VRAM). The provider
config in `apps/api/src/lib/providers/ollama.ts` should expose this.

**Impact:** correctness (no silent truncation) + perf (right-sized
KV cache).

---

## 8. Embeddings & vector math

Covered in 3.4 and 7.3 above. One more lever:

### 8.1 External vector store (later)

Today vectors live on `Page.embedding` and `Email.embedding` and
search is full-collection cosine in app code. That's fine up to
~10k vectors per user. Past that, a dedicated vector store wins.

Options:

- **Mongo Atlas Search** — `$vectorSearch` operator. Zero new infra
  if you're on Atlas. We're explicitly self-hostable so this is
  optional.
- **Qdrant** (open source, Rust). Self-hosted via Docker. The
  go-to for self-hosted setups. ~5MB per 100k vectors with
  quantisation.
- **Weaviate** — heavier; more features.
- **pgvector** — if you ever migrate Mongo→Postgres.

**Don't do this yet.** Full-collection cosine on Float32Array over
1k pages is ~5ms; not worth the migration complexity until there's
real load.

---

## 9. HTTP & network

### 9.1 Use `undici` everywhere with a connection pool

We use a mix of `node-fetch`, the global `fetch`, and
implementation-specific clients. Standardise on `undici` with a
shared `Pool` per host:

```ts
import { Pool, Agent, setGlobalDispatcher } from 'undici';

setGlobalDispatcher(
  new Agent({
    keepAliveTimeout: 30_000,
    keepAliveMaxTimeout: 600_000,
    pipelining: 1,
    connections: 32,
  }),
);
```

Connection reuse alone saves ~20–50ms per fetch on TLS handshakes.
Critical for the web-research feature.

### 9.2 Brotli, gzip, deflate

Set `Accept-Encoding: br, gzip, deflate` on every outbound. `undici`
auto-decodes. Most news sites serve Brotli; ~60–70% bandwidth
saving over gzip for HTML.

### 9.3 HTTP/2 where servers support it

`undici` supports HTTP/2 via `Pool({ allowH2: true })`. Reduces
connection count for multi-asset pages (CSS, images during HTML
parsing). Mostly relevant if you ever add Playwright; for static
fetch, the win is marginal.

### 9.4 Concurrent IMAP IDLE

`imapSync.ts` polls each source on an interval. IMAP IDLE (push
notifications from the server) eliminates polling latency entirely
for IMAP servers that support it (Gmail, Fastmail, Cyrus).

`imapflow` already supports IDLE. Switch the IMAP sync from
polling to IDLE for capable servers; fall back to polling otherwise.

**Impact:** new mail visible in seconds instead of within the
poll interval (5 min default).

**Effort:** 1 day. Risk: connection management — must reconnect on
network blips.

---

## 10. Caching strategy

We have ad-hoc caches scattered around. A unified strategy:

| Layer                   | TTL        | Storage         | Eviction        | Use case                                                  |
| ----------------------- | ---------- | --------------- | --------------- | --------------------------------------------------------- |
| In-process LRU          | 1–60s      | Process memory  | LRU             | Hot lookups within a single job (taxonomy snap, robots)   |
| Redis                   | minutes–hr | Redis           | TTL             | Cross-process shared (sender brand, robots.txt)           |
| Mongo + TTL index       | hours–days | Mongo           | TTL index       | Fetched WebDocument; expensive computed views             |
| HTTP (ETag / 304)       | server     | Server-side     | server-side     | All outbound fetches                                      |
| BullMQ result           | minutes    | Redis           | manual          | Long-running idempotent jobs                              |

### 10.1 LRU library

`lru-cache` (npm, ISC) is the standard. Bound by either count or
size:

```ts
import { LRUCache } from 'lru-cache';
const cache = new LRUCache<string, Buffer>({
  max: 500,
  ttl: 60_000,
  sizeCalculation: (v) => v.length,
  maxSize: 50_000_000, // 50MB
});
```

### 10.2 Promote in-memory cache to Redis when cross-process matters

`taxonomySnap.ts`'s 60s in-memory cache is per-process. With four
worker-cpu replicas, each rebuilds independently. Move to Redis
with `SETEX taxonomy:<userId> 60 <gzip-json>`. ~2KB per user × 4
processes saved; correctness is the win — all workers see the same
snapshot.

### 10.3 robots.txt cache

Per-host, 24h TTL, Redis-backed. Don't fetch robots.txt 25 times
per topic-research run.

---

## 11. Streaming vs buffering

Covered in 4.3 generally. Specific opportunities:

- **LLM stream → page UI**: today the SSE streamer pushes tokens to
  the UI as they arrive. Good. **But** the worker still buffers the
  full output before parsing JSON. We could parse the streamed
  output incrementally and emit citation refs / tags earlier.
  Marginal UX win.
- **HTML extract on fetch chunk**: `htmlparser2` accepts chunks via
  `parser.write(chunk)`. We can `pipeline(response.body, parser)`
  and start extracting as bytes arrive. For a 2MB news page, this
  starts producing useful events 100ms into the download instead
  of after the whole download completes.
- **Email attachment streaming**: today we buffer entire
  attachments. For large files (>10MB), stream to disk or refuse
  outright with a setting.

---

## 12. The web-research feature, performance-specifically

Re-stated through the perf lens, the feature's pipeline:

```
1. Generate query plan (LLM call): ~1s
2. SearXNG search: ~500ms (parallel with #1 if possible)
3. URL frontier of ~25 URLs
4. Fetch loop, per URL:
   - robots.txt check: cached, ~1ms
   - HTTP fetch: 200–2000ms (varies wildly per host)
   - htmlparser2 quick sniff: ~5ms
   - extractArticle (worker thread): ~30ms median, ~150ms p99
   - embed: ~100ms
5. Score, optionally enqueue children to depth N
6. Synthesis prompt: 5–30s

Wall-clock target: < 2 min for a 1-level run.
```

### 12.1 Concurrency choices

- Fetch concurrency: **8 parallel fetches** per topic-research job
  (limited by the per-host rate limiter — usually only 1–2 hosts
  share traffic at any moment).
- Extract concurrency: **`os.cpus().length` worker threads** in the
  jsdom pool.
- Embed concurrency: **batch up to 8 docs per Ollama embed call**.
- Synthesis: serial; one prompt per topic.

### 12.2 Decoupled fetch and extract

Two queues:

- `web.fetch` — fetch URL, store raw HTML in Redis with 5-min TTL,
  emit `web.extract` job with the redis key. Fetch worker is
  I/O-only, never blocks on jsdom.
- `web.extract` — pull HTML from Redis, run extraction in
  worker_thread, persist `WebDocument`, emit `web.embed` job.
- `web.embed` — batched embed.

Each queue can scale independently. The fetch queue absorbs slow
servers without backpressuring extract.

### 12.3 Cache aggressively

- `WebDocument` per-user TTL 14 days; if a fetch within the window
  finds the same URL+hash, skip everything.
- Redis cache of robots.txt per host, 24h.
- Redis cache of SearXNG query results, 5 min — same query within
  5 min gets the same URL list (saves SearXNG load too).

---

## 13. Frontend / SPA performance

Performance isn't only the worker. The SPA has its own ceiling.

### 13.1 Bundle size + code splitting

Today the SPA is shipped as a single bundle. `vite build && du -sh
dist` would show the gzipped size. Suspect ≥ 600KB after the
KeyboardHelp / ConfirmModal / Skeleton additions. Each route
should be a dynamic import:

```ts
const Email = lazy(() => import('./routes/Email'));
const Page = lazy(() => import('./routes/Page'));
```

Vite + React Router play nicely with this. The biggest single
contributor to bundle size is probably `react-markdown` + remark
plugins; only Page actually uses them, so they should split into
that route's chunk.

**Impact:** TTI on first load drops noticeably; subsequent route
nav is unaffected (already cached).

**Effort:** 1 day (route-by-route conversion).

### 13.2 List virtualization

`Inbox`, `Search`, `Codex` (sender list), `Hidden`, `Quarantine`
all render long flat lists. Today React renders all rows up-front.
Past ~500 items, scroll perf degrades.

**Fix:** `@tanstack/react-virtual` (MIT, lightweight). Only renders
visible rows + a small overscan. Used by literally everyone.

**Effort:** half day per route.

### 13.3 Query staleness and background refetch

`@tanstack/react-query` is configured with `staleTime: 30_000` in
`main.tsx`. That's reasonable. Two opportunities:

- **`refetchOnWindowFocus: false`** is already set. Good for
  battery; consider re-enabling for the Home / Inbox routes
  specifically — those should always show fresh state.
- **Prefetch on hover.** Hovering an email link in `Inbox` could
  prefetch the email detail. Drops perceived latency on click.

### 13.4 `react-markdown` is a hot path

Rendering an article body re-runs markdown parsing on every state
change. `useMemo` on the parsed AST. Or render once and cache the
React tree.

`Page.tsx`'s `MarkdownWithCitations` component is the relevant
one. It already has `useMemo` for citation linking; ensure the
markdown parse itself memoises on `contentMd`.

### 13.5 Image strategy

If users have large hero images:

- Lazy-load with `loading="lazy"`.
- Generate WebP/AVIF on ingest; serve via the API with
  `Accept`-aware negotiation.
- Width-constrained thumbnails so the SPA doesn't request 4MB JPEGs.

We don't currently process images server-side. Worth adding `sharp`
to the worker for thumbnail generation if image-heavy newsletters
are common.

### 13.6 SSE / WebSocket

Live ingestion drawer uses SSE. Each open SSE consumes one server
connection. Bound the open-stream count per user (already done?
check), and gracefully reconnect with exponential backoff.

---

## 14. Language: TypeScript / Node ceiling

The honest tally of what TypeScript / Node costs us today:

### Pros

- Single language across SPA + API + worker (`@rose/shared` Zod
  schemas reused on both sides — huge correctness win).
- Mature ecosystem for everything we touch (BullMQ, Mongoose,
  ioredis, undici).
- TypeScript catches a meaningful number of bugs at compile time
  that would be runtime failures in JS / Python / Go.
- Hot reloading, fast dev cycle.

### Cons (and which ones bite us)

- **Single-threaded event loop**: real cost. Mitigated by process
  split (§2) + worker threads (§3.1 Layer B).
- **CPU loops 5–20x slower than native**: real cost on jsdom and
  cosine. Mitigated by Float32Array + algorithm choices (§3.4),
  escalation to Rust addon if needed (§3.5).
- **Memory + GC overhead**: real cost on data-pipeline workloads.
  Mitigated by V8 tuning (§4.1) + `.lean()` (§5.1) + body-storage
  refactor (§4.4).
- **Absence of a strong async-pipeline primitive**: subjective. We
  end up reaching for BullMQ for things Go would do with goroutines
  and channels. Workable but verbose.

### Where the language *isn't* the problem

- API request latency: dominated by Mongo + LLM.
- Worker concurrency: dominated by Ollama and Mongo.
- Memory for typical user: dominated by jsdom DOMs and email
  bodies.

**Net:** the language is neither the bottleneck today nor the
bottleneck the web-research feature creates. Don't rewrite.

### When to selectively reach for native

- Cosine over a corpus > 10k vectors: Rust addon via napi-rs.
  ~200 LOC.
- HTML extraction at sustained > 100 docs/sec: same. Use the
  `readability` Rust crate.
- TLS-fingerprinted scraping when SearXNG-discovered URLs hit
  bot-blocking WAFs: `got-scraping` (Node) usually solves this;
  if not, a Go `chromedp` sidecar.

These are surgical interventions, not language migrations. The
build pipeline already supports addons (the Vite + tsc setup is
fine).

---

## 15. Native sidecars: when and how

If the perf roadmap above lands and the system is *still*
CPU-bound (verified by flame graphs, not vibes), the sidecar
options:

### 15.1 Rust via `napi-rs`

Best fit for: cosine batch, Readability, regex-heavy text cleanup.

- `napi-rs` produces a `.node` file Node loads natively. No FFI
  boilerplate; macros do the work.
- `cargo` + `prebuildify` to ship pre-built binaries per platform.
- Build pipeline: add a `packages/native/` workspace with a
  `Cargo.toml` and a `napi.config.json`. CI builds binaries; Docker
  bundles the right one.

### 15.2 Python sidecar

Best fit for: Trafilatura content extraction, scikit-learn, the
NLP libraries. We don't currently need this; Trafilatura would be
the first reason.

- gRPC or a thin HTTP service. `grpc-js` works fine from Node.
- Heavier than Rust addon; only justifiable if the Python ecosystem
  has something irreplaceable.

### 15.3 Go sidecar

Best fit for: high-concurrency scraping, browser automation, where
we want goroutine semantics.

- `chromedp` for headless Chrome.
- `colly` for high-throughput scraping.

The recommended Phase-1 stack ships none of these. They're
contingent on measurement.

---

## 16. Observability: you can't optimise what you don't measure

Right now we have `logger.info` with `elapsedMs`. That's not enough
to track perf changes.

### 16.1 Per-job timing

Every BullMQ worker should emit a histogram on completion:

```ts
import { Histogram } from 'prom-client';
const jobDuration = new Histogram({
  name: 'rose_job_duration_seconds',
  labelNames: ['queue', 'outcome'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300],
});
```

Wire into BullMQ's `on('completed')` and `on('failed')`. Expose
`/metrics` from the worker over HTTP (unprivileged port, behind
auth or local-only).

### 16.2 Flame graphs for hot paths

Two options:

- **`0x`** (npm) — run `0x apps/worker/dist/index.js` for a
  ten-minute interactive flame graph of the worker. Best for one-off
  investigations.
- **`@datadog/pprof`** + `node --inspect` for production-safe
  sampling. Continuous profiles. Heavier setup.

### 16.3 Mongo profiler

`db.setProfilingLevel(1, { slowms: 100 })` flags any query > 100ms.
Run periodically; pull the slow ops; index them.

### 16.4 Dashboard

`grafana` + `prometheus` is the standard stack and runs in three
extra containers. For a self-hosted product this might be overkill;
a `/metrics` JSON endpoint surfaced in Settings → Diagnostics is a
fair compromise. Expose:

- Per-queue depth + processing time histogram
- Mongo connection pool stats
- Ollama call latency p50/p95/p99
- Web-research budget consumption per user per day
- GC pause histogram (from `perf_hooks.PerformanceObserver`)

---

## 17. Database infrastructure tuning

When the user runs `docker compose up`, MongoDB starts with
out-of-the-box defaults. For the workload, several knobs:

### 17.1 WiredTiger cache

Default: 50% of (RAM - 1GB). Fine for single-user deploys; explicit
on multi-tenant.

```yaml
mongo:
  command: --wiredTigerCacheSizeGB 2
```

### 17.2 Connection limits

Default: 65536. Doesn't matter unless you have a connection leak.
Verify with `db.serverStatus().connections`.

### 17.3 Compression

WiredTiger compresses with snappy by default. For email bodies
specifically, zstd is significantly better:

```js
db.runCommand({
  collMod: 'emails',
  validator: {...},
  // Mongo doesn't expose per-collection compression directly;
  // you set it at create-collection time in the migration.
});
```

A migration that recreates the collection with `block_compressor=zstd`
saves 30–50% disk on body-heavy collections.

### 17.4 Journal sync

Default: every 100ms. For a single-user laptop deploy, this is
fine. For a server, consider `--journalCommitInterval 30` (every
30ms) with battery-backed disk.

### 17.5 Redis persistence

Today `redis_data` is a Docker volume with default RDB persistence.
For BullMQ to recover from a crash without losing scheduled jobs,
**enable AOF**:

```yaml
redis:
  command: redis-server --appendonly yes --appendfsync everysec
```

`appendfsync everysec` is the standard durability/perf trade-off.
Without AOF, a Redis crash loses up to 5 min of scheduled jobs and
in-flight queue state.

---

## 18. Build & dev velocity

Performance of the dev loop affects iteration speed; iteration
speed affects how often you can land perf work. So:

### 18.1 `tsc --build` is slow on cold

Solo `tsc -b` runs project references serially. **Fix:**

- Vite's `vite build` for the web (already fast).
- For api/worker, use `tsx` in dev (already done) and `tsc --build
  --incremental` in CI.
- Move `pnpm typecheck` to **`tsc -b --noEmit --incremental`**;
  cache the build info file in CI.

### 18.2 ESLint

If we run `eslint .` on every save, that's seconds. `eslint --cache`
caches per-file results. `oxlint` (Rust-based, OXC project) is a
drop-in replacement that's 50–100x faster for the standard rule
subset; worth A/B-ing.

### 18.3 Vitest

Vitest already shards tests in parallel. `--threads=true` (default
since 1.0) is correct.

### 18.4 Docker layer caching

Worker image rebuild on every code change is slow because
`COPY package.json pnpm-lock.yaml ./` and `pnpm install` happen
near the top — good — but **`COPY . .`** invalidates the source
copy on every change. Order matters: copy lockfile, install, copy
source, build. We probably do this; verify.

---

## 19. Risk register

For each major change, what could go wrong:

| Change                                     | Risk                                                    | Mitigation                                              |
| ------------------------------------------ | ------------------------------------------------------- | ------------------------------------------------------- |
| Worker process split                       | Mis-routing jobs to wrong process                       | Each entry point lists its queues explicitly; tests verify the routing matrix |
| jsdom → worker_threads                     | postMessage data loss on large payloads                 | Cap payload size; fall back to in-process on failure    |
| `htmlparser2` first tier                   | Edge cases where Readability used to handle weird HTML  | A/B over a corpus before flipping default               |
| `.lean()` audit                            | Forgetting a `.save()` callsite that needs hydration    | TypeScript types catch most; PR review for the rest     |
| `bulkWrite` in sync                        | Partial batch failure semantics                         | `ordered: false` + per-result error logging             |
| Float32Array embeddings                    | Precision loss in cosine                                | Float32 is plenty for cosine; benchmark against current |
| Two Ollama containers                      | GPU memory exhaustion                                   | Profile per model; fall back to one container           |
| Native Rust addon                          | Build complexity, prebuild distribution                 | Defer until measurement justifies                       |
| AOF persistence                            | Marginal write-throughput cost                          | `appendfsync everysec` is the established compromise    |

---

## 20. Phased rollout

Ordered by impact-per-effort. Each phase is independently
shippable.

### Phase A — quick wins (1 week)

- `.lean()` audit across worker (§5.1)
- `bulkWrite` in IMAP / Gmail / RSS sync (§5.3)
- Index audit + add the 4–5 missing compounds (§5.4)
- Float32Array + pre-normalised embeddings (§3.4 + 8)
- V8 tuning env (§4.1)
- Two Ollama containers (§7.1)
- `OLLAMA_NUM_PARALLEL=4` + `OLLAMA_KEEP_ALIVE=24h` (§7.2)
- BullMQ connection pool fix (§6.1)
- Redis AOF (§17.5)
- BullMQ lock-duration bumps (§2.4)

**Net:** ~30–50% latency reduction, ~2x throughput. Zero new
infra.

### Phase B — process split (1 week)

- Four worker processes, four Dockerfiles, compose update (§2.2)
- `extractLib` shared bootstrap module
- Per-process concurrency tuning (§2.3)
- BullMQ rate limiter for fetch pool (§6.2)
- Redis-promoted taxonomy snap cache (§10.2)

**Net:** event loop never contended; web-research feature lands
without disturbing ingest.

### Phase C — CPU offload (1 week)

- `worker_threads` pool for jsdom (§3.1 Layer B)
- `htmlparser2` Tier-0/Tier-1 escalation (§3.1 Layer A)
- Batch embedding API in providers (§7.3)
- Streaming HTML extraction (§11)
- Email body extraction to separate collection (§4.4)

**Net:** ingest p95 halves; web-research per-topic wall clock under
2 min comfortably.

### Phase D — observability + tuning (3 days)

- Prometheus `/metrics` endpoint per worker process (§16.1)
- Mongo profiler enabled with slowms=100 (§16.3)
- Settings → Diagnostics dashboard (§16.4)
- `0x` flame graph one-off run; address top-3 hot frames

**Net:** subsequent perf work is data-driven, not vibe-driven.

### Phase E — frontend (1 week, in parallel)

- Route-level code splitting (§13.1)
- List virtualization (§13.2)
- Markdown render memoisation (§13.4)
- Image strategy (§13.5)

**Net:** SPA cold-start halves; long-list routes scroll smoothly.

### Phase F — escalation (only if needed, 1 week)

- Rust addon for cosine + Readability via napi-rs (§3.5, §15.1)
- Qdrant for vector search past 10k vectors per user (§8.1)
- `re2` for hot regex paths (§3.2)

**Net:** removes the language-imposed ceiling on hot loops.

### What's *not* in the plan

- Rewriting any service in Go / Rust / Python.
- Adopting Crawlee or Firecrawl.
- Introducing a service mesh.
- Multi-region deploy.
- Migrating off Mongoose to a thinner layer.

These are all viable in some future, but none of them clear the
impact-per-effort bar today.

---

## 21. Concrete numbers (estimates)

Anchoring the abstract gains in concrete-ish terms. Workload: heavy
user, 200 emails/day ingested, 50 web-research runs/day after the
feature lands.

| Metric                              | Today    | Phase A  | Phase B  | Phase C  | Notes                   |
| ----------------------------------- | -------- | -------- | -------- | -------- | ----------------------- |
| Ingest p50 (email→page visible)     | 8s       | 5s       | 4s       | 3.5s     | Bound by LLM            |
| Ingest p95                          | 45s      | 25s      | 18s      | 12s      | jsdom + GC              |
| Worker CPU idle %                   | 30%      | 50%      | 75%      | 85%      | Process split eats this |
| Worker RSS                          | 1.2 GB   | 900 MB   | 4×400 MB | 4×350 MB | Per-process basis       |
| Topic-research wall clock           | n/a      | n/a      | 4 min    | 90s      | Phase B+C               |
| Topic-research event-loop blocking  | n/a      | n/a      | 2 min    | < 1 s    | Phase C is the win      |
| SPA bundle (gzipped)                | 600 KB   | 600 KB   | 600 KB   | 600 KB   | Phase E: 220 KB initial |
| Mongo working set (heavy user)      | 4 GB     | 3 GB     | 3 GB     | 1.5 GB   | Body collection split   |
| GC pause p99                        | 180 ms   | 90 ms    | 70 ms    | 40 ms    | V8 tuning + body split  |

These are point estimates. Validate with benchmarks against a
copy-of-prod workload before/after each phase.

---

## 22. Closing

Performance work has a way of feeling unrewarding because the win
is "things you couldn't have done before, you can now do" rather
than a visible feature. With the web-research feature on the
horizon, this isn't optional — landing it on the current
single-process worker would create real, user-visible slowness as
soon as a couple of users are concurrently researching topics.

The good news: **there's no architectural rework here**. Every
change is incremental, well-scoped, individually shippable. The
process split is the one with operator-visible blast radius;
everything else is internal.

Total effort estimate: **~3 weeks of focused engineering** to ship
Phases A–C, which is the threshold at which the web-research
feature can ship safely. Phases D–F can follow asynchronously.

Don't rewrite the language. Profile before optimising. Measure
twice, cut once.

---

*Generated against the snapshot at `9a3e213`. References reflect
the codebase at that commit; if files move, the architecture is the
same but the citations are stale.*
