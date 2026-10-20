# OpenCode pull-request review

This lane runs an automated, informational review on internal pull requests through a hardened container runtime. It is deliberately separate from CI and Sonar: the review is not a required status check, approval, or merge instruction.

Status: batched review is implemented. A head is fully reviewed only when an actual current batched GitHub Actions run completes every trusted batch, passes the in-container self-test, publishes an aggregate report, and reports complete manifest coverage for that reviewed SHA. Prior single-batch comments and helper tests are not that evidence.

## Trigger and jobs

`.github/workflows/opencode-review.yml` runs on `pull_request` events `opened`, `synchronize`, `reopened`, and `ready_for_review`.

- **prepare** — checks out the pull request's immutable base SHA, or a separately verified approved bootstrap commit when base review assets are absent. It fetches PR metadata and file patches through the GitHub API and builds a version 2 manifest plus bounded per-batch prompts from that trusted source. It emits a matrix containing only generated batch IDs and count. It never checks out, installs, or executes files from the PR checkout.
- **review** — is a matrix job with `max-parallel: 4` and `fail-fast: false`, so up to four isolated VMs review batches concurrently. Each job has no repository checkout and `permissions: {}`, downloads the trusted artifact, verifies Linux/Docker/iptables/passwordless-sudo prerequisites, verifies the pinned OpenCode CLI, and runs only its own generated batch ID through the unchanged container runtime. The model validates the manifest entry, batch ID, input prompt hash, and actual prompt bytes before execution. A batch may use at most two sequential attempts of the same validated request; each attempt runs a fresh contained runtime with its own mandatory self-test and cleanup.
- **publish** — has `pull-requests: write` and `actions: read`. It lists this run's artifacts as the authority for which outcome artifacts exist, downloads `review-outcome-*` without flattening, validates artifact-name/batch/filename relationships and each bounded outcome against the trusted manifest, rechecks that the PR is open at the same base/head SHAs, and creates or updates one owned aggregate comment. It runs after matrix success or ordinary matrix failure when preparation succeeded; cancellation may prevent publication.

Concurrency is per PR and cancels older runs. Fork PRs are skipped with a workflow notice. Draft PRs are skipped until `ready_for_review`.

## Bootstrap

The default trusted source is the immutable event base SHA. All review helpers, the batch planner, runtime modules, and the three prompts come from that source, never from the PR head or a working tree. Both the base probe and the post-checkout verification require the planner alongside the other trusted helpers.

If the base lacks any trusted asset, the prepare job may use one administrator-controlled repository variable:

```text
OPENCODE_REVIEW_BOOTSTRAP_SHA=<full 40-character lowercase commit SHA>
```

The value must be an exact, immutable, same-repository commit SHA approved by maintainers. It is read only from repository variables, never from PR content, the PR head, a branch, tag, or prefix. The workflow checks out that SHA into a separate directory, verifies the checked-out HEAD equals the pin, verifies every trusted asset, and only then runs the prepare helper. A missing pin produces an explicit skip; a malformed pin fails. If the event base already contains all assets, the base wins and the variable is ignored automatically.

A bootstrap pin must be a full commit that contains the planner, helpers, runtime modules, and prompts. Historical pins that predate those assets cannot provide them and are intentionally not repeated here. Maintainers point the variable at a reviewed full SHA containing all trusted assets; the value belongs to repository configuration rather than this document. Remove or repoint it after the event base contains those assets. The workflow's bootstrap logic is otherwise unchanged and does not substitute the PR head.

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

The self-test is mandatory inside `runContainedCli` before any model call; the workflow does not duplicate it. Network-module errors are fatal. The 25-minute job timeout covers image pull/build, the mandatory self-test, and up to two sequential model attempts, each with the unchanged 8-minute CLI timeout. That bound is `2 * 8` minutes plus runtime setup and self-test overhead; it is not a guarantee that both attempts finish.

## Input, batching, and privacy

The prepare step covers all available changed text from the GitHub files API (up to its 3,000-file window) and splits it deterministically into at most 256 batches. Each batch is capped at 120,000 bytes including framing, and may split a large patch across hunks or line-aligned fragments; oversized single lines are split at UTF-8 boundaries with explicit continuation metadata. The manifest is the coverage authority: it records expected and received file counts, per-file patch hashes and segment counts, generated batch IDs and prompt hashes, and unreviewable files. It is trusted by same-run artifact provenance, not by a consumer-side hash check, and is never read from PR content.

