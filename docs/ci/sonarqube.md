# Self-hosted SonarQube

This lane adds an optional, self-hosted SonarQube analysis workflow. It is **not** a quality-gate claim, does not change project status, and does not assert that a SonarQube server or project exists. No host URL, project key, token, certificate, or TransformLit identifier is committed.

## Scope

- Workflow: [`.github/workflows/sonarqube.yml`](../../.github/workflows/sonarqube.yml)
- Project settings: [`sonar-project.properties`](../../sonar-project.properties)
- Analyzer-only TypeScript config: [`tsconfig.sonar.json`](../../tsconfig.sonar.json)
- Focused checks: [`scripts/ci/sonarqube.test.mjs`](../../scripts/ci/sonarqube.test.mjs)

The workflow analyzes the current repository as a static source tree. It does not install dependencies, run package lifecycle scripts, start the application, or deploy anything.

## Requirements

- **SonarQube Server Developer Edition or higher** for pull-request analysis and repository decoration. Community Build may not support pull-request analysis; keep PR scans disabled if the server cannot support them.
- A project already created on the SonarQube server and bound to this repository for decoration.
- A GitHub-hosted `ubuntu-latest` runner that can reach the SonarQube server over HTTPS. A private-network server requires an approved trusted runner or network change; this workflow does not modify the host or add a self-hosted runner automatically.
- Self-hosted runners are not the default for arbitrary pull requests. If a trusted runner is required, restrict it to trusted same-repository work and review the security model separately.

## GitHub configuration

Repository variables:

| Variable | Required | Purpose |
|---|---|---|
| `SONAR_HOST_URL` | Main and PR scans | SonarQube base URL. Must be a canonical `https://` URL with no credentials, query, fragment, whitespace, or control characters; maximum 2048 characters. `http://` fails preflight. |
| `SONAR_PROJECT_KEY` | Main and PR scans | Project key created on the SonarQube server. The key is case-sensitive and must use only letters, numbers, dot, underscore, dash, or colon, with at least one non-digit. It is passed as a quoted action argument, not interpolated into a shell command. |
| `SONAR_PR_ANALYSIS_ENABLED` | PR scans only | Set to exactly `true` to opt in to same-repository, non-draft pull-request scans. |

Repository secrets:

| Secret | Required | Purpose |
|---|---|---|
| `SONAR_TOKEN` | Main and PR scans | Server token. It is exposed only to the preflight and scan steps; it is never printed. |
| `SONAR_ROOT_CERT` | Optional | Additional PEM certificate for SonarQube Server or a TLS-terminating proxy, passed through the action's official `SONAR_ROOT_CERT` environment input. |

Do not reuse another product's host or project IDs. Use the values for this repository's own SonarQube project.

## Trigger and skip behavior

- **Push to `main`:** analysis runs when the variables and token are configured.
- **`workflow_dispatch`:** runs only on the `main` ref. Dispatch on another branch skips the job.
- **Pull requests:** `opened`, `synchronize`, `reopened`, and `ready_for_review`. The job runs only when all of these are true:
  - `SONAR_PR_ANALYSIS_ENABLED` is exactly `true`;
  - the pull request is from the same repository, not a fork;
  - the pull request is not a draft.
- Fork and draft pull requests skip the job before checkout, so they receive no secrets.
- There is no `pull_request_target` trigger.

The preflight step runs before checkout. When `SONAR_HOST_URL`, `SONAR_PROJECT_KEY`, or `SONAR_TOKEN` is missing, it emits a notice and sets `configured=false`; install, checkout, setup, and scan steps are skipped cleanly. Missing configuration is a skip, not a failed analysis. An invalid URL or project key fails preflight explicitly; a server outage or quality-gate failure still fails the analysis job.

## Security properties

- Workflow permissions are `contents: read` only. No `id-token`, write permissions, or metadata writes.
- `actions/checkout` uses `persist-credentials: false` and `fetch-depth: 0`.
- No `pnpm install`, `npm install`, build, test, or package lifecycle step runs with `SONAR_TOKEN`.
- The token is not a job-level environment variable. It is present only in the preflight step and the scan step.
- The workflow does not execute pull-request code as a shell script. The Sonar scanner analyzes the checked-out source statically.
- The workflow has a 20-minute timeout and a concurrency group; PR runs cancel superseded PR runs.
- The default runner is `ubuntu-latest`; no self-hosted runner is selected automatically.

## Action pins and scanner

- `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1` (`v7.0.1`)
- `actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1` (`v7.1.0`)
- `SonarSource/sonarqube-scan-action@d209202bc7d53ff1cc128f7f907dac145c9d6ae9` (`v8.3.0`)

