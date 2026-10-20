# Habi Initial Foundation — Progress Ledger

- **Plan:** [2026-10-19-initial-foundation.md](./2026-10-19-initial-foundation.md) — Tasks 1–4, plus global constraints.
- **Design:** [2026-10-19-initial-foundation-design.md](../specs/2026-10-19-initial-foundation-design.md)
- **User approval:** Design and plan approved. Specialist lanes implemented Tasks 1–3; this ledger now records the Task 1 foundation and Task 4 integration evidence.
- **Started:** 2026-10-19 (Asia/Manila).
- **Status:** Task 1 foundation, Task 4 integration, designer browser verification, and final review fixes are complete for parent re-review. One Compose CLI environment blocker remains. H-009 is open.

## Scope mapping

| Work | Owner lane | Status |
|---|---|---|
| Task 1: root workspace, `packages/config`, `packages/contracts`, Compose, lockfile, preflight | Root fixer | Complete for review; Compose CLI blocked |
| Task 2: `apps/backend` API health and inert worker | Backend fixer | Terminal; 7-test suite and integration checks pass |
| Task 3: `apps/web` honest polished shell | UI designer | Terminal; browser passed 320/390/1440 with keyboard/reduced motion; lint warnings fixed |
| Task 4: integration/docs verification and README | Root fixer resumes | Final fixes complete; parent re-review |

**Current stop point:** Final review fixes are complete; the designer browser check passed and the preview is stopped. The parent oracle should independently recheck the runner. App source remains owned by its original lanes; this lane made no app source or test changes.

## Guardrails

- README update was authorized after the prior README writer was explicitly cancelled and terminal. The local README now describes the runnable foundation.
- No GitHub issue, board, or Project mutation; no commits, pushes, branches, worktrees, or history changes. The repository is unborn; changes remain in the current workdir.
- `.serena/` remains ignored and is not committed.
- App source and backend test follow-up remained with the original owners. This lane did not edit `apps/backend/**` or `apps/web/**`.
- One root install and one lockfile owner. The app manifests were installed together after both lanes were terminal.
- No real secrets in files, commands, output, or logs. Compose verification used an ephemeral placeholder environment variable; no `.env` file was persisted.
- No blanket pnpm lifecycle-script approval. `allowBuilds` is qualified as `unrs-resolver@1.12.2` (supported pnpm syntax), required by `eslint-config-next`; pnpm recorded exact `minimumReleaseAgeExclude` entries for the pinned Nest packages and PostCSS.
- No application container images, production Compose, CI, Bun, ORM, queue, auth, chat, models, Hermes, or deployment work.
- H-009 remains open. No phase gate is passed.

## Preflight conflict rulings

1. **Module system:** Use Node ESM as the design requires. The plan's older research note about CommonJS/`require(esm)` is not a reason to add CJS shims. `@nestjs/core@12.2.0` reports `"type": "module"`, confirming the ESM path.
2. **pnpm pin:** Use the locally available and registry-verified `pnpm@12.5.1`, not `12.14.0`. This avoids a global installation or a package-manager download solely to satisfy the pin. The registry confirms `12.5.1` exists and supports Node `>=18`.
3. **Version verification:** Pin only exact versions confirmed through `npm view`/registry metadata and official documentation. The candidate list in the plan is not copied blindly.
4. **TypeScript/Nest compatibility:** `@nestjs/cli@12.0.8` declares a dependency on TypeScript `~6.0.2`; `typescript@6.0.3` satisfies that range. `typescript-eslint@8.71.2` supports TypeScript `<6.1.0` and ESLint 8–10. This supports the verified TypeScript 6 pin.
5. **ESLint consumption:** The root config must be consumable by real package lint scripts. Add `packages/contracts/eslint.config.mjs` and `packages/config/test/` checks even though the plan's exact file list omitted them. Record as necessary additions.
6. **Contract runtime shape:** `HealthResponse` is type-only. A Node ESM import of `@habi/contracts` is expected to yield an empty module object, not a runtime `HealthResponse` value. Tests will assert resolution and the absence of an accidental runtime carrier, not invent a value.
7. **Worker lifecycle:** The worker's no-HTTP/no-polling/clean-signal behavior belongs to the backend lane. Task 1 does not create worker code.
8. **Task 4 clean-install:** Do not implement Task 4's destructive `--clean-install` automation. Final verification uses frozen install, a fresh forced build, and dependency graph proof. This is **not** a clean-install proof and is recorded as such, never as a clean-room result.
9. **Docker verification:** Compose config runs with an ephemeral/ignored local environment. Actual container health runs only if the daemon is accessible; a daemon failure is reported as a blocker, not a pass.

