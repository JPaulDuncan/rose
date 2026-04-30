# ADR 0003 — BullMQ over Agenda for jobs

## Status
Accepted, 2026-04-30.

## Context
We need a job runner for streaming LLM calls, periodic source polling, and embedding.

## Decision
Use **BullMQ + Redis**. Already a dependency for caching/rate-limit; first-class
Workers, QueueEvents, repeatable jobs, and progress reporting. Agenda (Mongo-backed)
would let us drop Redis but offers weaker streaming/progress support.

## Consequences
- Redis becomes a hard dependency.
- We get out-of-the-box retries, backoff, repeatable jobs, and a progress-event bus we
  can fan out via SSE.
- Future: a tiny dashboard at `/admin/queues` (Bull Board) when we need ops visibility.
