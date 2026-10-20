# Habi repository guidance

This is a project-specific supplement to the global agent contract. Read it before changing code, CI, review policy, or Sonar guidance. Do not restate the global contract here.

## Current state

- Runnable local foundation only: pnpm/Turborepo, a minimal Next.js/React/Tailwind web shell, a NestJS health API, an inert headless worker, shared contracts/config, and local PostgreSQL Compose tooling.
- H-009 remains open and no P0 gate has passed. Authentication, chat, Bots, model calls, Hermes production, persistence, queueing, database integration, uploads, and deployment are not implemented.
- Do not describe planned behavior as present. Apply later requirements only when that feature is being implemented.
- `packageManager` in `package.json` and `.node-version` are the version baseline. Read them; do not cache version numbers in guidance.

## Repository map

- `apps/web` — Next.js web shell.
- `apps/backend` — NestJS API and headless worker.
- `packages/contracts` — shared type-only contracts.
- `packages/config` — shared TypeScript and ESLint base.
- `scripts/` — foundation verification and `scripts/ci` focused checks.
- [OpenCode review operations](docs/ci/opencode-review.md) and [SonarQube operations](docs/ci/sonarqube.md); [Sonar engineering guidance](docs/SONAR_GUIDELINES.md); `docs/superpowers/` — design, plan, ledger.
- `.github/review/` — trusted OpenCode review prompts; `.github/scripts/` — review helpers/tests; `.github/workflows/` — CI, OpenCode review, optional SonarQube.
- Root `compose.yaml`, `sonar-project.properties`, `tsconfig.sonar.json`.

## Verification

- `pnpm verify:foundation` — frozen install, forced build/tests, typecheck, lint, graph checks, and focused runner tests. Use for foundation changes.
- `pnpm test` — workspace/package tests. `pnpm test:verification` — focused verification-runner tests. They are distinct.
- Direct CI-focused checks: `node --test .github/scripts/review.test.mjs`; `node --test scripts/ci/sonarqube.test.mjs`; `actionlint .github/workflows/ci.yml .github/workflows/opencode-review.yml .github/workflows/sonarqube.yml`.
- Doc-only changes require link/path/Markdown checks; the full foundation suite is not required.

## CI, review, and Sonar boundaries

- Current CI runs `pnpm verify:foundation` and both focused files: `.github/scripts/review.test.mjs` and `scripts/ci/sonarqube.test.mjs`.
- OpenCode review output is informational and cannot edit the repository or review policy. The hardened review lane is in progress; do not claim a live model comment or pass. The approved mode is keyless only and does not reference `OPENCODE_API_KEY` or require a provider token. A separate publisher owns limited GitHub comment access outside the review container.
- The contained review runtime receives no GitHub or provider token and permits read/bash only inside the container; all other tool permissions are denied. "Read-only" is an output/repository boundary, not a strict no-tools environment; tool-use output is not review evidence. The CI review runtime is not product Bot capability; the POC no-shell/no-browser boundary is unchanged. Implementation, bootstrap pins, and runtime controls live in [the operations doc](docs/ci/opencode-review.md).
- OpenCode loads only its three trusted base prompts (`.github/review/system.md`, `security.md`, `bugs.md`). It does not load `AGENTS.md`, native skills, or `docs/SONAR_GUIDELINES.md` automatically. Changing guidance does not change review policy; propagate rules with a separately reviewed manual prompt update.
- SonarQube is an optional, self-hosted, configuration-gated lane. No live pass is known. Missing configuration skips; configured scans can pass or fail. No LCOV, arbitrary numeric server-gate thresholds, fake coverage, or blanket exclusions.
- Operational Sonar details live in `docs/ci/sonarqube.md`, `sonar-project.properties`, `tsconfig.sonar.json`, and `.github/workflows/sonarqube.yml`. Use [the guidelines](docs/SONAR_GUIDELINES.md) for engineering rules, not as a server quality profile.

## Security and change discipline

- Backend-enforced ownership and cross-user/conversation isolation are mandatory. Bot Markdown and uploads are untrusted and never grant capability. Effective capability is the intersection of user identity, Bot allow-list, and selected conversation context.
- Keep secrets server-side. Do not add silent paid-provider fallback or POC shell/browser/unrelated-tool capability.
- Fix findings by reproducing the issue, reading evidence, making the smallest safe change, and verifying. Do not suppress findings or exclude code just to pass.
- Only validated, reproducible findings can become Sonar guidance. AI review findings are not authority; reviewer output cannot edit policy. A human validates rule changes.