## Verified version matrix

Registry and metadata checks are recorded in the command log below. Node and pnpm are local runtime facts; the rest are exact registry versions.

| Package / tool | Exact version | Evidence / note |
|---|---:|---|
| Node.js | 24.20.0 | `node --version`; baseline `>=24.20.0 <25` |
| pnpm | 12.5.1 | `pnpm --version`; `npm view pnpm@12.5.1` confirms existence; local pin |
| Turborepo | 2.11.9 | `npm view turbo@2.11.9` |
| TypeScript | 6.0.3 | `npm view typescript@6.0.3`; Nest CLI 12.0.8 dependency `~6.0.2` |
| ESLint | 10.13.0 | `npm view eslint@10.13.0`; Node `^20.19 || ^22.13 || >=24` |
| `@eslint/js` | 10.0.1 | `npm view @eslint/js` |
| `typescript-eslint` | 8.71.2 | `npm view`; peer TypeScript `<6.1.0`, ESLint `^10` supported |
| `globals` | 17.13.0 | `npm view globals`; Node `>=18` |
| Next.js | 16.4.2 | `npm view next@16.4.2`; Node `>=20.9`; React 19 peer accepted |
| React | 19.3.1 | `npm view react@19.3.1` |
| React DOM | 19.3.1 | `npm view react-dom@19.3.1`; peer React `^19.3.1` |
| Tailwind CSS | 4.3.3 | `npm view tailwindcss@4.3.3` |
| `@tailwindcss/postcss` | 4.3.3 | `npm view`; depends on `tailwindcss@4.3.3` |
| NestJS core/common/platform-express | 12.2.0 | `npm view`; core `type = module`, Node `>=20` |
| NestJS CLI | 12.0.8 | `npm view`; Node `>=20.11`; TypeScript `~6.0.2` |
| `reflect-metadata` | 0.2.2 | `npm view`; downstream backend candidate |
| `rxjs` | 7.8.2 | `npm view`; downstream backend candidate |
| `@types/node` | 24.19.2 | `npm view @types/node@24 version`; latest Node 24-aligned type candidate |
| `@types/react` | 19.3.0 | `npm view`; downstream web candidate |
| `@types/react-dom` | 19.3.0 | `npm view`; downstream web candidate |
| `eslint-config-next` | 16.4.2 | `npm view`; peer ESLint `>=9`, TypeScript `>=3.3.1` |
| `postcss` | 8.5.31 | `npm view`; Tailwind PostCSS dependency range |
| PostgreSQL image | `postgres:18.6-alpine` | Registry manifest exists; pulled and inspected locally |

PostgreSQL image evidence:

- `docker image inspect postgres:18.6-alpine` → `Volumes={"/var/lib/postgresql":{}}`
- `Config.Env` → `PG_MAJOR=18`, `PGDATA=/var/lib/postgresql/18/docker`
- Therefore Task 1 mounts the named volume at `/var/lib/postgresql`, not the pre-18 `/var/lib/postgresql/data` path.

## Task 1 command and result log

This section is appended as checks run. No secrets are included.

### Preflight

```text
node --version                         -> v24.20.0
pnpm --version                         -> 12.5.1
corepack --version                     -> 0.35.0
npm --version                          -> 11.19.0
docker --version                       -> 29.8.2
docker info                            -> daemon reachable, ServerVersion 29.5.2
npm view pnpm@12.5.1                   -> version 12.5.1, engines.node >=18.*
npm view turbo@2.11.9                  -> version 2.11.9
npm view next@16.4.2                   -> version 16.4.2, engines.node >=20.9.0, React 19 peer accepted
npm view react@19.3.1                  -> version 19.3.1
npm view react-dom@19.3.1              -> version 19.3.1, peer react ^19.3.1
npm view tailwindcss@4.3.3             -> version 4.3.3
npm view @tailwindcss/postcss@4.3.3    -> version 4.3.3, depends on tailwindcss 4.3.3
npm view @nestjs/core@12.2.0           -> version 12.2.0, type module, engines.node >=20
npm view @nestjs/cli@12.0.8            -> version 12.0.8, engines.node >=20.11, typescript ~6.0.2
npm view typescript@6.0.3              -> version 6.0.3
npm view eslint@10.13.0                -> version 10.13.0, Node >=24 accepted
npm view typescript-eslint@8.71.2      -> version 8.71.2, TypeScript <6.1.0, ESLint 10 supported
docker manifest inspect postgres:18.6-alpine -> manifest exists
docker pull postgres:18.6-alpine       -> success; volume /var/lib/postgresql; PGDATA /var/lib/postgresql/18/docker
```

