# 04 — Search Design

## Hybrid retrieval

`apps/api/src/services/search.ts` runs two retrievers in parallel and fuses them:

1. **Text** — Mongo `$text` search across the `PageTextIndex` (weights 10/5/3/1 for
   title/summary/tags/contentMd). Returns up to 50 candidates, ranked by `textScore`.
2. **Semantic** — embed the query with the user's embedding model, then compute
   cosine similarity against every stored `pages.embedding` for the user. Top 50.

We then merge with **Reciprocal Rank Fusion**:

```
score(d) = Σ retriever 1 / (k + rank(d))   with k = 60
```

RRF needs no per-retriever calibration and gracefully handles missing scores from
either side. `mode=text` and `mode=semantic` skip the corresponding retriever.

## Filters

`tags`, `categoryId`, `from`, `to`, and `limit` apply to both retrievers. Filters run
inside Mongo for the text path; for the semantic path, we apply them as a `find`
predicate before computing cosine, so we never embed-rank documents the user can't see.

## Why in-process cosine

Self-hosted Mongo (no Atlas) doesn't expose `$vectorSearch`. For ≤ ~50K pages per user,
loading embeddings and computing cosine in Node is fine (sub-100ms). Above that we
have two options, both behind the same `searchPages` interface:

1. Atlas / Mongo 7 vector index — flip the implementation.
2. Sidecar Qdrant or pgvector — add a `searchVector` adapter, swap in `services/search.ts`.

## Snippets

Snippet generation is naive: we pick the first 220 chars surrounding the first query
token. Good enough for now. A future improvement is BM25-style snippet extraction over
the cleaned email text.
