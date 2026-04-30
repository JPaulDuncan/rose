# ADR 0004 — In-process cosine for vector search until we outgrow it

## Status
Accepted, 2026-04-30.

## Context
Mongo Community 7 ships limited vector capabilities; `$vectorSearch` is Atlas-only.
Pulling Qdrant or pgvector adds another service to the compose stack and another moving
piece for self-hosters.

## Decision
Store embeddings in `pages.embedding` and rank in-process with cosine in
`services/search.ts`. Hide all of this behind `searchPages`.

## Consequences
- ≤ ~50K pages per user keeps p95 search under 100ms — generous headroom for v1.
- Memory footprint scales linearly with `numPages × dim × 8` bytes; for a 768-dim model
  and 50K pages, that's ~310MB per user, only loaded on demand per query.
- When we outgrow this, swap the implementation; the API contract is stable.
