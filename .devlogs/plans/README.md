# Plans

Forward-looking specs for features that haven't shipped yet. Each plan
captures the goal, user-facing surface, data-model changes, API + worker
work, dependencies, deferred scope, and open questions — enough that a
future implementation pass can start without re-deriving the design.

When a plan ships, fold its content into the relevant top-level devlog
(`00-architecture.md`, `01-data-model.md`, …) and either delete or
archive the plan in this folder.

## Roadmap

Priority is a coarse leverage estimate (5 = changes what the product
*is*; 1 = nice-to-have). "Depends on" lists features that must ship
first for the plan to make sense.

| #  | Plan | Priority | Depends on |
| -- | ---- | -------- | ---------- |
| 01 | [Ask the Wiki — RAG chat](./01-ask-the-wiki.md) | 5 | embeddings (✓) |
| 05 | [URL + document ingestion](./05-url-and-document-ingestion.md) | 5 | parse pipeline (✓) |
| 02 | [Reply assistant](./02-reply-assistant.md) | 4 | LLM provider (✓), Senders (✓) |
| 04 | [Outbound delivery](./04-outbound-delivery.md) | 4 | Sources (✓), digest (✓) |
| 03 | [Rules engine](./03-rules-engine.md) | 4 | parse pipeline (✓), Senders (✓) |
| 07 | [AI capabilities](./07-ai-capabilities.md) | 3 | LLM provider (✓), embeddings (✓) |
| 08 | [Operational + QoL](./08-operational-qol.md) | 3 | — |
| 06 | [External sources](./06-external-sources.md) | 2 | ingest pipeline (✓) |
| 09 | [Daydream — idle research enrichment](./09-daydream.md) | 3 | LLM provider (✓), workers (✓), safeFetch (✓) |
| 10 | [Discovery — search without a search engine](./10-discovery.md) | 4 | Daydream (✓), webFetch (✓), embeddings (✓) |
| 11 | [Maps — events + wiki places (Tier A)](./11-maps.md) | 3 | webFetch (✓), Nominatim (✓), entity extraction (✓) |

## Build-order recommendation

1. **01 + 05 together** — these two redefine the product. Chat turns
   the archive into a workspace; URL/document ingestion expands the
   wiki beyond email so it becomes a real knowledge base.
2. **02 + 03** — once the data is broader, give the user *agency*:
   draft replies that pull from the wiki, and explicit automation rules.
3. **04** — close the outbound loop: mail your own digest, push
   notifications, webhooks, share links.
4. **07** — opportunistic AI capabilities (weekly briefing, vision,
   cross-page synthesis) that reuse the existing provider plumbing.
5. **08** — durable QoL: PWA + offline, read-state, saved searches,
   export, multi-user. Done last because they touch many surfaces.
6. **06** — broadest scope, lowest leverage. Slack/Discord ingestion
   and two-way calendar are interesting but depend on third-party APIs
   that come with their own auth flows. Park until 1–5 ship.

## Cross-cutting concerns

A few things every plan should keep in mind:

- **Cost discipline** — every LLM call should respect the user's
  configured provider; defaults must be local-first (Ollama) so the
  app works without an API key.
- **Encryption at rest** — anything storing third-party credentials or
  message bodies for new sources should reuse the existing
  AES-256-GCM helper (`apps/{api,worker}/src/lib/crypto.ts`).
- **Streaming UX** — long LLM tasks (chat, briefing, reply drafts)
  should stream over SSE the same way the existing `/api/jobs` channel
  does.
- **Job semantics** — anything that fans out should be a BullMQ queue;
  add to `apps/api/src/lib/queues.ts` and wire a worker in
  `apps/worker/src/processors/`.
- **Per-user isolation** — every new collection gets `userId` indexed
  and every query scopes by it. No cross-tenant leakage.
