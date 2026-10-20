# Habi Initial Foundation — Implementation Plan

> **Spec:** [Initial foundation design](../specs/2026-10-19-initial-foundation-design.md)
> **Status:** Proposed. Do not implement until the user has reviewed this plan and the design.
> **Scope:** The runnable tooling subset of H-009. The P0 gate has not passed, and H-009 remains open.

## Goal

Create one pnpm/Turborepo workspace with a minimal Next.js web shell, a NestJS API and inert worker, shared contracts and configuration, and a loopback-only local PostgreSQL Compose service. Prove the foundation with frozen install, clean-install build ordering, typecheck, lint, tests, real HTTP health, worker shutdown, browser checks, and Compose health where the environment permits.

## Architecture

```text
apps/web                 @habi/web        Next.js 16 / React 19 / Tailwind 4
apps/backend             @habi/backend    Nest API :3001 and headless worker
packages/contracts       @habi/contracts  HealthResponse, compiled to dist
packages/config          @habi/config     shared tsconfig and ESLint base
scripts/                 foundation verification only
compose.yaml             local PostgreSQL only, loopback-bound
```

The web app is static and does not call the API. The worker has no HTTP listener, polling, queue, or provider connection. PostgreSQL is not connected to either app in this foundation.

## Global constraints

- **Exception boundary:** this is a recorded tooling-only exception to the P0 sequence. It authorizes no auth, chat, Bots, models, Hermes, uploads, memory, ORM, migrations, real queue, application container images, production deployment, reverse proxy, Cloudflare, or CI implementation.
- **H-009:** do not close or mark Done. Report evidence; the full acceptance review remains with the parent/orchestrator.
- **Runtime:** Node 24.x is the baseline. Bun is deferred and must not appear in scripts, install instructions, or tests.
- **Versions:** no candidate version is pinned until registry and official-support preflight passes. Use exact versions in manifests. If a candidate is unsupported, choose the nearest supported exact version and record the deviation.
- **One lockfile:** `pnpm-lock.yaml` only. Local packages use `workspace:*`. Turbo `build` uses `^build` so contracts compile before consumers.
- **Contracts resolution:** consumers resolve `@habi/contracts` from built `dist` under Node ESM. No TypeScript-source imports across packages.
- **Nest build:** ESM-compatible `NodeNext` configuration, relative `.js` imports, and no path aliases. Use one watcher per TypeScript project.
- **Secrets:** no real credentials or provider keys. `.env` is ignored; only placeholder values belong in `.env.example`. Normal install/build/lint/typecheck/test must not require secrets or network provider access.
- **PostgreSQL:** local Compose only, published on `127.0.0.1`, with verified image volume path, healthcheck, and resource caps. No production Compose or Nginx.
- **pnpm lifecycle scripts:** approve only the exact packages that demonstrably need them after reviewing install output. No blanket build-script approval.
- **UI:** minimal, polished, honest scaffold. No fake sign-in, chat, forms, disabled product controls, fake metrics, or API-backed status.
- **README:** do not edit while the existing README writer is active. Final updates are conditional on confirmed terminal handoff.
- **Git:** no commits or pushes as part of this plan. Leave changes for review.

## Review focus

- Scope discipline against the tooling-only exception.
- Exact health contract and real HTTP verification.
- Worker inertness and clean signal shutdown.
- Contracts built to `dist` and resolved under Node ESM without path aliases.
- Clean-install build ordering through `^build`.
- PostgreSQL loopback binding, correct volume path, caps, and healthcheck.
- Secret hygiene and narrowly scoped lifecycle-script approvals.
- Honest, accessible, responsive web copy with no simulated product behavior.
- Accurate environment-blocker reporting and H-009 left open.

## Execution lanes and ownership

| Lane | Task | Owned paths | Concurrency |
|---|---|---|---|
| Root fixer | Task 1 | workspace root, `packages/**`, `compose.yaml`, root scripts | Serial; runs first |
| Backend fixer | Task 2 | `apps/backend/**` only | Starts after Task 1; parallel with Task 3 |
| UI designer | Task 3 | `apps/web/**` only | Starts after Task 1; parallel with Task 2; solely owns visual app |
| Root fixer resumes | Task 4 | `scripts/**`, root verification script entry, docs/plan evidence, conditional README | Starts after Tasks 2 and 3; no app edits |

No two lanes write the same file concurrently. Root ownership stays with the root fixer. The backend fixer never edits root or web files. The designer never edits root, backend, packages, or contracts.

---

## Task 1 — Serial foundation: workspace, contracts, config, PostgreSQL

