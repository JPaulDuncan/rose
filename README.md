# 🌹 Rose — Email-to-Wiki, locally

Rose ingests emails and turns each one into a structured wiki page using a
locally-running [Ollama](https://ollama.com) model. Hybrid keyword + semantic search,
revision history, drag-and-drop ingestion, IMAP / Gmail / webhook sources, and a
keyboard-first SPA. Self-hostable in one `docker compose up`.

```
React + TypeScript + Tailwind  ⇄  Express + BullMQ  ⇄  MongoDB + Redis + Ollama
```

## Quickstart

```sh
git clone <this repo>
cd rose
cp infra/compose/.env.example infra/compose/.env   # edit secrets
cd infra/compose
docker compose up -d --build
docker compose exec ollama sh /init-ollama.sh      # pull default models (~5GB)
open http://localhost:5173
```

Register an account, drag a `.eml` into the inbox, and watch the page generate live.

## Local development

```sh
pnpm install
docker compose -f infra/compose/docker-compose.yml up -d mongo redis ollama
pnpm dev          # starts api, worker, and web in parallel
```

The web app runs on `http://localhost:5173` and proxies `/api` to the API on `:4000`.

## Layout

```
apps/
  web/      React SPA (Vite + Tailwind + TipTap)
  api/      Express (auth, REST, SSE, webhook)
  worker/   BullMQ consumers (LLM generate, embed, IMAP, Gmail)
packages/
  shared/        Zod schemas + DTOs
  db/            Mongoose models
  email-parser/  mailparser + cleanup heuristics
  llm/           Ollama client + prompt registry + seeds
  config/        Shared tsconfig, Tailwind preset, eslint
infra/
  docker/        Dockerfiles per app + nginx config
  compose/       docker-compose stack
.devlogs/        Architecture, data-model, prompt, ops docs + ADRs
```

## Highlights

- **Local-first AI** — Ollama runs in-stack; nothing leaves your machine by default.
- **Standard + custom instructions** — every user starts with seed prompts for
  parsing, categorizing, generation, linking, and dedupe. Clone to customize, set a
  default per scope, share prompt variables with `{{mustache}}` slots.
- **Hybrid search** — Mongo `$text` + Ollama embeddings, fused with Reciprocal Rank
  Fusion. Toggle `text` / `semantic` / `hybrid` from the UI.
- **Streaming UX** — page generation streams tokens to the inbox drawer over SSE.
- **Keyboard-first** — `⌘K` palette, `g h/i/g/s` jumps, `/` to search.
- **Revisions** — every save (LLM or user) creates a new version; restore in one click.
- **Multi-user** — JWT (15m) + refresh cookie (7d). Per-user data isolation in the
  Mongo layer.
- **Multi-source** — manual upload, IMAP polling, inbound webhook (Bearer-token), and
  Gmail OAuth (refresh-token, encrypted at rest).
- **Structured-data fast paths** — receipts parse schema.org JSON-LD or hit a per-vendor
  registry (Amazon, Apple, USPS) before the LLM. Subscriptions and entity relations
  follow the same cascade. The admin's Extraction Coverage panel tracks the LLM-free
  ratio per extractor.
- **Wikidata-backed ontology** — organisations, products, persons, and places resolve
  to canonical Q-IDs. SPARQL relation enrichment (`employer`, `spouse`, `birthplace`,
  `headquartered-in`, …) lands triples into `EntityRelation` with `wikidataConfirmed`.
- **Recipes (IFTTT-style)** — wire trigger events to actions. Triggers include
  `email.ingested`, `page.created`, `tag.applied`, `time.scheduled`,
  `subscription.created`, and `subscription.renewed`.
- **Triage mode** — `j/k` walk the inbox, single-letter verbs act (archive / spam /
  page / defer / reply), `u` undoes the last reversible action.
- **Live worker queue stats** — Settings → Admin polls every five seconds, surfaces
  green/amber/red bands and per-queue depth for incident response.

See `.devlogs/` for design docs and ADRs.

## Useful scripts

| Command | What it does |
| --- | --- |
| `pnpm dev` | Run web + api + worker in parallel |
| `pnpm build` | Build all workspaces |
| `pnpm typecheck` | Type-check everything |
| `pnpm test` | Run the (vitest) test suites |
| `pnpm lint` | Lint everything |
| `pnpm format` | Prettier-fix everything |

## License

Source available under the MIT license. See `LICENSE` if/when added.
