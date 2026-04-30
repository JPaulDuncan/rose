# 07 — Docker & Ops

## Compose stack

`infra/compose/docker-compose.yml` brings up six services: `mongo`, `redis`, `ollama`,
`api`, `worker`, `web`. Healthchecks gate `api`/`worker`/`web` start so the app comes
up cleanly.

## First run

```sh
cd infra/compose
cp .env.example .env             # edit secrets
docker compose up -d
docker compose exec ollama sh /init-ollama.sh   # pull default models (~5GB)
open http://localhost:5173
```

## Healthchecks

- `mongo` — `mongosh ping`
- `redis` — `redis-cli ping`
- `api` — `GET /health` (process-up); `GET /ready` checks Mongo+Redis+Ollama and is
  used by orchestration probes
- `web` — Nginx defaults

## GPU

The `ollama` service ships ready for CUDA passthrough via the commented-out `deploy`
block. On a CUDA host:

```yaml
deploy:
  resources:
    reservations:
      devices:
        - driver: nvidia
          count: all
          capabilities: [gpu]
```

CPU-only inference works for `llama3.1:8b-instruct` but is slow (~3 tok/s). The
streaming UI is designed to mask that latency.

## Volumes

- `mongo_data` — database files
- `redis_data` — AOF persistence
- `ollama_data` — model blobs (large; ~5–20GB depending on models)

## Build pipeline

Multi-stage Dockerfiles per app. The `build` stage runs `pnpm install` and `pnpm build`
against only the workspace files needed for that app, keeping image size and build time
in check. Production images run as the `node` user.

## Logging

`pino` JSON logs to stdout. In dev, `pino-pretty` is wired via the transport. Pipe
through your log aggregator of choice in prod.

## Backups

Out of scope for v1; `mongo_data` and `ollama_data` are the two volumes worth snapshotting.