**Owner:** root fixer. **Depends on:** user approval of this plan. **Must finish before Tasks 2 and 3.**

### 1.1 Version and support preflight

- [x] Record `node --version` and `pnpm --version`. Confirm the local Node baseline is 24.20.0 and pnpm is 12.5.1, or record the actual values.
- [x] Query the registry for each candidate and the latest compatible release:
  - `npm view pnpm@12 version`
  - `npm view turbo@2.11.9 version engines`
  - `npm view next@16.4.2 version engines peerDependencies`
  - `npm view react@19.3.1 version`
  - `npm view @tailwindcss/postcss@4.3.3 version peerDependencies`
  - `npm view @nestjs/core@12.2 version engines type`
  - `npm view @nestjs/cli@12 version engines`
  - `npm view typescript@6.0.3 version`
  - Verify the PostgreSQL tag exists and inspect its metadata, for example with `docker manifest inspect postgres:18.6-alpine`.
- [x] Check official support statements for Node 24 with Next 16/Nest 12/Turbo 2, Nest 12 ESM behavior, TypeScript 6 with Nest CLI 12, Next 16 with React 19 and Tailwind 4 PostCSS, and the PostgreSQL 18 volume/`PGDATA` layout.
- [x] If a candidate is missing or unsupported, select the nearest supported exact version and record the reason in the completion report.
- [x] Confirm the resolved compatibility matrix before creating manifests. Do not carry unverified versions into `package.json` or the lockfile.

### 1.2 Root workspace files

Create and own exactly:

- [x] `/Users/daryllmagsombol/Projects/habi-bot/package.json`
- [x] `/Users/daryllmagsombol/Projects/habi-bot/pnpm-workspace.yaml`
- [x] `/Users/daryllmagsombol/Projects/habi-bot/turbo.json`
- [x] `/Users/daryllmagsombol/Projects/habi-bot/.npmrc`
- [x] `/Users/daryllmagsombol/Projects/habi-bot/.gitignore`
- [x] `/Users/daryllmagsombol/Projects/habi-bot/.node-version`
- [x] `/Users/daryllmagsombol/Projects/habi-bot/.env.example`
- [x] `/Users/daryllmagsombol/Projects/habi-bot/compose.yaml`
- [x] `/Users/daryllmagsombol/Projects/habi-bot/pnpm-lock.yaml` (generated, never hand-edited)

Interfaces:

- [x] Root scripts: `dev`, `build`, `typecheck`, `lint`, and `test`. Task 4 adds `verify:foundation`, pointing at `scripts/verify-foundation.mjs`.
- [x] `packageManager` is an exact pnpm pin. `engines.node` reflects the verified Node 24 baseline; `engines.pnpm` matches the selected major.
- [x] `pnpm-workspace.yaml` includes `apps/*` and `packages/*` and contains no unrelated catalogs or overrides.
- [x] `turbo.json` defines:
  - `build`: `dependsOn: ["^build"]`; outputs for `dist/**` and `.next/**`, excluding `.next/cache/**`;
  - `typecheck`: `dependsOn: ["^build"]`;
  - `test`: `dependsOn: ["build"]` so built entrypoints exist;
  - `lint`: no build dependency;
  - `dev`: `cache: false`, `persistent: true`, `dependsOn: ["^build"]`.
- [x] `.npmrc` sets `engine-strict=true` and `save-exact=true`. Add no unrelated registry or auth settings.
- [x] `.gitignore` covers `node_modules/`, `.next/`, `dist/`, `.turbo/`, coverage, logs, `.env`, `.env.*` except `.env.example`, and OS editor artifacts.
- [x] `.node-version` contains the verified Node 24 baseline.
- [x] Configure lifecycle-script approvals only for exact packages proven necessary by install output. If none are needed, approve none. Do not enable all builds. (Install reported no build-script approvals needed; none configured.)

### 1.3 Shared config package

Create and own exactly:

- [x] `/Users/daryllmagsombol/Projects/habi-bot/packages/config/package.json`
- [x] `/Users/daryllmagsombol/Projects/habi-bot/packages/config/tsconfig/base.json`
- [x] `/Users/daryllmagsombol/Projects/habi-bot/packages/config/eslint/base.mjs`
- [x] `/Users/daryllmagsombol/Projects/habi-bot/packages/config/test/config.test.mjs` (necessary config assertion addition)

Interfaces:

