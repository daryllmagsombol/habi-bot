# Web shell image (@habi/web).
#
# Build context is the repository root, not this directory, so the pnpm workspace
# and pnpm-lock.yaml resolve exactly as they do locally:
#
#   docker build -f apps/web/Dockerfile -t habi-web .
#   docker run --rm -p 3000:3000 habi-web
#
# The Node base matches .node-version; pnpm comes from corepack at the exact
# version pinned by "packageManager" in the root package.json. No build args and
# no secrets are required; runtime environment is supplied by the caller.

FROM node:24.20.0-bookworm-slim AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@12.5.1 --activate
WORKDIR /app

# Build stage: full (dev) dependency install, then `next build`.
FROM base AS build
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc ./
COPY apps/web/package.json apps/web/
COPY apps/backend/package.json apps/backend/
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
RUN XDG_CACHE_HOME=/tmp/pnpm-cache pnpm install --frozen-lockfile --store-dir /tmp/pnpm-store --filter @habi/web \
 && rm -rf /tmp/pnpm-store /tmp/pnpm-cache
COPY packages/config packages/config
COPY apps/web apps/web
RUN pnpm --filter @habi/web build \
 && rm -rf apps/web/.next/cache

# Runtime stage: production dependencies only plus the compiled Next.js output.
FROM base AS runtime
ENV NODE_ENV=production
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json .npmrc ./
COPY apps/web/package.json apps/web/
COPY apps/backend/package.json apps/backend/
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
# pnpm's store and cache are temporary directories removed in the same layer:
# node_modules keeps its own links, so the image does not carry downloaded
# packages twice.
RUN XDG_CACHE_HOME=/tmp/pnpm-cache pnpm install --frozen-lockfile --prod --store-dir /tmp/pnpm-store --filter @habi/web \
 && rm -rf /tmp/pnpm-store /tmp/pnpm-cache
COPY --chown=node:node --from=build /app/apps/web/.next apps/web/.next
COPY --chown=node:node --from=build /app/apps/web/next.config.ts apps/web/next.config.ts
WORKDIR /app/apps/web
USER node
EXPOSE 3000
CMD ["./node_modules/.bin/next", "start", "-H", "0.0.0.0", "-p", "3000"]