Official documentation checks:

- Next.js installation docs state Node.js `20.9` minimum. Node 24.20.0 satisfies this.
- Tailwind CSS Next.js guide states `tailwindcss`, `@tailwindcss/postcss`, and `postcss`, with `postcss.config.mjs` using `@tailwindcss/postcss` and `@import "tailwindcss";`.
- Nest migration documentation fetched through the official docs domain did not add package-specific TypeScript 6 detail; registry metadata for `@nestjs/cli@12.0.8` and `@nestjs/core@12.2.0` is the authoritative support evidence used here.
- PostgreSQL official image metadata confirms the v18 volume and `PGDATA` layout.

### Implementation and verification

#### Files created or generated

```text
package.json
pnpm-workspace.yaml
turbo.json
.npmrc
.gitignore
.node-version
.env.example
compose.yaml
pnpm-lock.yaml                         # generated by pnpm
packages/config/package.json
packages/config/tsconfig/base.json
packages/config/eslint/base.mjs
packages/config/test/config.test.mjs
packages/contracts/package.json
packages/contracts/tsconfig.json
packages/contracts/src/index.ts
packages/contracts/eslint.config.mjs
packages/contracts/test/health-contract.test.mjs
```

At Task 1 terminal, no `apps/backend/**` or `apps/web/**` files existed. They arrived later from Tasks 2 and 3. No README edit was made during Task 1; README was updated in Task 4 after the prior writer was cancelled.

#### Commands and results

| Command | Exit | Result |
|---|---:|---|
| `pnpm install` | 0 | 3 workspace projects; 1 lockfile; no build-script approval required |
| `pnpm install --frozen-lockfile` | 0 | lockfile up to date; resolved from store |
| `pnpm --filter @habi/contracts build` | 0 | emitted `dist/index.js`, `dist/index.js.map`, `dist/index.d.ts` |
| `node --input-type=module -e "await import('./packages/contracts/dist/index.js')"` | 0 | `moduleKeys=[]`; `hasHealthResponse=false` |
| `pnpm --filter @habi/contracts typecheck` | 0 | pass |
| `pnpm --filter @habi/contracts lint` | 0 | pass with shared flat config |
| `pnpm --filter @habi/contracts test` | 0 | 2 tests passed |
| `pnpm --filter @habi/config test` | 0 | 2 tests passed |
| `pnpm build` | 0 | Turbo; contracts build passed |
| `pnpm typecheck` | 0 | Turbo; contracts typecheck passed |
| `pnpm lint` | 0 | Turbo; contracts lint passed |
| `pnpm test` | 0 | Turbo; 3 tasks / 4 tests passed |
| Python YAML compose assertions | 0 | service, image, loopback port, volume, caps, healthcheck, fail-closed expression passed |
| `docker run` equivalent health check | 0 | `healthy`; `pg_isready` accepting; `select 1` -> `1` |
| `docker compose config --quiet` | 125 | blocked: `docker compose` plugin not installed |
| `docker compose up/down` | N/A | blocked for the same reason; equivalent container manually removed |
| `pnpm exec turbo run dev --dry=json` | 0 | parsed; current graph has `@habi/contracts#dev` -> `@habi/config#build`; apps absent |

#### Docker verification detail

- `postgres:18.6-alpine` pulled successfully; manifest exists.
- Image metadata: `Volumes={"/var/lib/postgresql":{}}`; `PGDATA=/var/lib/postgresql/18/docker`.
- Equivalent run settings: loopback `127.0.0.1:55432`, volume `habi-postgres-data:/var/lib/postgresql`, `--memory 512m`, `--cpus 0.5`, `pg_isready` healthcheck.
- Observed: health `healthy`; `Memory=536870912`; `NanoCpus=500000000`; port binding `127.0.0.1`; `PGDATA=/var/lib/postgresql/18/docker`; `select 1` returned `1`.
- Cleanup: container and test volume removed. No `.env` file was persisted.
- **Blocker:** this host has the Docker engine/CLI but no Compose plugin (`docker compose` unknown command; `docker-compose` not found). Compose CLI checks must be rerun by an environment with the plugin before Task 1 can claim those specific checks.