- [x] Package name is `@habi/config`, private, ESM, with no build step.
- [x] Exports map `./tsconfig/base.json` and `./eslint/base.mjs`.
- [x] Base TypeScript config is strict and targets the verified Node 24 baseline. It must not force Next.js or Nest-specific compiler options that those apps must override.
- [x] ESLint base uses flat config with the selected TypeScript rules and no formatting/style rules. No Prettier dependency is added.
- [x] Config package dependencies are limited to the ESLint/TypeScript packages its exports actually import; ESLint and TypeScript are dev dependencies used by the config assertion test.

### 1.4 Contracts package

Create and own exactly:

- [x] `/Users/daryllmagsombol/Projects/habi-bot/packages/contracts/package.json`
- [x] `/Users/daryllmagsombol/Projects/habi-bot/packages/contracts/tsconfig.json`
- [x] `/Users/daryllmagsombol/Projects/habi-bot/packages/contracts/src/index.ts`
- [x] `/Users/daryllmagsombol/Projects/habi-bot/packages/contracts/eslint.config.mjs` (necessary shared-config consumption addition)
- [x] `/Users/daryllmagsombol/Projects/habi-bot/packages/contracts/test/health-contract.test.mjs` (contract behavior assertion addition)

Interfaces:

- [x] Package name is `@habi/contracts`, private, `"type": "module"`.
- [x] `main` is `./dist/index.js`, `types` is `./dist/index.d.ts`, and conditional `exports` provide `types` and `default` from `dist`.
- [x] `files` includes `dist`. No runtime dependency is added.
- [x] `build` emits declarations and JavaScript into `dist`; `dev` is a single contract watcher; `typecheck` uses `--noEmit`; `lint` covers `src`.
- [x] `src/index.ts` exports exactly:

```ts
export interface HealthResponse {
  status: 'ok';
  service: 'api';
}
```

- [x] No speculative type, runtime value, or helper is added.
- [x] `tsconfig.json` uses `rootDir: src`, `outDir: dist`, declaration output, and Node-compatible ESM settings. It extends the shared base.
- [x] Runtime import of `dist/index.js` yields an empty ESM namespace; `HealthResponse` exists only in `dist/index.d.ts`.

### 1.5 Local PostgreSQL Compose

Own `/compose.yaml` and `.env.example` only.

- [x] Define one service named `postgres` and one named volume. Do not add API, worker, web, Nginx, or production services.
- [x] Pin the verified PostgreSQL image tag.
- [x] Publish only `127.0.0.1:${POSTGRES_PORT:-5432}:5432`; never bind all interfaces.
- [x] Use `POSTGRES_DB`, `POSTGRES_USER`, and `${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env}` so Compose fails closed without a local `.env`. `.env.example` contains a placeholder only; `.env` is ignored and no password literal is committed in Compose.
- [x] Add a `pg_isready` healthcheck. Use candidate settings `interval: 5s`, `timeout: 5s`, `retries: 12`, and `start_period: 10s`; adjust only with a recorded reason.
- [x] Add conservative memory and CPU caps. Use candidate caps `mem_limit: 512m` and `cpus: 0.50`, then confirm they survive in the resolved Compose model; adjust only with a recorded reason. Static YAML assertions confirmed the values; the Compose CLI blocker is recorded below.
- [x] Mount the named volume at the path verified for the chosen PostgreSQL major. Do not assume the pre-18 path.
- [ ] `docker compose config --quiet` succeeds with the local placeholder `.env`, and fails closed when `POSTGRES_PASSWORD` is unset. **Blocked:** `docker compose` and `docker-compose` are not installed in this environment. Static YAML and fail-closed expression assertions passed; see evidence below.

### 1.6 Task 1 verification

- [x] Generate the lockfile, then run `pnpm install --frozen-lockfile` successfully.
- [x] Run `pnpm --filter @habi/contracts build` and confirm `dist/index.js` plus `dist/index.d.ts` exist.
- [x] Import the built package under Node ESM and confirm resolution succeeds without a TypeScript loader.
- [x] Use an ephemeral `POSTGRES_PASSWORD` environment placeholder for Compose validation. No `.env` file was created or persisted; `.env` remains ignored.
- [ ] Inspect the resolved Compose model for loopback binding, volume path, caps, image tag, and healthcheck. **Blocked:** Compose CLI absent. Static YAML assertions confirmed each field; see evidence below.
- [ ] Run `docker compose up -d --wait postgres`, confirm the container health is `healthy`, and run `docker compose exec -T postgres pg_isready`. If no Docker daemon is available, record the exact blocker and do not claim this check passed; the same configuration check still runs. **Blocked for Compose CLI only.** The daemon is healthy; an equivalent `docker run` with the same image, loopback port, volume path, caps, and healthcheck reported `healthy`, `pg_isready` accepted connections, and `select 1` returned `1`.
- [ ] Run `docker compose down` without deleting the named volume. **Blocked for Compose CLI only.** The equivalent verification container and volume were removed manually after the health check.
- [x] Confirm no secret, real password, provider key, extras directory, or unused abstraction was added.
- [x] Report the exact pinned versions and preflight evidence in the completion report.

