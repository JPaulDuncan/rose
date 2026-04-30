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
COPY apps/worker/package.json ./apps/worker/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY packages ./packages
COPY apps/worker ./apps/worker
RUN pnpm --filter @rose/shared build \
 && pnpm --filter @rose/db build \
 && pnpm --filter @rose/email-parser build \
 && pnpm --filter @rose/llm build \
 && pnpm --filter @rose/worker build

FROM node:${NODE_VERSION} AS runner
RUN corepack enable
WORKDIR /repo
ENV NODE_ENV=production
COPY --from=build /repo /repo
USER node
CMD ["node", "apps/worker/dist/index.js"]
