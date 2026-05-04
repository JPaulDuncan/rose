ARG NODE_VERSION=22-alpine
ARG NODE_RUNTIME_VERSION=22-bookworm-slim
FROM node:${NODE_VERSION} AS base
RUN corepack enable
WORKDIR /repo

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml turbo.json ./
COPY packages/config/package.json ./packages/config/
COPY packages/shared/package.json ./packages/shared/
COPY packages/db/package.json ./packages/db/
COPY packages/email-parser/package.json ./packages/email-parser/
COPY packages/llm/package.json ./packages/llm/
COPY apps/api/package.json ./apps/api/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY packages ./packages
COPY apps/api ./apps/api
RUN pnpm --filter @rose/shared build \
 && pnpm --filter @rose/db build \
 && pnpm --filter @rose/email-parser build \
 && pnpm --filter @rose/llm build \
 && pnpm --filter @rose/api build

# Runner is glibc-based (Debian) instead of Alpine so that the
# nvidia-container-toolkit can inject `nvidia-smi` and libnvidia-ml.so
# at runtime — Alpine's musl can't load NVML's glibc-linked .so files
# even with gcompat, which produced "NVML: Driver Not Loaded" inside
# the API container. /api/system/stats can now report GPU compute %,
# VRAM, and temperature alongside the Ollama loaded-model view.
FROM node:${NODE_RUNTIME_VERSION} AS runner
RUN corepack enable
WORKDIR /repo
ENV NODE_ENV=production
COPY --from=build /repo /repo
EXPOSE 4000
USER node
CMD ["node", "apps/api/dist/index.js"]