**Task 1 is independently testable without `apps/web` or `apps/backend`.**

### Task 1 execution evidence (2026-10-19)

- **Status:** Task 1 non-Compose-CLI checks passed. Compose CLI checks are blocked by the missing plugin; equivalent Docker image/health evidence passed. Parent review completed and produced the dev-script amendment.
- **Runtime/package manager:** Node `24.20.0`; pnpm `12.5.1`; npm `11.19.0`; Docker `29.8.2` with daemon `29.5.2`; `docker compose` and `docker-compose` unavailable.
- **Pinned versions:** turbo `2.11.9`; TypeScript `6.0.3`; ESLint `10.13.0`; `@eslint/js` `10.0.1`; `typescript-eslint` `8.71.2`; `globals` `17.13.0`.
- **Downstream versions:** Next `16.4.2`; React/React DOM `19.3.1`; Tailwind CSS and `@tailwindcss/postcss` `4.3.3`; Nest core/common/platform-express `12.2.0`; Nest CLI `12.0.8`; `reflect-metadata` `0.2.2`; `rxjs` `7.8.2`; `eslint-config-next` `16.4.2`; `postcss` `8.5.31`. See the progress ledger for the full matrix and support notes.
- **Install/build:** `pnpm install` generated one lockfile; `pnpm install --frozen-lockfile` passed; `pnpm --filter @habi/contracts build` passed.
- **ESM contract:** `dist/index.js` contains `export {};`; dynamic import yields `moduleKeys=[]` and `hasHealthResponse=false`. `dist/index.d.ts` contains the exact `HealthResponse` shape.
- **Checks:** root `pnpm build`, `pnpm typecheck`, `pnpm lint`, and `pnpm test` passed. Contracts and config tests passed (4 tests total).
- **Config consumption:** `@habi/config/eslint/base.mjs` imported successfully from `packages/contracts`; contracts lint passed; `@habi/config/tsconfig/base.json` resolved and parsed as strict JSON.
- **Compose:** static YAML assertions passed for image, loopback port, volume `/var/lib/postgresql`, caps `512m`/`0.5`, healthcheck, and fail-closed password expression. `docker image inspect postgres:18.6-alpine` reported `Volumes=/var/lib/postgresql` and `PGDATA=/var/lib/postgresql/18/docker`. Manual Docker health verification passed with `Memory=536870912`, `NanoCpus=500000000`, loopback binding, `pg_isready`, and `select 1`.
- **Necessary additions:** `packages/contracts/eslint.config.mjs`, `packages/config/test/config.test.mjs`, and `packages/contracts/test/health-contract.test.mjs`.
- **Not done at Task 1 terminal:** no app directories, no app install, no README edit, no GitHub/commit/push, no Task 4 destructive clean-install automation. App install and README update occurred later in Task 4.

---

## Task 2 — Backend: Nest API health and inert worker

**Owner:** backend fixer. **Depends on:** Task 1 complete. **Parallel with Task 3. Owns `apps/backend/**` only.**

Create and own exactly:

- [ ] `/Users/daryllmagsombol/Projects/habi-bot/apps/backend/package.json`
- [ ] `/Users/daryllmagsombol/Projects/habi-bot/apps/backend/tsconfig.json`
- [ ] `/Users/daryllmagsombol/Projects/habi-bot/apps/backend/tsconfig.build.json`
- [ ] `/Users/daryllmagsombol/Projects/habi-bot/apps/backend/nest-cli.json`
- [ ] `/Users/daryllmagsombol/Projects/habi-bot/apps/backend/eslint.config.mjs`
- [ ] `/Users/daryllmagsombol/Projects/habi-bot/apps/backend/src/main.ts`
- [ ] `/Users/daryllmagsombol/Projects/habi-bot/apps/backend/src/app.module.ts`
- [ ] `/Users/daryllmagsombol/Projects/habi-bot/apps/backend/src/health/health.controller.ts`
- [ ] `/Users/daryllmagsombol/Projects/habi-bot/apps/backend/src/worker.ts`
- [ ] `/Users/daryllmagsombol/Projects/habi-bot/apps/backend/src/worker.module.ts`
- [ ] `/Users/daryllmagsombol/Projects/habi-bot/apps/backend/test/health.smoke.mjs`
- [ ] `/Users/daryllmagsombol/Projects/habi-bot/apps/backend/test/worker.smoke.mjs`