#### Downstream import API

```js
// Backend and future clients: type-only contract
import type { HealthResponse } from '@habi/contracts';

// Runtime package is intentionally empty.
// `await import('@habi/contracts')` resolves successfully with no runtime values.
```

```js
// Shared config consumption
// tsconfig.json
{
  "extends": "@habi/config/tsconfig/base.json"
}

// eslint.config.mjs
import base from '@habi/config/eslint/base.mjs';
export default base;
```

- Internal packages use `workspace:*`.
- `@habi/contracts` resolves from `dist` and exposes `types` plus `default` via conditional exports.
- `@habi/config` is consumed from packages that declare it as a workspace dev dependency; it is not a root dependency.
- Root install ownership: Task 4 later performed the single root install after both `apps/backend/package.json` and `apps/web/package.json` were ready, then verified `pnpm install --frozen-lockfile`.

#### Validation-owner checks

- [x] Task 1 source coverage checked against plan lines 65–183 and global constraints.
- [x] No overlap with `apps/backend/**` or `apps/web/**`; Task 4 also made no app source or test edits.
- [x] README was untouched during Task 1; it was updated in Task 4 after the prior writer was cancelled and terminal.
- [x] `.serena/` ignored, not removed or committed.
- [x] No commits, pushes, GitHub mutations, or worktree/history changes.
- [x] No secret values written or printed.
- [x] H-009 remains open; Tasks 2–4 were not executed during Task 1 and were completed later as recorded above.

#### Post-review amendment — dev startup ordering

- **Parent finding:** `turbo run dev --parallel` conflicts with the `^build` dependency startup ordering.
- **Change:** root `package.json` `dev` is now `turbo run dev`. This is the only source change in the amendment.
- **Contract preserved:** `turbo.json` keeps `dev.dependsOn: ["^build"]`; it never depends on `^dev`. Persistent dev tasks do not depend on another dev task.
- **Dry graph:** `pnpm exec turbo run dev --dry=json` exited 0. Current tasks:
  - `@habi/config#build` (nonexistent command; no build script)
  - `@habi/config#dev` (nonexistent command; no dev script)
  - `@habi/contracts#dev` with dependency `@habi/config#build`
- **App edge:** apps do not exist yet, so the future edge cannot be materialized in this repo. The existing graph confirms `^build` resolution for a dev task. Once `apps/backend` and `apps/web` declare `@habi/contracts` with `workspace:*` and their dev scripts, their `dev` tasks will depend on `@habi/contracts#build` before starting. The app lanes must rerun the dry graph after their manifests exist.
- **No full rerun:** only the root script text changed; source, dependencies, and lockfile are unchanged. Existing build/typecheck/lint/test evidence remains valid.

### Task 4 integration and final review fix wave (2026-10-19)

**Single-root install:** `pnpm install` resolved all 5 workspace projects and updated the one lockfile. `pnpm install --frozen-lockfile` passed after the final fixes, so the lockfile remains frozen-valid.

**allowBuilds:** pnpm's official Build Settings documentation confirms `package@version` qualifiers. The workspace now uses the qualified key `unrs-resolver@1.12.2: true`; `pnpm config get allowBuilds` reports `{"unrs-resolver@1.12.2": true}`. No blanket approval is used. pnpm also recorded exact `minimumReleaseAgeExclude` entries for the pinned Nest packages and `postcss@8.5.31`.

**Runner hardening and focused tests:** `scripts/verify-foundation-lib.mjs` contains small pure helpers; `scripts/verify-foundation.test.mjs` exercises them with Node builtins only and no repo-wide install/build. The focused tests cover:

- `fileURLToPath` root resolution with a path containing spaces;
- app dotenv rejection in `apps/backend` and `apps/web`, `.env.example` allowance, root `.env` allowance for Compose, and no content in the error message;
- sanitized environment filtering;
- forced build/test args and the cached normal build script.

