# OpenCode pull-request review

This lane runs an automated, read-only review on internal pull requests. It is deliberately separate from CI and Sonar: the review is informational and is not a required status check, approval, or merge instruction.

## Trigger and jobs

`.github/workflows/opencode-review.yml` runs on `pull_request` events `opened`, `synchronize`, `reopened`, and `ready_for_review`.

- **prepare** — checks out only the pull request's base SHA, fetches PR metadata and file patches through the GitHub API, and builds a bounded input from base-commit helpers and prompts. It never checks out, installs, or executes files from the PR checkout.
- **review** — has no repository checkout and `permissions: {}`. It downloads the trusted input artifact with the Actions runtime token, verifies and runs the pinned OpenCode CLI, and writes a bounded outcome artifact.
- **publish** — has only `pull-requests: write`. It rechecks that the PR is open and still at the same base/head SHAs, then creates or updates one marker comment.

Concurrency is per PR and cancels older runs. Fork PRs are skipped with a workflow notice. Draft PRs are skipped until `ready_for_review`.

## Bootstrap

The helpers and all three review prompts must exist on the immutable base SHA. An initial PR that adds these assets to a base without them is expected to skip review until they merge. Later PRs that change them are still reviewed with the base copies until the change merges. This is intentional: a PR cannot supply the review policy or executable helpers that review it. After the first merge, later PRs use the merged base copies automatically.

## Setup

No secret is required. The workflow attempts OpenCode Zen keyless access on a best-effort basis, subject to current quotas and availability.

Optionally add a repository Actions secret named `OPENCODE_API_KEY`. If supplied, the CLI uses it directly. If absent, the environment variable is omitted and the CLI's built-in keyless path is attempted. The workflow does not fall back to another provider or paid model.

`share` is disabled, model/provider selection is fixed to `opencode/deepseek-v4.1-flash-free`, tools are denied, and background title/summary/compaction agents are disabled. The configuration is passed through `OPENCODE_CONFIG_CONTENT` only for this CI process; it does not modify a developer's local OpenCode config, so no local restart is needed.

The CLI is pinned to OpenCode `v1.19.3` from the official release asset:

```text
https://github.com/anomalyco/opencode/releases/download/v1.19.3/opencode-linux-x64.tar.gz
sha256 13a8fb2978302071b86f9d7e00da9c8895f9cd846978379c3bdc6a5333536c9b
```

The workflow downloads it with `curl`, verifies the digest, requires the archive to contain exactly one root member named `opencode`, and only then extracts it. It never uses `curl | bash` or an npm wrapper.

## Input, output, and privacy

The model input is capped at approximately 120 KB. The outcome review text is capped at approximately 24 KB, raw CLI stdout is capped at 2 MB, and the model process has an 8-minute timeout inside a 15-minute job. Files beyond the input limit, patches truncated by the limit, and files GitHub reports without a patch (binary, empty, or too large) are listed explicitly in the coverage summary. The lane never claims a complete review of such a diff.

The PR title and description are not sent. Only changed-file metadata and provided patches are sent to the configured OpenCode Zen model. Reviewing a diff sends that content to the provider under OpenCode Zen's current terms and data-handling policy; this document makes no claim of zero retention. Keep secrets, customer data, and private keys out of pull-request diffs.

The model job writes only a bounded outcome containing identity, status, coverage, the final review text, and a fixed diagnostic code when needed. Raw JSONL events, stdout, stderr, sessions, and API bodies are not uploaded or published.

The prepare artifact also contains a producer-side `manifest.json` with hashes for bookkeeping. Its trust boundary is same-run artifact provenance from the base prepare job, not an independent consumer verification of those hashes.

## Output and reliability

The published comment starts with `<!-- habi-opencode-review:v1 -->` and is updated in place rather than duplicated. Review text is sanitized: unsafe controls and bidi characters are removed, mentions are escaped, and the text is rendered inside a dynamic inert code fence so HTML and image syntax cannot execute.

The publisher inspects up to 500 existing comments. If the owned marker is not found and that window is incomplete, it skips with a warning instead of creating a duplicate. Review text truncated by the model output cap or the comment-size budget is disclosed by a fixed notice outside the inert fence.

Provider quota, rate-limit, model-unavailable, and CLI timeout outcomes are informational and do not fail required CI. Malformed JSONL, missing stop/final text, tool use, identity mismatch, invalid schema, prompt corruption, and publish failures do fail this workflow. No blanket `continue-on-error` is used.

## Security boundaries and limitations

- The workflow assumes trusted repository writers. On an internal PR, the workflow file itself is part of the PR and could be modified; the base helpers and prompts are still taken from the base SHA, but a malicious workflow edit is outside the protection this lane can provide.
- The review job has no GitHub API permissions and no repository checkout. Its artifact actions use the Actions runtime token; the CLI environment is allowlisted and built from scratch, so the CLI receives no GitHub token or Actions runtime variables. Only `OPENCODE_API_KEY`, when present, is exposed to the CLI.
- The publish token is limited to `pull-requests: write`; there is no `contents` write, `id-token`, or Actions cache permission.
- Comment ownership requires the exact GitHub.com Actions bot login `github-actions[bot]`, type `Bot`, and the official id when present. A GHES installation uses a different bot identity; this lane targets GitHub.com.
- No raw audit artifact is retained by design, because raw model events and stderr can contain sensitive prompt or provider data.
- The lane is not a substitute for independent security review, tests, or human approval. It reviews only the provided diff and cannot establish behavior outside that scope.

## Local validation

The focused helper tests use only Node built-ins and stub fetch/CLI calls; they do not contact a provider or GitHub:

```bash
node --test .github/scripts/review.test.mjs
actionlint .github/workflows/opencode-review.yml
```

CI runs the same helper tests after `pnpm verify:foundation`.