Interfaces:

- [ ] Package name is `@habi/backend`, private, `"type": "module"`. It depends on `@habi/contracts` with `workspace:*` and on the verified Nest runtime packages. It uses `@habi/config` as a dev dependency.
- [ ] Scripts: `dev` (`nest start --watch`), `build` (`nest build`), `start` (`node dist/main.js`), `start:worker` (`node dist/worker.js`), `typecheck` (`tsc -p tsconfig.json --noEmit`), `lint` (`eslint .`), and `test` (`node --test test/*.smoke.mjs`).
- [ ] `nest-cli.json` deletes the output directory on build and configures no path aliases.
- [ ] TypeScript uses the verified Nest 12-compatible settings, NodeNext ESM resolution, decorators/metadata as required by Nest, and relative `.js` suffixes in source imports. Override the shared base only where Nest requires it.
- [ ] `main.ts` creates the Nest application, listens on `HOST` default `127.0.0.1` and `PORT` default `3001`, enables graceful shutdown hooks, and logs one machine-readable `api.ready` event after listening.
- [ ] `GET /health` returns HTTP 200 and exactly `{ "status": "ok", "service": "api" }`, typed as `HealthResponse`. No other endpoint, guard, middleware, CORS, database, queue, or provider module is added.
- [ ] `worker.ts` creates a Nest application context from `worker.module.ts`, logs one `worker.ready` event, and remains idle. It must have no HTTP listener, polling timer, queue, provider client, fetch call, or signal to an external service.
- [ ] `worker.ts` handles `SIGTERM` and `SIGINT` by closing the context and exiting 0. Shutdown must be idempotent and must not hang on repeated signals.
- [ ] `health.smoke.mjs` starts the built API on a test port, waits for readiness, fetches `/health`, asserts status 200, JSON content type, and the exact body, then sends `SIGTERM` and asserts a clean exit. It always cleans up the process.
- [ ] `worker.smoke.mjs` starts the built worker, waits for the ready line, asserts shutdown on `SIGTERM` with exit 0, and fails if the process hangs. It also fails if the worker entry/module contains an HTTP listener or forbidden integration import.
- [ ] No secret or provider environment variable is required to build, start, or test. No `.env` file is added.

### Task 2 verification

- [x] Run `pnpm --filter @habi/backend build`.
- [x] Run `pnpm --filter @habi/backend typecheck` and `pnpm --filter @habi/backend lint`.
- [x] Run `pnpm --filter @habi/backend test` and confirm the smoke suite passes (7 tests, including invalid PORT, repeated SIGTERM, and mixed signals).
- [x] Run `pnpm --filter @habi/backend dev`, wait for the API, verify `curl -fsS http://127.0.0.1:3001/health` returns the exact JSON, then stop it and confirm the watcher exits without orphaning a process.
- [x] Start the built API and repeat the health check.
- [x] Start the worker, confirm no HTTP port is opened, send `SIGTERM`, and confirm exit 0.
- [x] Confirm the build does not require `DATABASE_URL`, model keys, Hermes settings, or any provider credential.
- [x] Report any version or ESM deviation discovered during implementation.

**Task 2 is independently testable once Task 1 has produced the contracts build.**

---

## Task 3 — Web: honest, polished foundation shell

**Owner:** UI designer. **Depends on:** Task 1 complete. **Parallel with Task 2. Owns `apps/web/**` only; sole owner of the visual app.**

Create and own exactly:

- [ ] `/Users/daryllmagsombol/Projects/habi-bot/apps/web/package.json`
- [ ] `/Users/daryllmagsombol/Projects/habi-bot/apps/web/next.config.ts`
- [ ] `/Users/daryllmagsombol/Projects/habi-bot/apps/web/tsconfig.json`
- [ ] `/Users/daryllmagsombol/Projects/habi-bot/apps/web/postcss.config.mjs`
- [ ] `/Users/daryllmagsombol/Projects/habi-bot/apps/web/eslint.config.mjs`
- [ ] `/Users/daryllmagsombol/Projects/habi-bot/apps/web/app/layout.tsx`
- [ ] `/Users/daryllmagsombol/Projects/habi-bot/apps/web/app/page.tsx`
- [ ] `/Users/daryllmagsombol/Projects/habi-bot/apps/web/app/globals.css`
- [ ] `/Users/daryllmagsombol/Projects/habi-bot/apps/web/test/homepage.smoke.mjs`
- [ ] Generated `next-env.d.ts` and `.next/` are not hand-authored.