The model job runs each batch independently at up to four-way parallelism. Batch IDs are generated (`b0001`...) and validated before any path is used; PR filenames never enter artifact paths or matrix values. Every batch prompt includes all three trusted guides. Raw CLI stdout is capped at 2 MB; each outcome review text is capped at 24,000 bytes; each model attempt has an unchanged 8-minute timeout inside a 25-minute job. A retry, when allowed, sends the identical already-validated batch, prompt bytes, model, and fixed trusted configuration; it never changes the prompt hash, sub-batches the input, or merges partial artifacts.

Binary, empty, or oversized patches are explicitly unreviewable, not reviewed. Enumeration mismatch, the GitHub 3,000-file API limit, and more than 256 batches fail or report incomplete explicitly; there is no smaller silent batch cap. A diff is complete only when every supplied text segment was reviewed, the file list was complete, and there were no unreviewable patch gaps. A zero-batch run reports that no reviewable text was available rather than assuming the files are clean.

The PR title and description are not sent. Only changed-file metadata and provided patches are sent to the configured OpenCode Zen model. Reviewing a diff sends that content to the provider under OpenCode Zen's current terms and data-handling policy; this document makes no claim of zero retention. Keep secrets, customer data, and private keys out of pull-request diffs.

The prepare artifact contains the manifest, per-batch input and prompt files, prompts, trusted helpers, and producer-side bookkeeping. Test files, PR code, secrets, and PR-controlled build-context files are not copied into inference. Each model job writes only one bounded outcome per batch containing identity, batch ID, prompt hash, status, coverage, final review text, a fixed diagnostic code, and safe per-attempt metadata. Attempt metadata is limited to at most two entries with an index, status, sanitized code, optional finish reason, optional bounded input/output/reasoning token counts, and an optional numeric provider status. Raw JSONL events, stdout, stderr, sessions, provider messages, and API bodies are not uploaded or published.

## Output and reliability

The published comment starts with `<!-- habi-opencode-review:v1 -->` and is updated in place rather than duplicated. It aggregates only outcomes that match the trusted manifest's expected batch IDs, prompt hashes, identity, and trusted source. The trusted run artifact listing, not downloaded filenames, decides which outcome artifacts exist; duplicates, mismatched names, and extra files cannot silently complete coverage. It reports reviewed files and text segments, reviewed/missing/unavailable/failed batches, unreviewable patches, and enumeration completeness. The aggregate status is `complete` only when every expected batch was reviewed, every supplied segment is covered, the file list is complete, and there are no unreviewable patch gaps. Missing, duplicate, swapped, stale, malformed, unexpected, unavailable, or error outcomes make the report `incomplete`; unexpected artifacts never contribute findings and are counted explicitly.

Review text is sanitized: unsafe controls and bidi characters are removed, mentions are escaped, and each batch's findings are rendered inside a dynamic inert code fence with batch attribution. A reviewed outcome is stamped with the event head SHA before upload, and the aggregate comment includes that reviewed SHA; the publisher still rechecks that the PR is open at the same base and head before posting. The publisher inspects up to 500 existing comments. If the owned marker is not found and that window is incomplete, it skips with a warning instead of creating a duplicate.

Full bounded per-batch outcomes remain available as `review-outcome-*` artifacts, and the aggregate comment always links the workflow run. Published comments are capped at 60,000 bytes; the aggregate comment budget is 28,672 bytes. If the collected findings cannot fit, the aggregate discloses truncation outside the inert fence and links to the full artifacts, so trailing findings are not silently dropped. An aggregate JSON artifact (`review-aggregate`) records the full collected findings plus missing/failed/unavailable counts.

The aggregate publisher runs after matrix success or ordinary matrix failure when preparation succeeded, so partial coverage is reported while the failed matrix job remains red. Cancellation may prevent publication and is not described as guaranteed partial publication. Provider quota, rate-limit, model-unavailable, and CLI timeout outcomes are informational and do not fail required CI, but they cannot establish completeness. Container, network, isolation, and self-test failures are fatal error outcomes, never provider-unavailable outcomes. Malformed JSONL, missing stop/final text, tool use, identity mismatch, invalid schema, prompt corruption, and publish failures also fail this workflow. No blanket `continue-on-error` is used.

