ARG NODE_VERSION=22-alpine
FROM node:${NODE_VERSION} AS base
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml turbo.json ./
COPY packages/config ./packages/config
COPY packages/shared ./packages/shared
COPY apps/web ./apps/web
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @rose/shared build \
 && pnpm --filter @rose/web build

FROM nginx:1.27-alpine AS runner
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
COPY infra/docker/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
