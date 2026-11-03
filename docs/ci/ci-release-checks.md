# CI and release checks

This document describes the checks that validate a change before it can be released, which of them block a merge, and how to run each one locally. It records the H-010 scope only: image builds and a repository secret scan are wired into CI; deployment, registries, signing, and migration validation are not.

No live CI run has validated the new `images` job yet. Its `actionlint`, secret-scan tests, and repository scan pass locally; the first hosted run is the remaining evidence.

## Workflows and jobs

| Workflow | Job | Runs on | Purpose |
|---|---|---|---|
| [`ci.yml`](../../.github/workflows/ci.yml) | `verify` | PR (non-draft), push to `main`, manual | Frozen install, forced build, typecheck, lint, forced tests, Turbo graph checks, review-helper tests, Sonar workflow tests |
| [`ci.yml`](../../.github/workflows/ci.yml) | `images` | PR (non-draft), push to `main`, manual | Release secret scan, web/API/worker image builds, API health check, worker start check |
| [`opencode-review.yml`](../../.github/workflows/opencode-review.yml) | `prepare`, `review`, `publish` | PR (non-draft, same repository) | Bounded AI review comment; informational only |
| [`sonarqube.yml`](../../.github/workflows/sonarqube.yml) | `sonarqube` | `main` push, manual, opted-in PRs | Optional self-hosted static analysis |

`images` is a separate job so the `verify` contract and its timeout stay unchanged. Neither job logs in to a registry, takes a provider token, or uses a third-party action beyond the checkout/setup-node pins already used by `verify`.

## Required checks matrix

| Check | Command evidence | Merge-blocking | Notes |
|---|---|---|---|
| Foundation verify | `pnpm verify:foundation` | Yes | Existing contract, unchanged |
| Review/Sonar helper tests | `node --test .github/scripts/review*.test.mjs`, `node --test scripts/ci/sonarqube.test.mjs` | Yes | Run inside `verify` |
| Release secret scan | `node scripts/ci/release-secret-scan.mjs` | Yes | Tracked files only; exit 1 on a finding |
| Secret-scan self-tests | `node --test scripts/ci/release-secret-scan.test.mjs` | Yes | Includes negative cases |
| Image build (web, API, worker) | `docker build …` (below) | Yes | Root build context, no push |
| API health check | `curl` against the built container | Yes | Bounded retry, asserts `status=ok` |
| Worker start check | `docker inspect` after `docker run` | Yes | Start-only; no listener assertion |
| SonarQube | Workflow only | No | Optional, configuration-gated, skipped without configuration |
| OpenCode review | Workflow only | No | Informational output; cannot edit the repository |
| PostgreSQL integration and migrations | None | Not applicable yet | No database integration or migration files exist |

**Blocking requires repository configuration.** Workflow YAML cannot mark a check required. A maintainer must enable branch protection (or a ruleset) for `main` and select both `Verify foundation` and `Build and inspect images` as required status checks. Until that is configured, a failing check is visible but does not itself prevent a merge. This change does not modify repository settings.

A pull request also stays unvalidated while it is a draft: both `ci.yml` jobs skip drafts. Marking the PR ready for review starts them.

## Secret scan

`scripts/ci/release-secret-scan.mjs` is a dependency-free Node runner:

- Reads `git ls-files` only, so untracked local files, build output, and ignored paths cannot affect the result.
- Fails on tracked `.env` and `.env.*` files; `.env.example` is allowed as documentation.
- Detects PEM/OpenSSH private-key blocks, AWS access key IDs, GitHub tokens, Slack tokens, Google API keys, Stripe live keys, OpenAI and Anthropic keys, npm tokens, and generic credential keyword assignments.
- Skips binary files (NUL byte in the leading bytes) and files over 1 MiB, and prints each skipped path with the reason.
- Never prints the matched value, so a real credential is not copied into CI logs.
- Exits `0` clean, `1` on findings, `2` on usage or not-a-git-repository errors.

The generic keyword rule does not scan test fixtures (for example `packages/config/test/env.test.mjs`, whose deliberate fake password exists to prove error messages do not echo values). Provider-pattern rules still scan every text file.

Handling a finding: treat the value as compromised, rotate it with the owning provider, remove it from the tracked file, and decide separately whether the commit needs history rewriting. Do not re-run the job to clear it and do not add an ignore entry unless a human confirms the value is not a credential.

