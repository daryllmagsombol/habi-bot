# OpenCode pull-request review

This lane runs an automated, informational review on internal pull requests through a hardened container runtime. It is deliberately separate from CI and Sonar: the review is not a required status check, approval, or merge instruction.

Status: the contained source/runtime hardening is in progress. No successful production comment or live pass is claimed yet. Acceptance requires a real GitHub Actions run that completes the in-container network self-test and publishes a `reviewed` outcome.

## Trigger and jobs

`.github/workflows/opencode-review.yml` runs on `pull_request` events `opened`, `synchronize`, `reopened`, and `ready_for_review`.

- **prepare** — checks out the pull request's immutable base SHA, or a separately verified approved bootstrap commit when base review assets are absent. It fetches PR metadata and file patches through the GitHub API and builds a bounded input from that trusted source. It never checks out, installs, or executes files from the PR checkout.
- **review** — has no repository checkout and `permissions: {}`. It downloads the trusted input artifact with the Actions runtime token, verifies Linux/Docker/iptables/passwordless-sudo prerequisites, verifies the pinned OpenCode CLI, and runs the review through the container runtime. The runtime builds its own fixed build context from the verified CLI and entry point; no PR artifact or PR code is used as build context.
- **publish** — has only `pull-requests: write`. It rechecks that the PR is open and still at the same base/head SHAs, then creates or updates one marker comment. The publisher is unchanged from the security-reviewed implementation.

Concurrency is per PR and cancels older runs. Fork PRs are skipped with a workflow notice. Draft PRs are skipped until `ready_for_review`.

## Bootstrap

The default trusted source is the immutable event base SHA. All review helpers, runtime modules, and the three prompts come from that source, never from the PR head or a working tree.

If the base lacks any trusted asset, the prepare job may use one administrator-controlled repository variable:

```text
OPENCODE_REVIEW_BOOTSTRAP_SHA=<full 40-character lowercase commit SHA>
```

The value must be an exact, immutable, same-repository commit SHA approved by maintainers. It is read only from repository variables, never from PR content, the PR head, a branch, tag, or prefix. The workflow checks out that SHA into a separate directory, verifies the checked-out HEAD equals the pin, verifies every trusted asset, and only then runs the prepare helper. A missing pin produces an explicit skip; a malformed pin fails. If the event base already contains all assets, the base wins and the variable is ignored automatically.

The previously discussed rollout pin is not a current recommendation. That commit predates the container runtime modules and cannot provide them; it is intentionally not repeated here. After the runtime/security review is accepted, maintainers must set a new reviewed full SHA that contains all trusted assets. This branch neither commits nor repins that variable. The workflow's bootstrap logic is otherwise unchanged and does not substitute the PR head.

The trusted source SHA and whether bootstrap was used are recorded in the workflow log and artifact metadata. The diff base and head remain the event's original values; the bootstrap SHA never replaces them, and the trusted-source metadata is immutable for the run.

This is intentional: a PR cannot supply the review policy or executable helpers that review it. Later PRs that change the assets are still reviewed with the trusted base copies until the change merges.

## Setup and model

No secret is required or read. The review is **keyless only**: it uses OpenCode Zen keyless access for the fixed free model. The workflow reads and forwards no provider key, and there is no paid-provider fallback.

- Model: `opencode/deepseek-v4.1-flash-free`
- `share` is disabled; title, summary, and compaction helpers are disabled
- One provider/model is enabled; model changes are out of scope

The container configuration is the single source of truth exported by `.github/scripts/review-container.mjs`. It sets `*` to `deny` and permits only `read` and `bash` inside the OS container described below. There is no host-process fallback: if the container runtime, isolation module, or self-test fails, the review fails closed.

The OpenCode CLI and base image are pinned in `.github/scripts/review-container.mjs`. The workflow downloads the pinned OpenCode `v1.19.3` linux/x64 release asset, verifies the approved archive digest, and requires the archive to contain exactly one root member named `opencode`. The module separately verifies the extracted binary digest. The base image is a fixed digest, not a floating tag. It never uses `curl | bash` or an npm wrapper. Exact versions and digests live in the runtime module; this document does not duplicate them.

## Runtime isolation and self-test

The review job runs on GitHub-hosted `ubuntu-latest` only, with `permissions: {}` and no `contents` access. Before inference, the runtime:

- verifies the CLI binary digest and the pinned base image
- creates a dedicated Docker network with its own bridge and an iptables policy
- verifies that private, metadata, host, IPv6, and host-gateway destinations are blocked while public DNS and public HTTPS remain available
- builds a minimal image from the verified CLI and the fixed entry module
- starts a self-test container with a read-only root filesystem, dropped capabilities, no bind mounts, no host network/PID/IPC, and a non-root user
- refuses to run the model unless the self-test passes