The runner now rejects application dotenv files before install/build without reading, moving, deleting, or printing contents. It executes `turbo run build --force` with a sanitized environment and `turbo run test --force`, so cache replay cannot stand in for compilation or runtime execution. The ordinary `pnpm build` remains `turbo run build` and stays cacheable. The root `test:verification` script is not part of the Turbo test loop.

**Final verification commands and results**

| Command | Result |
|---|---|
| `pnpm test:verification` | pass; 4 focused runner tests |
| `pnpm install --frozen-lockfile` | pass; 5 workspace projects |
| `pnpm exec turbo run lint --force` | pass; 3 tasks, 0 cached, 0 errors, 0 warnings |
| `pnpm verify:foundation` | pass; fresh forced build (0 cached), 4 focused tests, typecheck, lint, forced tests (0 cached, 12 app/package tests), graph assertions |
| `pnpm exec turbo run build --dry=json` | pass; `@habi/backend#build` -> `@habi/config#build`, `@habi/contracts#build` |
| `pnpm exec turbo run dev --dry=json` | pass; `@habi/backend#dev` -> `@habi/config#build`, `@habi/contracts#build`; no dev task depends on another dev task |
| root `pnpm dev` | pass; API 3001, web 3000; one contracts watcher, one Nest backend watcher, one Next dev watcher; ports closed after stop |
| production API | pass; default `127.0.0.1:3001`, exact health body, SIGTERM exit 0 |
| production web | pass; `127.0.0.1:3100`, HTTP 200, honest copy; stopped with port closed. The `pnpm ... exec` wrapper reported exit 1 after SIGTERM; `next-server` stopped and the port closed. |
| worker | pass; `worker.ready`, no listening sockets, SIGTERM/SIGINT exit 0; repeated and mixed signals covered by suite |
| browser | pass by designer at 320, 390×844, and 1440×900; keyboard and reduced motion; no console errors or external requests |
| sanitized-env build | pass; provider/DB credentials stripped |

**Test count:** 4 focused runner tests + 12 app/package tests = **16 total**. The 12 app/package tests are unchanged: backend 7, config 2, contracts 2, web 1.

**Fresh logs**

- Focused tests: `/tmp/habi-fix-focused-tests.log`
- Frozen install: `/tmp/habi-fix-frozen.log`
- Forced lint: `/tmp/habi-fix-lint-force.log`
- Full verification: `/tmp/habi-fix-verify.log`
- Prior runtime logs remain available under `/tmp/habi-task4/`.
- No API, worker, or web preview process is left running.

**Browser and preview shutdown**

- Designer browser passed at 320, 390×844, and 1440×900, including keyboard and reduced-motion behavior, with no console errors or external requests.
- The designer also fixed the two `apps/web` config lint warnings; forced lint is now 0 errors, 0 warnings.
- Preview PID `25893` (pnpm) / child `25894` was verified as the Habi web process (cwd under this repository), stopped with graceful SIGTERM to the process group, and confirmed gone. Ports 3000 and 3001 are free. A user can run `pnpm dev` later.

**Compose blocker**

- Docker daemon is available (`29.5.2`).
- `docker compose` and `docker-compose` remain unavailable, so Compose config/up/down were not rerun. No Compose file changed since Task 1.
- The separate Task 1 manual Docker health evidence remains valid and is not represented as a Compose run.

**Documentation and GitHub metadata**

- Local `README.md` was updated to the runnable foundation, actual layout, verified commands, dotenv/verification behavior, local database notes, and links to the design, plan, and ledger. It keeps H-009 open and claims no product functionality.
- The repository README on GitHub is absent because the public repository is empty (no default branch contents; README API returns 404). No repository commit or push was performed.
- Public Project #1 README current-state text was updated to: local runnable foundation only; no auth/chat/Bots/model/Hermes/persistence/queue/deployment; H-009 open; no P0 phase gate passed. The manual **Group by: Status** warning was preserved. No issue, status, view, or field changes were made.
- Earlier evidence that described clean-install build ordering as passed was corrected: **clean-install was not run**. Fresh forced compilation + frozen install + dependency graph is not a clean-install proof.

#### Remaining for parent review

1. Parent rechecks the final runner by oracle/independent last script test.
2. Approve the Compose CLI blocker ruling: static validation and manual Docker health passed, but `docker compose config/up/down` must be rerun where the plugin exists.
3. Keep H-009 open. The parent performs final independent review and decides whether to close or move any issue.
