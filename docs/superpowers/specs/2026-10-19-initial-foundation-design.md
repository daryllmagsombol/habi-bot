# Habi Initial Foundation — Design

- **Status:** Proposed for user review. No implementation is authorized by this document alone.
- **Date:** 2026-10-19
- **Scope:** The runnable repository subset of H-009
- **Implementation plan:** [2026-10-19-initial-foundation.md](../plans/2026-10-19-initial-foundation.md)

## Context and decision

Habi's delivery rules require the P0 feasibility gate (H-001 through H-008) to pass before P1 work starts. That gate has **not** passed. The user approved a bounded **tooling-only exception**: build enough runnable repository foundation to evaluate P0 work, without claiming a product capability or passing any phase gate.

This exception authorizes only:

- one pnpm workspace orchestrated by Turborepo;
- a minimal Next.js/React/Tailwind web shell;
- a NestJS API entrypoint with one health endpoint;
- a separate, inert NestJS worker entrypoint;
- shared contract and configuration packages;
- a loopback-only local PostgreSQL Compose service; and
- verified install, dev, build, lint, typecheck, test, HTTP, worker, and browser checks.

It does **not** authorize authentication, users, sessions, chat, Bots, models, Hermes, uploads, memory, an ORM, migrations, a real queue, application container images, production deployment, Nginx/Cloudflare, or CI implementation. Bun is deferred; Node remains the runtime baseline.

**H-009 is not closed by this work.** It remains open until every acceptance criterion is evidenced, including any application Docker contexts required by the issue and the full reproducible-build review. No P0 or P1 issue status changes as a result of this plan.

## Goal

A clean checkout must support this sequence with no network secrets and no external services:

```text
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

After a build, the API must answer `GET http://127.0.0.1:3001/health`, the web app must render an honest scaffold at `http://127.0.0.1:3000`, and the worker must boot and shut down cleanly without opening an HTTP listener or contacting a provider. Local PostgreSQL must be startable through Compose and report healthy when a Docker daemon is available.

## Non-goals

- No simulated sign-in, chat, Bot creation, model call, or Hermes connection.
- No database schema, ORM, migration, queue, cache, or background polling.
- No real credentials, provider keys, or production database configuration.
- No production Compose stack, reverse proxy, image registry, or CI workflow.
- No Bun scripts, benchmarks, or alternate runtime paths.
- No README edit while the existing README writer is still active.

## Architecture

```text
habi-bot/
├── apps/
│   ├── web/                  # @habi/web — Next.js, React, Tailwind (UI designer lane)
│   └── backend/              # @habi/backend — Nest API and worker (backend lane)
├── packages/
│   ├── contracts/            # @habi/contracts — built TypeScript contract package
│   └── config/               # @habi/config — shared tsconfig and ESLint base
├── scripts/                  # foundation verification only
├── compose.yaml              # local PostgreSQL only
├── .env.example              # loopback development placeholders
├── package.json              # workspace scripts and exact package manager pin
├── pnpm-workspace.yaml
├── pnpm-lock.yaml            # one lockfile
└── turbo.json
```

The API and worker are separate entrypoints in `apps/backend` but share one Nest package. The worker is intentionally empty of HTTP and integration providers. The web shell is static and does not call the API, so no CORS, client, or fake status behavior is introduced.

## Stack and version preflight

Candidate versions below are **research inputs, not mandates**. Every pin must be verified against the registry and official support documentation before the lockfile is written. If a candidate is unavailable or unsupported, choose the nearest officially supported exact version and record the deviation in the implementation evidence; do not silently carry a stale pin.

| Area | Candidate / local baseline | Evidence required before pinning |
|---|---|---|
| Node | 24.20.0 installed locally; baseline 24.x | `node --version`; Next, Nest, and Turbo `engines` metadata; Node 24 support statements |
| pnpm | 12.5.1 installed locally; registry candidate 12.14.x | `pnpm --version`; `npm view pnpm@12 version`; exact `packageManager` pin |
| Turborepo | 2.11.9 | registry version and `engines` |
| Next.js | 16.4.2 | registry version, `engines`, React peer range |
| React | 19.3.1 | registry version and matching DOM types |
| Tailwind CSS | 4.3.3 | registry version and `@tailwindcss/postcss` peer requirements |
| NestJS | 12.2.x core/common/platform-express/CLI | registry version, `engines`, package `type`/exports, Nest CLI TypeScript support |
| TypeScript | 6.0.3 | registry version and Nest CLI 12 compatibility |
| PostgreSQL image | 18.6.x | registry tag exists; image `VOLUME`/`PGDATA` and official image documentation |

Research leads to confirm rather than assume:

- Nest 12 may be ESM-only. If so, compile with `module`/`moduleResolution: NodeNext`, use `.js` suffixes on relative imports, and rely on Node 24's supported `require(esm)` interop where a CommonJS consumer appears. Do not add CommonJS shims.
- TypeScript 6 support must be confirmed against Nest CLI 12 before pinning. If unsupported, pin the latest supported TypeScript and record why.
- Next 16, React 19, and Tailwind 4 have specific peer and PostCSS requirements. Use the current official setup for the installed majors.
- PostgreSQL 18 may use a different volume root than older images. Verify the chosen image's `VOLUME`/`PGDATA`; do not copy `/var/lib/postgresql/data` from older examples.

