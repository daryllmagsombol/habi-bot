# P0 spike — two-user ownership and tool-denial results (2026-11-03)

- **Status:** Bounded owner-authorized spike executed. Server-side ownership denial and tool-policy refusal are demonstrated at the application layer. H-005 and H-006 are **not accepted**: the spike uses fixture tokens, an in-memory store, and no real harness/queue/event-stream wiring.
- **Phase:** P0 — Security feasibility (H-005, H-006).
- **Authority:** Owner chose a bounded two-user auth + ownership slice on 2026-11-03, explicitly limited to running the isolation and tool-policy tests and stopping before P1 feature work.

## 1. What was built

| Item | Detail |
|---|---|
| Gate | `HABI_SPIKE_MODE=1`. When unset, `AppModule` never imports the spike module and the routes do not exist. |
| Auth | Fixture bearer tokens: `spike-token-a` → `user-a`, `spike-token-b` → `user-b`. Missing, malformed, or unknown → 401 `{error:{code:"unauthenticated"}}`. |
| Store | In-memory `Map` keyed by Habi `run_<uuid>`; each record holds owner, conversation, a **separate** fake `harnessRunId`, status, and events. No persistence. |
| Routes | `POST /spike/runs`, `GET /spike/runs`, `GET /spike/runs/:id`, `GET /spike/runs/:id/events`, `GET /spike/runs/:id/audit`, `POST /spike/runs/:id/tools/:toolName`. |
| Denial shape | Cross-user and unknown ids return the **same 404** `{error:{code:"not_found"}}` — no existence disclosure. Tool attempts by the owner return **403** `{error:{code:"policy_denied", tool}}`. |
| Harness ids | A `harness_…` value in `:runId` returns 404 on every route; only Habi run ids are keys. |

No chat, Bot, conversation, queue, database, upload, provider call, or real authentication was added. No new dependency.

## 2. Test matrix (10 tests, all passing)

| # | Check | Expected | Result |
|---|---|---|---|
| 1 | No token / malformed / unknown token | 401 `unauthenticated` | pass |
| 2 | A creates a run | 201, own view without `ownerUserId`/`harnessRunId` | pass |
| 3 | A reads own run | 200 | pass |
| 4 | A lists runs | contains A's run only | pass |
| 5 | B reads A's run | 404 `not_found` | pass |
| 6 | B reads A's events / audit | 404 | pass |
| 7 | B lists runs | excludes A's run | pass |
| 8 | `harnessRunId` used as `:runId` | 404 on read/events/audit/tool | pass |
| 9 | Spoofed `x-user-id` / `x-spike-user-id` headers | no access, list still filtered | pass |
| 10 | Owner tool attempt | 403 `policy_denied`; audit gains `policy.denied`; B cannot read it | pass |
| 11 | B tool attempt on A's run | 404, A's audit unchanged | pass |
| 12 | `HABI_SPIKE_MODE` unset | every spike route 404, `/health` still ok | pass |

Verification: `pnpm --filter @habi/backend build`, `typecheck`, `lint` clean; `node --test --test-concurrency=1 apps/backend/test/spike-isolation.smoke.mjs` → **pass 10, fail 0**; `pnpm --filter @habi/backend test` → pass 17, fail 0 (existing health/worker suites unchanged).

## 3. What this establishes

- **H-005 mechanism:** an application layer can enforce owner-only access on every run-bearing route, deny by default with a non-enumerating 404, ignore client-supplied identity headers, and treat harness ids as opaque data rather than authorization.
- **H-006 mechanism:** a tool request is refused server-side with a stable error code and an audit record, before any capability is granted, and a non-owner cannot even reach the policy path.
- **Gate hygiene:** with the flag unset, the spike surface is absent, so this does not become a latent production endpoint.

## 4. What this does not establish

- **Fixture tokens are not authentication.** No password, session, cookie, rotation, revocation, or SSO. H-008 remains the authority.
- **No persistence.** The store is in-memory; restart, concurrency, and cross-process isolation are untested.
- **No real harness wiring.** The fake `harnessRunId` never left the process; the real single-trust-domain behaviour recorded in the H-005 triage still applies.
- **No queue, event stream, files, caches, logs, or artifacts.** The H-005 criterion "API, queue, event stream, storage" is only partially represented.
- **No Bot Markdown, upload, filename, or document-text injection.** The H-006 injection corpus is still the harness-only matrix from the earlier evidence note.
- **No rate limiting, abuse controls, or audit durability.**

## 5. Remaining decisions

1. Accept H-005/H-006 at **spike fidelity** (mechanism proven, deployment proof deferred to #25), or keep them open for the P1 shape.
2. If kept open, the spike code is disposable. It is gated and must not be extended into product authentication piecemeal.
3. The real deployment still needs the H-005 remediation decision: shared profile with Habi authorization, or segregated profile per user.

## 6. Non-claims

No production readiness, no real isolation guarantee, no authentication quality, no persistence or concurrency result, and no passed P0 gate. The spike exists only to answer whether the application-layer checks can be built and observed.