The scan action metadata at this SHA declares `runs.using: node24`. The workflow explicitly selects Sonar Scanner CLI `8.2.0.6438`; that binary was confirmed available from the official distribution. The action metadata at this SHA declares an older default scanner version, so the explicit input is intentional. The project key and quality-gate settings are passed through quoted action `args` entries, not interpolated into a shell command. The validated host URL is supplied only through the official `SONAR_HOST_URL` environment variable. The action arguments override PR-editable project properties for the key and quality gate.

## Quality gate and coverage

The workflow passes:

```text
-Dsonar.qualitygate.wait=true
-Dsonar.qualitygate.timeout=300
```

A failing or timed-out quality gate fails the analysis job. Missing configuration skips only; it does not hide analysis or server failures.

There is **no LCOV or coverage report property**. The repository's smoke tests are not source-mapped coverage and must not be presented as such. Do not claim a coverage or quality-gate pass from this lane. If coverage becomes a requirement, generate a real source-mapped report in a separate trusted job and wire it explicitly; do not fabricate a report or add a placeholder LCOV path.

## Branch and pull-request detection

Do not set `sonar.branch.name`, `sonar.pullrequest.*`, or other manual branch/PR identity properties. The official action and a Developer Edition+ server handle branch and PR detection and repository decoration. Configure the repository binding on the SonarQube server first.

## Source and test layout

`sonar-project.properties` analyzes:

- sources: `apps/web/app`, `apps/backend/src`, `packages/contracts/src`, `packages/config/eslint`, `scripts`;
- tests: `apps/backend/test`, `apps/web/test`, `packages/config/test`, `packages/contracts/test`.

Generated and non-product files are excluded, including `node_modules`, `dist`, `.next`, `.turbo`, coverage, `next-env.d.ts`, `*.tsbuildinfo`, documentation, and dotenv files. All script test files matching `scripts/**/*.test.mjs` are intentionally outside Sonar analysis, including the foundation verification tests and focused workflow tests; they still run through their respective Node test commands.

### TypeScript analysis config

`sonar.typescript.tsconfigPaths=tsconfig.sonar.json` points Sonar at a standalone analyzer-only config. This follows the official Sonar guidance for projects whose normal `tsconfig` files extend external or workspace configs that may be unavailable during analysis. See [JavaScript/TypeScript/CSS analysis](https://docs.sonarsource.com/sonarqube-server/analyzing-source-code/languages/javascript-typescript-css).

`tsconfig.sonar.json` deliberately has:

- no `extends`, `references`, `paths`, `baseUrl`, `typeRoots`, or workspace config import;
- `types: []` so it does not require `@types` packages;
- `target: ES2023`, `strict`, `noEmit`, `skipLibCheck`, and `jsx: preserve`;
- `module: ESNext` and `moduleResolution: Bundler`;
- `experimentalDecorators: true` so Nest constructor/controller syntax is parsed correctly;
- `allowJs` for the local ESLint and script files;
- source roots `apps/backend/src`, `apps/web/app`, `packages/contracts/src`, `packages/config/eslint`, and `scripts`, with test files excluded.

This is an analysis config, not the production typecheck or application build. `pnpm typecheck` continues to use the workspace application configs. The scan does not install dependencies, so imported third-party symbols may still have limited type precision when their packages or `@types` are absent; that is a precision limitation, not a missing-`extends` failure. Do not run `pnpm install` or package lifecycle scripts with `SONAR_TOKEN` on pull requests to improve it.

The local parser check does not require external extends or `@types`:

```bash
packages/contracts/node_modules/.bin/tsc --showConfig -p tsconfig.sonar.json
packages/contracts/node_modules/.bin/tsc --listFilesOnly -p tsconfig.sonar.json
```

`--showConfig` reports the standalone options with `types: []` and no `extends`. `--listFilesOnly` parses successfully. With workspace dependencies present locally, imported third-party declarations can still appear in the file list; the config itself does not depend on them.

## Validation

Local static checks do not contact a SonarQube server, use credentials, or trigger manual workflow runs:

```bash
node --test scripts/ci/sonarqube.test.mjs
```

The focused checks cover the inline preflight cases (missing configuration, valid HTTPS configuration, non-HTTPS rejection, malformed/credentialed/query/fragment/newline hosts, unsafe project keys, and token non-disclosure), workflow trigger/guard invariants, action pins, security settings, scanner/quality-gate arguments, project properties, and the standalone TypeScript config. Use `actionlint` when available; otherwise parse the YAML with a YAML parser. The normal foundation verification remains `pnpm verify:foundation` and is not replaced by these checks. This lane does not call a real SonarQube server or use credentials; actual server analysis remains unverified until the parent runs it with configured secrets.