## Contracts and interfaces

`@habi/contracts` is the only shared runtime package. It has no dependencies, compiles to `dist`, and is consumed through the workspace link so Node resolves compiled JavaScript and declarations rather than TypeScript source.

```ts
export interface HealthResponse {
  status: 'ok';
  service: 'api';
}
```

The package must expose:

- `"type": "module"`;
- `main: "./dist/index.js"`;
- `types: "./dist/index.d.ts"`;
- conditional `exports` for `types` and `default`;
- a `build` script that emits `dist`; and
- no runtime values beyond what the type requires.

The API imports `HealthResponse` as a type and returns exactly `{ status: 'ok', service: 'api' }`. No speculative user, chat, Bot, queue, or memory contracts are added.

## Runtime behavior

### Web

- Static server-rendered page on port 3000.
- Honest copy identifying the repository foundation and explicitly stating that sign-in, chat, Bots, model calls, and Hermes are absent.
- No forms, password fields, chat composer, disabled fake controls, fake metrics, or API calls.
- Mobile-first responsive layout, readable system typography, accessible landmarks and heading order, visible focus styles, and reduced-motion-safe styling.
- No external fonts, images, or network requests; the page must render offline after build.

### API

- Nest application listening on `127.0.0.1:3001` by default, configurable with `PORT`.
- `GET /health` returns HTTP 200 and the exact `HealthResponse` JSON.
- No database connection, authentication guard, model client, queue client, or provider environment variable is required to boot.

### Worker

- Separate entrypoint that creates a Nest application context only.
- No HTTP server, no polling, no queue, no provider connection, and no external network request.
- Logs one machine-readable ready event and remains idle.
- Handles `SIGTERM` and `SIGINT` by closing the context and exiting 0; repeated signals must not hang shutdown.

## Local PostgreSQL

Compose runs one local-only service:

- image tag pinned to the verified PostgreSQL 18.x candidate;
- port published only on `127.0.0.1`, never `0.0.0.0`;
- database, user, and password supplied through a local `.env`; Compose fails closed when the password is unset, and `.env.example` contains a placeholder only;
- `.env` ignored, with no password literal in Compose and no real credential committed;
- `pg_isready` healthcheck with bounded retries and start period;
- memory and CPU caps suitable for a shared development host;
- a named volume mounted at the path verified for the chosen image major; and
- no API, worker, web, queue, or proxy containers.

The application does not connect to PostgreSQL in this foundation. Compose is tooling evidence only.

## Tooling rules

- One workspace and one lockfile. Consumers reference local packages with `workspace:*`.
- Turbo `build` depends on `^build`, so `@habi/contracts` builds before consumers, including on a clean checkout.
- `typecheck` may depend on `^build` so compiled contract declarations exist for Node resolution.
- Development uses one watcher per TypeScript project. Do not run a second `tsc --watch` beside a Nest watcher.
- No path aliases in the Nest build. Use relative `.js` imports so `dist` runs correctly under Node ESM.
- Exact versions in manifests; no floating ranges. Dependency versions are chosen only after preflight.
- pnpm lifecycle scripts are allowlisted only for packages proven to need them. Blanket build-script approval is prohibited.
- No dependency is added for state management, UI components, HTTP clients, environment loading, process orchestration, tests, or queues unless the implementation proves it is necessary.

## Verification summary

The plan verifies:

1. registry and documentation preflight before pinning;
2. frozen install and one lockfile;
3. development entrypoints on 3000 and 3001, including clean watcher shutdown;
4. contracts build and Node import from `dist`;
5. clean-install build ordering through `^build`;
6. API health response over real HTTP;
7. worker boot and clean `SIGTERM` exit;
8. web build, rendered honest copy, and no fake functional controls;
9. browser checks at a narrow mobile viewport and a desktop viewport;
10. Compose configuration, loopback binding, volume path, resource caps, and actual health when a daemon exists;
11. normal build with a sanitized environment containing no provider or database secrets; and
12. explicit reporting of environment blockers and the still-open H-009 status.

## H-009 status

This foundation can evidence the workspace, web shell, backend entrypoints, shared packages, exact pinned versions, single lockfile, and reproducible local builds. It does **not** evidence application Docker contexts, CI/release checks, deployment, or a schema. H-009 stays open and must not be marked Done from this plan alone.

## Review focus

- Does the work stay inside the tooling-only exception?
- Is the web page honest, accessible, and free of fake product behavior?
- Is the worker genuinely inert, with no HTTP listener, polling, queue, or provider path?
- Does `@habi/contracts` resolve from built `dist` under Node ESM?
- Is the health contract exact and tested over HTTP?
- Do clean-install builds prove `^build` ordering?
- Are PostgreSQL loopback binding, volume path, caps, and healthcheck correct for the chosen image?
- Are secrets absent, and are lifecycle scripts narrowly approved?
- Is H-009 correctly left open with environment blockers reported?