Interfaces:

- [ ] Package name is `@habi/web`, private. Scripts: `dev` (`next dev -p 3000`), `build` (`next build`), `start` (`next start -p 3000`), `typecheck` (`tsc --noEmit`), `lint` (`eslint .`), and `test` (`node --test test/*.smoke.mjs`).
- [ ] Use the verified Next 16/React 19/Tailwind 4 versions. Use `@tailwindcss/postcss` exactly as required by the installed Tailwind major. Add no UI library, icon package, font package, state manager, or test framework.
- [ ] `next.config.ts` stays minimal: React strict mode and no custom server, proxy, image loader, or experimental option unless required by the verified versions.
- [ ] `tsconfig.json` extends `@habi/config/tsconfig/base.json` and applies the Next-required bundler resolution, JSX preservation, and generated type paths. Do not add cross-package path aliases.
- [ ] The page is server-rendered static content. It makes no API call, reads no secret, and has no client-side state.
- [ ] The page must visibly include these exact honest strings, with natural layout and punctuation around them:
  - `Habi`
  - `Weave ideas into action.`
  - `Foundation preview`
  - `This repository proves the workspace, web shell, API health endpoint, worker boot path, and local PostgreSQL tooling.`
  - `It does not include sign-in, chat, Bots, model calls, or Hermes.`
  - `No product functionality is available yet.`
- [ ] Do not add forms, inputs, textareas, password fields, chat composers, fake sign-in/out controls, fake Bot cards, fake metrics, fake transcripts, or nonfunctional buttons that imply a product.
- [ ] Visual quality: deliberate type scale, spacing, color, and one restrained woven/thread motif if desired. It must read as a polished foundation notice, not a generic unstyled placeholder and not a functional product.
- [ ] Accessibility: one `h1`, semantic landmarks, readable contrast, visible keyboard focus, reduced-motion-safe decoration, and meaningful link text.
- [ ] Responsiveness: mobile-first at 320–390 px with no horizontal overflow; comfortable desktop composition at 1440 px. Do not use arbitrary absolute positioning or fixed-height hacks.
- [ ] Use system fonts and CSS/inline SVG only. No external font, image, analytics, or network request.
- [ ] `homepage.smoke.mjs` starts the built app on a test port, waits for readiness, fetches `/`, asserts HTTP 200, asserts all honest strings, and fails if the rendered HTML contains a form, input, textarea, password field, or `<button>` element. It always cleans up the process.

### Task 3 verification

- [x] Run `pnpm --filter @habi/web build`.
- [x] Run `pnpm --filter @habi/web typecheck` and `pnpm --filter @habi/web lint` (0 errors, 0 warnings after the designer fixed the web config warnings).
- [x] Run `pnpm --filter @habi/web test` and confirm the rendered copy and no-fake-controls assertions pass.
- [x] Run `pnpm --filter @habi/web dev`, wait for the page, verify `curl -fsS http://127.0.0.1:3000/` returns the honest copy, then stop it and confirm the watcher exits without orphaning a process.
- [x] Start the built app and repeat the rendered-copy check.
- [x] Browser-check passed by the designer at 320, 390×844, and 1440×900: no horizontal overflow, no overlap, readable hierarchy, keyboard focus, reduced-motion behavior, no console errors, and no external network request.
- [x] Confirm the page does not imply working auth, chat, Bots, model calls, or Hermes.
- [x] Browser tooling was available to the designer; no Playwright dependency was added.

**Task 3 is independently testable once Task 1 is complete. It does not require Task 2.**

---

## Task 4 — Integration and documentation verification

**Owner:** root fixer resumes. **Depends on:** Tasks 2 and 3 complete. **No app edits.**

Create and own:

- [x] `/Users/daryllmagsombol/Projects/habi-bot/scripts/verify-foundation.mjs`
- [x] `/Users/daryllmagsombol/Projects/habi-bot/scripts/verify-foundation-lib.mjs` (small pure helper module for the focused runner tests)
- [x] `/Users/daryllmagsombol/Projects/habi-bot/scripts/verify-foundation.test.mjs` (Node builtin focused tests)
- [x] `/Users/daryllmagsombol/Projects/habi-bot/package.json` (only the `verify:foundation` and `test:verification` script entries if not already created in Task 1)
- [x] `/Users/daryllmagsombol/Projects/habi-bot/docs/superpowers/plans/2026-10-19-initial-foundation.md` (checkboxes and execution evidence only)
- [x] `/Users/daryllmagsombol/Projects/habi-bot/README.md` only under the conditional gate below

