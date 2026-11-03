# H-009 — Docker contexts, env validation, and clean-install evidence (2026-11-03)

- **Status:** The remaining H-009 gaps are implemented and measured locally. H-009 can be accepted on this evidence; CI wiring of the image builds is #10, and deployment Compose is #11.
- **Phase:** P1 — Platform.
- **Scope:** Root-context Docker builds for web/API/worker, dependency-free environment validation, and a cold clean-install runner. No application feature, database schema, queue, provider, or deployment was added.

## 1. Docker build contexts

| Artifact | Detail |
|---|---|
| `.dockerignore` | Excludes `.git`, `.github`, `node_modules`, `dist`, `.next`, `.turbo`, `docs`, coverage, logs, `.env*` (`.env.example` kept) |
| `apps/web/Dockerfile` | `node:24.20.0-bookworm-slim`, corepack `pnpm@12.5.1`, filtered frozen install, `next build`, runtime `USER node`, `PORT 3000` |
| `apps/backend/Dockerfile` | Same base; targets `api` (`node dist/main.js`, port 3001) and `worker` (`node dist/worker.js`, no port) |
| Build context | Repository root; commands are documented in each Dockerfile header |
| Runtime | `NODE_ENV=production`, non-root `node`, no `.env*`, pnpm store/cache deleted from layers |

### Measured builds and runs (local colima, linux/arm64)

| Check | Result |
|---|---|
| `docker build -f apps/web/Dockerfile -t habi-web:test .` | success, ~63 s → **819 MB** |
| `docker build -f apps/backend/Dockerfile --target api -t habi-api:test .` | success, ~37 s → **440 MB** |
| `docker build -f apps/backend/Dockerfile --target worker -t habi-worker:test .` | success (cached runtime) → **440 MB** |
| API container | `/health` → **200** `{"status":"ok","service":"api"}`, `User=node`, `NODE_ENV=production`, SIGTERM exit **0** |
| Web container | `/` → **200**, 10,312 bytes, contains `Weave ideas into action.`, `User=node`, stopped cleanly |
| Worker container | logs `{"event":"worker.ready","service":"worker"}`, **no listening sockets**, SIGTERM exit **0** |
| Image inspection | no `.env*`, no pnpm store/cache leftovers, API exposes 3001 only, worker exposes nothing |

Base image alone is 351 MB, so the API/worker delta is ~89 MB and the web delta ~468 MB (Next runtime + node_modules). Shrinking web further needs `output: 'standalone'`, which is app configuration and out of this task's scope.

## 2. Environment schema

`packages/config/src/env.ts` adds a pure `parseEnv(source)` validator with no dependencies and no `process.env` access:

- `NODE_ENV` (development|test|production, default development), `HOST` (default `127.0.0.1`), `PORT` (1–65535, default 3001), optional `API_PORT`.
- Compose-only `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_PORT` validated for shape only; not required by the app.
- Aggregates all failures and reports **keys and rules only**, never values, so a malformed secret cannot leak through an error.
- Package now has real `build`/`typecheck`/`lint`/`test` scripts and a `.` export.

Verification: `pnpm --filter @habi/config typecheck` clean; `pnpm --filter @habi/config test` → **17/17 pass**.

## 3. Clean-install and reproducibility

`scripts/ci/clean-install.mjs` archives `HEAD` with `git archive` into a temp tree outside the repo, refuses to write inside the repo, uses a fresh `--store-dir` (cold), installs with `--frozen-lockfile`, then runs build, typecheck, and test with per-step timings. Temp is removed on exit.

Full run (2026-11-03):

| Step | Time | Note |
|---|---:|---|
| archive | 0.08 s | commit `86b617b7e526` |
| install | 10.5 s | `resolved 508, reused 0, downloaded 508` — genuinely cold |
| build | 161.4 s | `3 successful, 0 cached` |
| typecheck | 1.2 s | temp-tree cache only |
| test | 2.3 s | temp-tree cache only |
| **total** | **176.2 s** | exit 0, temp tree removed |

Lockfile: `pnpm-lock.yaml` sha256 `de5ec888…` , 192,450 bytes, exactly one lockfile. Node `v24.20.0` and pnpm `12.5.1` match `.node-version` and `packageManager`.

Runner tests: `node --test scripts/ci/clean-install.test.mjs` → **6/6 pass** (dry-run, missing-lockfile failure, no repo writes, temp cleanup, in-repo temp refusal, unknown flag).

## 4. Upgrade policy (recorded)

- **Node:** bump `.node-version` and the Docker base tag together in one PR; run `pnpm verify:foundation` and `node scripts/ci/clean-install.mjs`.
- **pnpm:** bump `packageManager`, let corepack resolve it, regenerate the lockfile, rerun the clean install; CI must stay frozen-lockfile clean.
- **Turbo:** exact pin in root `devDependencies`; bump with a lockfile update and a clean-install run.
- **Images:** rebuild after any lockfile, workspace manifest, or `.dockerignore` change; never `--no-frozen-lockfile`.

## 5. Checklist closure

| H-009 item | Status |
|---|---|
| Pin package manager, Node, Turbo + upgrade policy | Done (§4) |
| Web/backend workspaces, shared config | Previously done |
| Shared packages without server leakage | Previously done; `@habi/config` entry point is browser-safe |
| Separate API/worker entrypoints | Previously done; both containerized |
| Docker contexts and multi-stage Dockerfiles | **Done** (§1) |
| Env schema + example, no secrets | **Done** (§2) |
| Root/package scripts | Done; package scripts added for `@habi/config` |
| One lockfile, clean install | **Verified** (§3) |
| Reproducible build in a clean context | **Verified** via cold tree; CI job is #10 |
| Node launch path preserved, Bun documented | Done (Node 24 is the P1 runtime) |

## 6. Non-claims and limits

- Local arm64 builds only; CI/linux amd64 image builds are #10.
- No registry push, signing, SBOM, or vulnerability scan yet.
- `docker compose` plugin is absent locally; builds were verified with `docker build`, not Compose.
- The clean-install run used the committed `HEAD`, not uncommitted work.
- No deployment, staging, or production configuration was created.
