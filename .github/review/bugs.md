# Correctness review lens — Habi

Apply only to changed behavior with concrete diff evidence. Do not assume chat, auth, durable runs, or provider execution already exist; review what this diff actually implements.

## Web — Next.js and React

- Server/client boundary errors: misplaced `use client`, server-only imports in client code, non-serializable props, and hydration mismatches.
- State and effect defects: stale closures, missing cleanup, duplicate requests, race conditions, and incorrect loading/error/empty/suspense handling.
- Streaming and mobile recovery: reconnect after SSE/stream disconnect, resume from the last acknowledged position, duplicate delivery, ordering, bounded buffering, and cleanup.
- Pagination: stable cursors, no skipped or duplicated rows, consistent ordering, and correct end-of-list behavior.
- Auth/session/cookie handling only when this diff introduces or changes it; do not invent an existing auth flow.
- Accessibility or interaction regressions only where the changed behavior becomes unusable.

## Contracts and workspace

- Changes to `@habi/contracts` or typed API shapes must remain compatible with every consumer; flag mismatched request/response assumptions.
- Turbo and pnpm: build dependency order, workspace protocol, required build outputs, `dev` ordering, and `packageManager` consistency. Do not request lockfile churn as a style preference.
- Next, Nest, or Node configuration changes must not break build, typecheck, lint, or the forced verification path.

## API, worker, and runs

- Nest API and headless worker lifecycle: startup/shutdown, `SIGTERM`/`SIGINT`, no stray HTTP listener, and no provider connection in the worker.
- Cancellation and retry: a cancelled run stops promptly and stays terminal; retries are idempotent and do not duplicate side effects.
- Durable events and ordering: queue payloads carry the expected identity and idempotency data; replay or redelivery does not corrupt state or cross conversations.
- SSE behavior: per-user stream isolation, heartbeat/timeout handling, replay from a known position, and no unbounded replay buffer.
- Errors remain recoverable, preserve data, and avoid silent fallback or swallowed rejections.
- Auth and cookie defects only when relevant to changed behavior and only if introduced or worsened by this diff.

## Evidence

- Do not invent test results or claim a check ran. Flag only concrete gaps where changed behavior is unverified and the risk is real.
- Do not require new coverage for untouched code.
- Report only high-confidence defects on changed lines with a specific reproduction path or invariant violation.
