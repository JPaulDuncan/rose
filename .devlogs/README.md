# Rose Devlogs

Generated design and architecture documentation produced during the initial build.
These docs are descriptive (what exists today) and prescriptive (what we plan next),
not auto-generated from code. Update them when the corresponding system changes.

| File | Purpose |
| --- | --- |
| [00-architecture.md](./00-architecture.md) | High-level system overview and request flow |
| [01-data-model.md](./01-data-model.md) | Mongo collections, indexes, relationships |
| [02-ingestion-pipeline.md](./02-ingestion-pipeline.md) | Per-source ingestion flow and dedupe |
| [03-llm-and-prompts.md](./03-llm-and-prompts.md) | Ollama integration and prompt registry |
| [04-search-design.md](./04-search-design.md) | Hybrid full-text + semantic search |
| [05-ux-spec.md](./05-ux-spec.md) | UX, keyboard map, command palette |
| [06-auth-and-security.md](./06-auth-and-security.md) | JWT, cookies, encryption |
| [07-docker-and-ops.md](./07-docker-and-ops.md) | Compose, healthchecks, GPU |
| [12-feature-audit.md](./12-feature-audit.md) | Snapshot audit of redundancy + gaps as of 2026-05-06 |
| [adr/](./adr/) | Short ADRs for irreversible decisions |
| [plans/](./plans/) | Forward-looking specs for unshipped features (RAG chat, rules, outbound, etc.) |
