# Backend image for both entrypoints: `api` and `worker`.
#
# Build context is the repository root, not this directory, so the pnpm workspace
# and pnpm-lock.yaml resolve exactly as they do locally:
#
#   docker build -f apps/backend/Dockerfile --target api -t habi-api .
#   docker build -f apps/backend/Dockerfile --target worker -t habi-worker .
#   docker run --rm -p 3001:3001 habi-api
#   docker run --rm habi-worker
#
# The Node base matches .node-version; pnpm comes from corepack at the exact
# version pinned by "packageManager" in the root package.json. No build args and
# no secrets are required; runtime environment is supplied by the caller.

FROM node:24.20.0-bookworm-slim AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@12.5.1 --activate
WORKDIR /app

# Build stage: build shared contracts first, then the NestJS API and worker.
FROM base AS build
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc ./
COPY apps/backend/package.json apps/backend/
COPY apps/web/package.json apps/web/
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
RUN XDG_CACHE_HOME=/tmp/pnpm-cache pnpm install --frozen-lockfile --store-dir /tmp/pnpm-store --filter "@habi/backend..." \
 && rm -rf /tmp/pnpm-store /tmp/pnpm-cache
COPY packages/config packages/config
COPY packages/contracts packages/contracts
COPY apps/backend apps/backend
RUN pnpm --filter @habi/contracts build \
 && pnpm --filter @habi/backend build

# Runtime stage: production dependencies, compiled output, non-root user.
FROM base AS runtime
ENV NODE_ENV=production
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc ./
COPY apps/backend/package.json apps/backend/
COPY apps/web/package.json apps/web/
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
# pnpm's store and cache are temporary directories removed in the same layer:
# node_modules keeps its own links, so the image does not carry downloaded
# packages twice.
RUN XDG_CACHE_HOME=/tmp/pnpm-cache pnpm install --frozen-lockfile --prod --store-dir /tmp/pnpm-store --filter "@habi/backend..." \
 && rm -rf /tmp/pnpm-store /tmp/pnpm-cache
COPY --chown=node:node --from=build /app/apps/backend/dist apps/backend/dist
COPY --chown=node:node --from=build /app/packages/contracts/dist packages/contracts/dist
WORKDIR /app/apps/backend
USER node

# HTTP API entrypoint (node dist/main.js).
FROM runtime AS api
# main.ts defaults to 127.0.0.1, which is unreachable through a published port.
ENV HOST=0.0.0.0
ENV PORT=3001
EXPOSE 3001
CMD ["node", "dist/main.js"]

# Headless worker entrypoint (node dist/worker.js); it exposes no port and stays
# inert until SIGTERM/SIGINT, matching the local Node launch path.
FROM runtime AS worker
CMD ["node", "dist/worker.js"]