### 4.1 Verification script

- [x] `scripts/verify-foundation.mjs` uses only Node built-ins and spawns pnpm. It must not add a test framework or dependency.
- [x] **Deliberate deviation:** no destructive `--clean-install` flag. The runner verifies the installed workspace with frozen install, a fresh forced build, and uncached build/dev graph proof. This is **not** a clean-install proof. A destructive flag is refused rather than implemented; KISS over a cleanup harness.
- [x] Reject application dotenv files before install/build without reading, moving, deleting, or printing their contents. Known app dirs are `apps/backend` and `apps/web`; `.env.example` is allowed, and a root `.env` remains allowed for local Compose.
- [x] Build with a sanitized environment that strips `DATABASE_URL`, `POSTGRES_*`, `OPENAI_API_KEY`, `OPENCODE_*`, `HERMES_*`, and other `*_KEY`/`*_TOKEN`/`*_SECRET` provider credentials while retaining OS-required variables. Fail if the build requires any of them.
- [x] Run `pnpm install --frozen-lockfile`, focused runner tests, a forced sanitized build (`turbo run build --force`), typecheck, lint, and forced tests (`turbo run test --force`) in order and fail on the first non-zero exit. Ordinary `pnpm build` remains cacheable.
- [x] Run the root `pnpm dev` smoke: start it, wait for the web on 3000 and API health on 3001, confirm there is exactly one watcher for `packages/contracts` and one for `apps/backend` with no duplicate `tsc --watch`, then terminate the process group and assert no child process or port remains. (Verified manually; the runner intentionally does not duplicate this process-tree harness.)
- [x] Assert `packages/contracts/dist/index.js` and `index.d.ts` exist after the forced build, and assert the Turbo build graph places `@habi/backend` after `@habi/contracts` (for example via `turbo run build --dry=json`).
- [x] Spawn the built API on an isolated test port, request `/health`, assert the exact `HealthResponse` body, then send `SIGTERM` and assert exit 0. (Covered by the backend smoke suite and manual default-port 3001 check; not duplicated in the runner.)
- [x] Spawn the built worker, wait for `worker.ready`, assert it exits 0 on `SIGTERM`, and statically assert the worker entry/module has no `listen(`, `fetch(`, polling timer, queue, or provider integration. (Covered by the backend smoke suite and manual signal checks.)
- [x] Spawn the built web app on an isolated test port, request `/`, assert HTTP 200, assert the honest strings, and assert no form/input/textarea/password field or `<button>` element is present. (Covered by the web smoke suite and manual production check.)
- [ ] Run `docker compose config --quiet` and inspect the resolved model for `127.0.0.1`, the verified volume path, caps, image tag, and healthcheck. **Blocked:** Compose CLI plugin absent. Task 1 static YAML assertions remain the evidence; no Compose file changed.
- [ ] If a Docker daemon is available, run `docker compose up -d --wait postgres`, assert the health status, run `pg_isready`, then `docker compose down` without deleting the volume. If unavailable, record the blocker and do not count this as passed. **Blocked by the same missing Compose CLI.** The separate manual Docker health evidence from Task 1 remains valid and is not represented as a Compose run.
- [x] Do not add Playwright or another browser dependency solely for verification. Use available browser tooling for the mobile/desktop checks; if unavailable, record the blocker. Browser checks were completed by the designer.

### 4.2 Documentation and status

- [x] Browser checks passed at 320, 390×844, and 1440×900 with keyboard and reduced-motion coverage, no console errors, and no external network requests. **Completed by the designer.**
- [ ] Re-run the Compose check with the final files. Record whether actual container health was verified or blocked by environment. **Blocked:** Compose CLI plugin absent; no Compose files changed since Task 1.
- [x] Append a concise execution record to this plan: exact versions, commands run, pass/fail, browser tool, Docker daemon status, and any deviations. Do not rewrite the design to hide a deviation.
- [x] Confirm `README.md` still contains no false claim of product functionality. The prior README writer was explicitly cancelled and terminal, so the local README was updated.
- [x] Conditional README gate: writer confirmed cancelled/terminal. Updated the planning-only status, actual layout, verified commands, local database notes, and links to the design, plan, and ledger. No product, deployment, secret, or H-009 completion claims were added.
- [x] Do not mutate GitHub issues, board status, or H-009. Report evidence to the parent/orchestrator; H-009 stays open until full acceptance is independently verified.
- [x] Updated only the public Project #1 README current-state text to describe the local runnable foundation. No issue, status, view, or field changes; the manual Group by Status warning remains.
- [x] Do not commit or push.

