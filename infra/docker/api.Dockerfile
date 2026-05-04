ARG NODE_VERSION=22-alpine
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

FROM node:${NODE_VERSION} AS runner
RUN corepack enable
# `nvidia-container-toolkit` injects glibc-linked binaries (notably
# /usr/bin/nvidia-smi) into the container at runtime when the host is
# configured for GPU passthrough. Alpine's musl can't run them as-is —
# `gcompat` provides the glibc shim so /api/system/stats can shell
# out to nvidia-smi for GPU telemetry. No-op on hosts without a GPU.
RUN apk add --no-cache gcompat
WORKDIR /repo
ENV NODE_ENV=production
COPY --from=build /repo /repo
EXPOSE 4000
USER node
CMD ["node", "apps/api/dist/index.js"]