The self-test is mandatory inside `runContainedCli` before any model call; the workflow does not duplicate it. Network-module errors are fatal. The 15-minute job timeout covers image pull/build, the self-test, and the model run.

## Input, output, and privacy

The model input is capped at approximately 120 KB. The outcome review text is capped at approximately 24 KB, raw CLI stdout is capped at 2 MB, and the model process has an 8-minute timeout inside a 15-minute job. Files beyond the input limit, patches truncated by the limit, and files GitHub reports without a patch (binary, empty, or too large) are listed explicitly in the coverage summary. The lane never claims a complete review of such a diff.

The PR title and description are not sent. Only changed-file metadata and provided patches are sent to the configured OpenCode Zen model. Reviewing a diff sends that content to the provider under OpenCode Zen's current terms and data-handling policy; this document makes no claim of zero retention. Keep secrets, customer data, and private keys out of pull-request diffs.

The prepare artifact contains only the bounded input, prompts, trusted helpers, and producer-side hash metadata. Test files, PR code, secrets, and PR-controlled build-context files are not copied into the inference path. The model job writes only a bounded outcome containing identity, status, coverage, the final review text, and a fixed diagnostic code when needed. Raw JSONL events, stdout, stderr, sessions, and API bodies are not uploaded or published.

## Output and reliability

The published comment starts with `<!-- habi-opencode-review:v1 -->` and is updated in place rather than duplicated. Review text is sanitized: unsafe controls and bidi characters are removed, mentions are escaped, and the text is rendered inside a dynamic inert code fence so HTML and image syntax cannot execute. A reviewed outcome is stamped with the event head SHA before upload, and the published comment includes that reviewed SHA; the publisher still rechecks that the PR is open at the same base and head before posting.

The publisher inspects up to 500 existing comments. If the owned marker is not found and that window is incomplete, it skips with a warning instead of creating a duplicate. Review text truncated by the model output cap or the comment-size budget is disclosed by a fixed notice outside the inert fence.

Provider quota, rate-limit, model-unavailable, and CLI timeout outcomes are informational and do not fail required CI, but they are not review evidence. Container, network, isolation, and self-test failures are fatal error outcomes, never provider-unavailable outcomes. Malformed JSONL, missing stop/final text, tool use, identity mismatch, invalid schema, prompt corruption, and publish failures also fail this workflow. No blanket `continue-on-error` is used.

## Security boundaries and limitations

- The workflow assumes trusted repository writers. On an internal PR, the workflow file itself is part of the PR and could be modified; helpers and prompts are still taken from the event base or an administrator-approved bootstrap SHA, but a malicious workflow edit is outside the protection this lane can provide.
- The review job has no GitHub API permissions and no repository checkout. Its artifact actions use the Actions runtime token. The container receives no GitHub token, Actions runtime variables, or provider key, and has no host mounts, Docker socket, host network, or PR checkout.
- Native tool permissions inside the container are `read`/`bash` only; every other tool is denied. The OS container, not the tool permission list, is the isolation boundary. The trusted prompt asks the model to produce review text without taking external actions, and tool-use output is never accepted as review evidence: the parser rejects any `tool_use` event as fatal.
- The container permits public HTTPS and DNS; endpoint-level restrictions are not claimed. Public content in the input can therefore be sent to the public provider, and a compromised model response could attempt exfiltration through that allowed path. This residual risk was reviewed and accepted for public-diff input with no GitHub or provider credentials and no container-host access.
- The publish token is limited to `pull-requests: write`; there is no `contents` write, `id-token`, or Actions cache permission.
- Comment ownership requires the exact GitHub.com Actions bot login `github-actions[bot]`, type `Bot`, and the official id when present. A GHES installation uses a different bot identity; this lane targets GitHub.com.
- No raw audit artifact is retained by design, because raw model events and stderr can contain sensitive prompt or provider data.
- The lane is not a substitute for independent security review, tests, or human approval. It reviews only the provided diff and cannot establish behavior outside that scope.
- The CI review container is not product Bot capability. The product Bot POC's no-shell/no-browser boundary is unchanged.

## Local validation

The focused helper tests use only Node built-ins and stub fetch/CLI/container calls; they do not contact a provider, GitHub, or Docker locally:

```bash
node --test .github/scripts/review.test.mjs
node --test .github/scripts/review-container.test.mjs
node --test .github/scripts/review-network.test.mjs
actionlint .github/workflows/opencode-review.yml .github/workflows/ci.yml .github/workflows/sonarqube.yml
```

CI runs the three review helper suites in one step after `pnpm verify:foundation`; SonarQube checks remain a separate step.