## Image checks

The `images` job builds all three targets from the repository root with the plain Docker CLI (no new action, no registry, no cache export):

```bash
docker build -f apps/web/Dockerfile -t habi-web:ci .
docker build --target api -f apps/backend/Dockerfile -t habi-api:ci .
docker build --target worker -f apps/backend/Dockerfile -t habi-worker:ci .
```

Each image receives `org.opencontainers.image.revision` and `org.opencontainers.image.source` labels. Images exist only on the runner, so traceability is limited to those labels in that job; nothing is retained or published.

After the builds:

1. The API image starts with an ephemeral host port (`--publish 127.0.0.1::3001`), and `/health` is polled up to 30 times (about 90 seconds worst case). A response must parse as JSON with `status: "ok"`.
2. The worker image starts and must still be running after three seconds. The inert worker's listeners are not asserted; that check belongs to a later runtime task.
3. Both steps remove their container through an `EXIT` trap, including on failure.

The job timeout is 30 minutes because three cold image builds dominate its duration. BuildKit layer reuse makes the API and worker builds cheaper than the web build, but no cross-run cache is configured, so a runner without a warm cache rebuilds everything.

## What is not claimed

- No registry push, pull, image retention, or immutable artifact identifier. The issue's "retain build artifacts" item is not implemented.
- No image signing, SBOM generation, or vulnerability scanning. The secret scan covers tracked repository files, not image layers; images are not inspected for embedded credentials.
- No deployment, environment promotion, or release automation.
- No PostgreSQL integration tests and no migration validation: the repository has no database integration or migration files, so there is nothing to validate. Those H-010 checklist items stay open until the features they check exist.
- No coverage thresholds, no Sonar quality gate, and no branch protection automation.
- No third-party secret-scanning service and no network-dependent scanning. The scan is deterministic and works offline.
- The scan covers tracked text content only. Encoded, encrypted, or intentionally obfuscated secrets can evade pattern matching; it is a guard, not a guarantee.
- OpenCode review remains informational and is not a required check.

## Retrying and failing

- A new push to the same pull request cancels the superseded run through the workflow `concurrency` group.
- Re-run failed jobs from the GitHub Actions UI. There is no automatic retry.
- Rerun an image build only for an infrastructure failure (network, daemon). A health-check or worker-start failure is a code or image defect; inspect the container logs the step prints.
- Never re-run a failing secret scan to clear it. Fix the finding first.
- A failed required check blocks merge only when branch protection marks it required, as described above.

## Local equivalents

```bash
# Foundation checks (slow; run before pushing substantial changes)
pnpm verify:foundation

# Secret scan and its tests
node --test scripts/ci/release-secret-scan.test.mjs
node scripts/ci/release-secret-scan.mjs            # add --root <dir> to scan another checkout

# Image builds
docker build -f apps/web/Dockerfile -t habi-web:ci .
docker build --target api -f apps/backend/Dockerfile -t habi-api:ci .
docker build --target worker -f apps/backend/Dockerfile -t habi-worker:ci .

# API health check (ephemeral port, bounded retry)
docker run --detach --name habi-api-local --publish 127.0.0.1::3001 habi-api:ci
docker port habi-api-local 3001/tcp
curl --fail --silent "http://127.0.0.1:$(docker port habi-api-local 3001/tcp | awk -F: '{print $NF}')/health"
docker rm --force habi-api-local

# Worker start check
docker run --detach --name habi-worker-local habi-worker:ci
sleep 3
docker inspect --format '{{.State.Running}}' habi-worker-local
docker stop habi-worker-local
docker rm habi-worker-local

# Workflow syntax and shell checks
actionlint .github/workflows/ci.yml
```

A negative check for the secret scan, without touching the repository:

```bash
tmp="$(mktemp -d)"
git -C "$tmp" init -q
printf 'export const key = "AKIA%s";\n' "IOSFODNN7EXAMPLE" > "$tmp/config.ts"
git -C "$tmp" add config.ts
node scripts/ci/release-secret-scan.mjs --root "$tmp"   # exits 1, prints rule=aws-access-key-id
rm -rf "$tmp"
```

A deliberately failing `verify` check blocks release in the same way: make lint, typecheck, or a test fail and confirm `pnpm verify:foundation` exits non-zero. The hosted workflow reporting that failure as blocking still depends on the required-check configuration above.
