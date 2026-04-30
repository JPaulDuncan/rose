# ADR 0002 — Reciprocal Rank Fusion for hybrid search

## Status
Accepted, 2026-04-30.

## Context
Hybrid retrieval combines lexical (BM25/Mongo `$text`) and semantic (cosine over
embeddings) results. Score scales differ wildly, so naive sum is meaningless. Common
options: RRF, learned re-rankers, alpha-weighted normalization.

## Decision
Use **RRF with k=60** to fuse ranks. No model required; works with any retrievers; mode
toggle (`text`/`semantic`/`hybrid`) drops a retriever cleanly.

## Consequences
- We don't need to train or tune a re-ranker for v1.
- We never use raw scores in the final ranking, which is fine for a small UI list.
- If recall ever needs improvement, swap to a cross-encoder re-ranker over the top-K
  fused candidates without changing the API contract.