### Bounded inference retries

A single batch may make at most two sequential attempts, and only after an explicit typed, structured signal:

- `step_finish` with the structured output-length reason (`length`), including any bounded token counts present in that event.
- A structured provider error with numeric HTTP `429`, `500`, `502`, `503`, or `504`.
- A structured `403` whose exact error identifier is `free-tier-admission`, mapped to the informational `provider-free-tier-rejected` code. This is the only `403` retry; arbitrary `403` and every `401` remain fatal configuration/auth failures.

No other result is retried. Runtime exceptions, container/cleanup/iptables/isolation/integrity failures, malformed JSONL, tool use, raw output-limit overflow, missing/garbled hashes or schema, cancellation, unstructured stderr, and unknown `cli-error` results stay fatal on the first observed attempt. A CLI timeout remains an informational `unavailable` outcome, is not retried, and cannot establish complete coverage. Provider text is never matched against Docker or CLI stdout/stderr to infer a retry. Each retry is the same already-validated manifest entry, batch ID, prompt hash and prompt bytes, free keyless model, and fixed trusted configuration; there is no sub-batching, artifact mixing, provider fallback, key use, or user-agent/auth workaround. Only a clean final `stop` result becomes review evidence; earlier incomplete attempts never contribute findings, and the final outcome's `attempts` metadata records the bounded sequence for operators. The manifest's expected batch count is unchanged, and exactly one outcome artifact per batch is uploaded.

## Security boundaries and limitations

- The workflow assumes trusted repository writers. On an internal PR, the workflow file itself is part of the PR and could be modified; helpers and prompts are still taken from the event base or an administrator-approved bootstrap SHA, but a malicious workflow edit is outside the protection this lane can provide.
- Each matrix job is a separate GitHub-hosted VM with its own contained runtime, network policy, and mandatory self-test. Batches share no process, container, or network state.
- The review job has no GitHub API permissions and no repository checkout. Its artifact actions use the Actions runtime token. The container receives no GitHub token, Actions runtime variables, or provider key, and has no host mounts, Docker socket, host network, or PR checkout.
- Native tool permissions inside the container are `read`/`bash` only; every other tool is denied. The OS container, not the tool permission list, is the isolation boundary. The trusted prompt asks the model to produce review text without taking external actions, and tool-use output is never accepted as review evidence: the parser rejects any `tool_use` event as fatal.
- The container permits public HTTPS and DNS; endpoint-level restrictions are not claimed. Public content in the input can therefore be sent to the public provider, and a compromised model response could attempt exfiltration through that allowed path. This residual risk was reviewed and accepted for public-diff input with no GitHub or provider credentials and no container-host access.
- The publish token is limited to `pull-requests: write` and `actions: read` for this run's artifact listing; there is no `contents` write, `id-token`, or Actions cache permission.
- Comment ownership requires the exact GitHub.com Actions bot login `github-actions[bot]`, type `Bot`, and the official id when present. A GHES installation uses a different bot identity; this lane targets GitHub.com.
- No raw model-event, CLI stream, or session audit artifact is retained by design, because those can contain sensitive prompt or provider data. Only bounded per-batch outcomes and the aggregate JSON are kept for the current run.
- The lane is not a substitute for independent security review, tests, or human approval. It reviews only the provided diff and cannot establish behavior outside that scope.
- The CI review container is not product Bot capability. The product Bot POC's no-shell/no-browser boundary is unchanged.

## Local validation

The focused helper tests use only Node built-ins and stub fetch/CLI/container calls; they do not contact a provider, GitHub, or Docker locally:

```bash
node --test .github/scripts/review.test.mjs
node --test .github/scripts/review-container.test.mjs
node --test .github/scripts/review-network.test.mjs
node --test .github/scripts/review-batches.test.mjs
actionlint .github/workflows/opencode-review.yml .github/workflows/ci.yml .github/workflows/sonarqube.yml
```

The planner suite includes lossless patch reconstruction, CRLF and no-final-newline text, oversized single-line continuation metadata, hunk grouping at PR scale, unreviewable patches, the 256-batch failure, and deterministic generated IDs/hashes. A planner dry run is source-level validation only; only a live current batched run establishes review coverage.

CI runs the four review suites in one step after `pnpm verify:foundation`; SonarQube checks remain a separate step.
