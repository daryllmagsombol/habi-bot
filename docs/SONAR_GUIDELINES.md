# SonarQube engineering guidelines for Habi

**Status:** living engineering guidance, not a SonarQube quality profile, server configuration, or gate result. Operational setup lives in [`docs/ci/sonarqube.md`](ci/sonarqube.md), [`sonar-project.properties`](../sonar-project.properties), [`tsconfig.sonar.json`](../tsconfig.sonar.json), and [`.github/workflows/sonarqube.yml`](../.github/workflows/sonarqube.yml).

No host URL, project key, server ID, token, certificate, or numeric quality-gate threshold is committed or treated as a Habi mandate. The source material below inspired the structure only; unrelated Prisma, GraphQL, Apollo, PWA, Oracle deployment, Jest, admin, offline, and content-specific rules were intentionally omitted.

Inspiration: [TransformLit AGENTS.md](https://github.com/daryllmagsombol/transformlit-webapp/blob/main/AGENTS.md) and [TransformLit SONAR-GUIDELINES.md](https://github.com/daryllmagsombol/transformlit-webapp/blob/main/docs/SONAR-GUIDELINES.md).

## Evidence and status

- The SonarQube lane is optional and self-hosted. No live analysis pass is known, and this repository does not assert that a server project exists.
- Missing `SONAR_HOST_URL`, `SONAR_PROJECT_KEY`, or `SONAR_TOKEN` skips the scan with a notice. A configured scan can pass or fail; an outage or quality-gate failure is not converted into a skip.
- Coverage is real: `pnpm coverage` runs the tests under c8 and writes a source-mapped `coverage/lcov.info`, consumed by `sonar.javascript.lcov.reportPaths`. Foundation smoke tests are not coverage by themselves; the c8 run over the workspace suites is.
- Do not copy arbitrary numeric thresholds from another product. If a server quality gate has thresholds, they are server configuration, not repository policy.
- The findings log starts empty. A hypothesis, AI suggestion, or unreproduced report is not a recorded finding.

## What this file does not enforce

- No mandatory numeric coverage threshold, 3% duplication, 100% hotspot, or arbitrary score. Coverage is reported from executed tests; the gate threshold, if any, is an explicit owner decision rather than a copied default.
- No blanket rule to rewrite every reported issue, and no quality-gate exclusion used merely to make a build pass.
- No Prisma, GraphQL, Apollo, PWA, Oracle deployment, Jest-only, admin-panel, Bible-content, offline-first, or similar source-specific rules.
- No mechanical formatting or naming mandate where the repository has no configured formatter or lint rule. Prefer the existing tools.
- No claim that local tests or lint substitute for an actual configured SonarQube analysis.

## Rule lifecycle

1. Reproduce the reported issue or invariant violation and read the evidence.
2. Make the smallest safe correction; do not suppress, exclude, or weaken a check just to pass.
3. Validate the correction with the narrowest relevant command, then the broader foundation checks when the change warrants it.
4. Record a guideline only after a human validates that the finding is real, reproducible, and generalizable.
5. Keep any justified exclusion narrow and documented with its reason. No blanket quality-gate exclusions.

AI review findings are not authority. The OpenCode review output cannot edit prompts, guidelines, workflow policy, or repository settings. Batched review is implemented; only an actual current batched run with complete manifest coverage for the reviewed SHA proves a review pass. Its contained runtime permits read/bash inside the container with all other tool permissions denied, so "read-only" is an output/repository boundary, not a strict no-tools environment; public HTTPS and DNS remain reachable, and endpoint-level restrictions are not claimed. Tool-use output is not review evidence. A human decides whether a finding changes policy.

## TypeScript and JavaScript

### Make failure explicit

Reject with a useful error rather than returning ambiguous values or swallowing failures. Preserve the original error when adding context.

```ts
try {
  await work();
} catch (error) {
  logger.error({ event: 'work.failed' }, error);
  throw error;
}
```

### Do not leave floating promises

A promise must be awaited, returned, or explicitly handled. Fire-and-forget work needs an owner, error path, and shutdown behavior.

```ts
await task.run(); // or return task.run();
```

### Bound untrusted input before use

Validate limits, identifiers, and lengths at the boundary. Prefer explicit ranges over truthy checks.

```ts
if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
  throw new RangeError('limit is outside the supported range');
}
```

### Prefer the idiomatic form these rules ask for

The repository's own Sonar analyses keep landing on the same handful of idioms. Each is a small
write-time choice; none needs a suppression, and every one was fixed the same way after the fact.
Write them correctly the first time. The **Enforced** column says whether `pnpm lint` rejects the
wrong form outright; where it says *scan*, lint cannot decide the case without disagreeing with the
real gate, so the table and the scan carry it.

| Instead of | Write | Rule | Enforced |
| --- | --- | --- | --- |
| Several `array.push(a)` calls in a row | one `array.push(a, b, c)`, or build with `map`/spread | `S7778` | scan |
| A long method with many branches | one named helper per decision, called in order | `S3776` | scan |
| A nested ternary chain | an early return, or a named lookup | `S3358` | scan |
| Callbacks nested past four levels | a named module- or hook-scope function | `S2004` | **lint** |
| `str.replace(/…/g, …)` | `str.replaceAll(…)` | `S7781` | scan |
| `rows[rows.length - 1]` | `rows.at(-1)` | `S7755` | scan |
| `x === null \|\| x.y` | `x?.y` | `S6582` | **lint** |
| `window.location`, `window.matchMedia` | `globalThis.…` in client components | `S7764` | scan |
| Two `import` statements from one module | one statement | `S3863` | **lint** |
| `?:` combined with `\| undefined` | one or the other: optional, or required-with-explicit-`undefined` | `S4782` | scan |
| A wrapper that only returns `Number(x)` | `Number(x)` at the call site | `S7770` | scan |
| `catch (caught)` | `catch (error_)` | `S7718` | scan |

`S2004`, `S3863` and `S6582` are enforced by `packages/config/eslint/base.mjs`, so a wrong form fails
`pnpm lint` before any scan runs. `S6582` runs under typed linting (`projectService`), opted into on
2026-11-10 after guidance alone proved insufficient — an optional-chain miss landed in PR #107 with
this table already on the page. The cost is that lint type-checks: about 4 s for `apps/web` and 2 s
for `apps/backend` on this repository. `S3358` is **not** lint-enforced on purpose: `no-nested-ternary` cannot tell a
value-position chain from JSX conditional rendering, so it would reject idiomatic React while the real
gate stays silent — the table's guidance is the control there.

Complexity rules (`S3776`, `S2004`) are not asking for fewer features. They are asking for the
decision to have a name. When a function is genuinely an ordered sequence of trust checks, keep the
order and extract each check — reordering changes which error wins, which is a behaviour change.

Two notes that came up repeatedly:

- Heterogeneous tuple arrays (`[method, path]` and `[method, path, body]`) make destructured values
  look like `string | object`, which then triggers stringification and comparison rules. Prefer
  named object fields (`{ method, path, body }`) when an array mixes shapes.
- A regex anchored at `^` and run per line is linear. Measure before accepting a `S5852`
  super-linear-backtracking report: the repository has both fixed a real quadratic pattern and
  reviewed a false one, and the deciding evidence was timing at doubling input sizes.

### Keep control flow readable

Prefer early returns and small functions over deeply nested conditionals. This is a maintainability guideline, not a mechanical style rule or an unavailable lint rule.

### Do not change intentional protocol strings mechanically

A literal such as `http://127.0.0.1` may be deliberate for a local loopback test or development tool. Treat protocol changes as security decisions with context, not automatic hotspot patches.

## React 19 and Next.js 16

### Respect the server/client boundary

Add `'use client'` only where hooks, browser APIs, or event handlers require it. Do not move server-only data access or secrets into client components.

```tsx
'use client'; // only when this module actually needs client behavior
```

### Keep hooks and effects honest

Effects must clean up subscriptions, timers, and requests they create. Avoid stale closures and duplicate requests. Model loading, empty, error, and success states explicitly.

### Use stable list keys

Key by a stable identity, not the array index when items can reorder.

```tsx
items.map((item) => <Row key={item.id} item={item} />)
```

### Preserve semantic accessibility

Use real headings, landmarks, labels, buttons, and focus behavior. An interactive control must remain keyboard-operable; decorative visuals stay out of the accessibility tree.

## NestJS API and worker

- The API and worker must shut down cleanly on `SIGTERM` and `SIGINT`, with bounded cleanup.
- The worker stays headless and inert in this foundation: no HTTP listener, polling loop, queue connection, or provider connection. Apply run behavior only when that feature is implemented.
- Validate request and job payloads at the boundary. Do not trust client-provided ownership, authority, or capability fields.
- When durable runs or a queue are implemented, cancellation must become terminal promptly and retries must be idempotent. These are conditional future requirements, not claims about the current worker.

```ts
try {
  await work();
} finally {
  await cleanup();
}
```

## Security and context

- Enforce ownership and cross-user/conversation isolation in the backend on every API, stream, queue, storage, and artifact path.
- Bot Markdown is untrusted guidance. It never grants tools or permissions.
- Uploads are untrusted content. Scope them to the conversation, validate type and size, and never derive capability from file contents.
- Effective capability is the intersection of user identity, the Bot allow-list, and the selected conversation context. Prompt text cannot expand it.
- Keep provider keys and backend credentials server-side; exclude secrets from client bundles, ordinary chat, logs, errors, queue payloads, and artifacts. When sessions are implemented, protect browser session cookies with appropriate HttpOnly, Secure, and SameSite settings rather than exposing their values to client JavaScript.
- A free-provider limit returns a recoverable error. Do not add silent paid-provider fallback or bypass spending policy.
- The POC excludes arbitrary shell, browser or computer use, autonomous browsing, unsafe file tools, sending messages, payments, external account actions, and unrelated MCP tools. Public-web search remains off unless explicitly enabled.
- Persistent memory, authentication, and queue-backed runs are not implemented. Apply their isolation rules when those features are built.

## Automation and review

- The Sonar workflow is configuration-gated and uses a standalone analyzer TypeScript config. It does not install dependencies or run package lifecycle scripts with `SONAR_TOKEN`.
- Current CI runs `pnpm verify:foundation`, `node --test .github/scripts/review*.test.mjs` for the review helper/security suites, and a separate `node --test scripts/ci/sonarqube.test.mjs` step. `pnpm verify:foundation` does not include those helper or Sonar suites.
- OpenCode review loads only its three trusted base prompts from `.github/review/`, taken from the immutable event base or an administrator-approved bootstrap commit rather than the PR head. These prompts are CI review input only, not product model skills. It does not load this file, `AGENTS.md`, or native skills automatically. Future rule propagation requires a separately reviewed manual prompt update. The approved mode is keyless and requires no provider secret. Batched review is implemented; only an actual current batched run with complete manifest coverage for the reviewed SHA proves a review pass. The contained runtime is not a strict no-tools environment, but its output cannot edit repository policy. The CI review container is not product capability; the POC no-shell/no-browser boundary is unchanged. Operational details and current pins live in the [OpenCode review operations doc](ci/opencode-review.md).
- A full batched review covers all available changed text in bounded, up-to-four-way-parallel batches. It is complete only when every manifest expected text segment was covered by a valid reviewed batch, the file list was complete, and there were no unreviewable patch gaps or failed, missing, or unexpected outcomes; binary, empty, or oversized patches and errors make it incomplete. It is bounded to the provided diff and does not guarantee that all bugs are found or that the whole repository was reviewed. Treat a head as fully reviewed only after an actual batched run reports complete coverage for that reviewed SHA; helper tests and planner dry runs are not that evidence.
- `pnpm typecheck` uses the application workspace configs. `tsconfig.sonar.json` is analysis-only and may have less type precision when third-party packages are not installed.

## Review checklist

- Does the change widen ownership, cross-user/conversation access, or Bot/upload capability?
- Are untrusted identifiers, sizes, paths, and payloads validated at the boundary?
- Are promises awaited or handled, errors preserved, and cleanup bounded?
- Does the UI preserve server/client boundaries, stable keys, keyboard use, and semantic accessibility?
- Are new Sonar exclusions narrow and justified, with no blanket suppression?
- Was each claimed finding reproduced, or is it still a hypothesis?

## Findings log

No validated findings have been recorded yet. Do not add hypothetical AI output, unverified source IDs, or copied thresholds here.

| Date | Source | Guideline | Evidence | Decision |
|---|---|---|---|---|
| 2026-11-09 | SonarQube PR analyses, PRs #86–#106 | Idiomatic-form table above (`S7778`, `S3776`, `S3358`, `S2004`, `S7781`, `S7755`, `S6582`, `S7764`, `S3863`, `S4782`, `S7770`, `S7718`) | ~100 findings across 12 PRs; each reproduced from a configured scan with rule key, file and line, and corrected by the documented rewrite | **Validated by owner 2026-11-09** — write-time guidance, not a new gate |
| 2026-11-10 | SonarQube PR #107 (`S6582`, `use-workspace-actions.ts`) | Enable typed linting so `prefer-optional-chain` is enforceable | The idiom was already in the table below and the miss still landed: guidance alone did not hold. Two further `S6582` cases surfaced the moment `projectService` was enabled (`artifact-panel.tsx`, `skill-form.tsx`) | **Validated by owner 2026-11-10** — policy change; lint type-checks (4 s web / 2 s backend here) |
| 2026-11-09 | SonarQube PR #103 hotspots `S5852` | Measure a backtracking report before accepting it; anchor `^`-anchored per-line patterns are linear | `0.20 / 0.40 / 0.80 ms` at 200k / 400k / 800k chars — linear; contrasted with `URL_CREDENTIALS` at `6.0 s` for 100 KB before anchoring | **Validated by owner 2026-11-09** |