### 4.3 Environment blocker report

The Task 4 completion report must state:

```text
Environment
- Docker daemon: available (29.5.2); Compose CLI plugin unavailable
- Browser tooling: designer check passed; no Playwright dependency added
- PostgreSQL image pull: succeeded (postgres:18.6-alpine)

Versions
- Node 24.20.0; pnpm 12.5.1; turbo 2.11.9; TypeScript 6.0.3
- Next 16.4.2; React/ReactDOM 19.3.1; Tailwind/@tailwindcss/postcss 4.3.3
- Nest core/common/platform-express 12.2.0; Nest CLI 12.0.8
- ESLint 10.13.0; @eslint/js 10.0.1; typescript-eslint 8.71.2; globals 17.13.0

Verification
- Frozen install: pass (5 workspace projects)
- Dev entrypoints: pass (API 3001, web 3000, one backend watcher, one contracts watcher, web watcher; no orphan ports)
- Fresh forced build: pass (`turbo run build --force`, 0 cached; sanitized env)
- Clean-install proof: not run. Forced compilation + frozen install + dependency graph is not a clean-install proof.
- Build-order graph proof: pass (`@habi/backend#build` -> `@habi/contracts#build`)
- Focused runner tests: pass (4 Node builtin tests for path decoding, dotenv preflight, sanitized env, forced args)
- Typecheck: pass (4 tasks)
- Lint: pass (forced; 0 errors, 0 warnings)
- Tests: pass (forced; 7 tasks, 12 app/package tests: backend 7, config 2, contracts 2, web 1)
- API HTTP health: pass (200, exact body, default loopback 3001; clean SIGTERM)
- Worker SIGTERM: pass (headless, no listening sockets; SIGTERM/SIGINT exit 0; repeated/mixed signals covered by suite)
- Web rendered copy: pass (200; honest foundation text; no product controls). Production stop closed the port; the pnpm wrapper reported exit 1 on SIGTERM.
- Browser: pass (designer: 320, 390×844, 1440×900; keyboard, reduced motion, no console errors, no external requests)
- Compose config/actual health: blocked by missing Compose CLI; manual Docker health evidence from Task 1 remains separate and unchanged
- Sanitized-env build: pass
- Verify runner: pass (`pnpm verify:foundation`, fresh forced build + forced tests)
- Preview: stopped after identity check; no API, worker, or web process remains

Status
- H-009: open (not closed)
- Deviations: no destructive clean-install flag; Compose CLI blocked; clean-install proof not run.
```

Integration notes:

- The runner now rejects application dotenv files in `apps/backend` and `apps/web` before install/build without reading, moving, or printing contents. A root `.env` for Compose and `.env.example` remain allowed.
- The sanitized build and tests are forced through Turbo so cache replay cannot substitute for fresh compilation or runtime execution. Ordinary `pnpm build` remains cacheable.
- The root path is derived with `fileURLToPath`, and focused tests cover a path containing spaces.
- `allowBuilds` is qualified as `unrs-resolver@1.12.2`, matching the supported pnpm syntax; no blanket approval is used. The prior blanket-looking bare-name entry was corrected.
- The shared ESLint base applies type-aware TypeScript rules only to `**/*.{ts,tsx}`. This was a bounded root-config fix; no app source was changed by this lane. The designer subsequently fixed the two web config lint warnings.
- Backend tests were not edited; their final follow-up was terminal before the definitive root test run.

## Done criteria

- [x] Task 1, Task 2, and Task 3 checks pass in their owned paths.
- [x] Task 4 passes every non-blocked check, or records an explicit environment blocker without claiming success.
- [x] Frozen install, dev-entrypoint smoke, fresh forced build, and build-order graph proof pass. Clean-install proof was not run; it is not claimed.
- [x] API returns exactly `{ "status": "ok", "service": "api" }` over real HTTP on port 3001.
- [x] Worker boots, stays inert, and exits 0 on `SIGTERM`; SIGINT and repeated/mixed signals are covered by tests.
- [x] Web renders the honest scaffold at 3000 and passes mobile/desktop checks (designer: 320, 390×844, 1440×900; keyboard/reduced motion; no console errors or external requests).
- [x] Compose is loopback-only with the verified PostgreSQL volume path, caps, and healthcheck; actual Compose health is explicitly blocked by the missing Compose CLI, with separate manual Docker health evidence.
- [x] No secrets, ORM, queue, auth, chat, model, Hermes, Bun, CI, or production deployment code is present.
- [x] No blanket lifecycle-script approval and no unnecessary dependency.
- [x] H-009 remains open. The parent performs the final review.
