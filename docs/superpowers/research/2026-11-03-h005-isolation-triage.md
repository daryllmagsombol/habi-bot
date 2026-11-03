# H-005 — Isolation triage and harness-level probe (2026-11-03)

- **Status:** Triage complete. Declared dependencies are accepted, but **no two-user Habi deployment exists**, so the issue cannot be accepted. A minimal harness-level probe was run to establish what the pinned harness does and does not isolate. H-005 is blocked on the application layer (#21/#22), not on H-002/H-004.
- **Phase:** P0 — Security (H-005).
- **Scope:** Dependency verification, one bounded harness-level access matrix, and the resulting block. No product code, deployment, or claim of isolation.

## 1. Dependency state (verified 2026-11-03)

| Dependency | Issue | Board | Effect |
|---|---|---|---|
| H-002 object and context model | #2 CLOSED | Done | Supplies ownership vocabulary and Run/Message state |
| H-004 Hermes run lifecycle | #4 CLOSED | Done | Pins the harness and shows it holds only in-flight state |
| H-005 | #5 OPEN | Backlog → Blocked | Cannot be executed without a two-user deployment |

The dependencies are satisfied; the missing input is a running Habi application with two users, not another P0 decision.

## 2. Harness-level probe

The pinned Hermes API server was run against a local OpenAI-compatible stub (no external provider), with an isolated profile and `platform_toolsets.api_server: []`. Two synthetic runs were created under the single configured gateway key, then accessed through several paths.

| Check | Result | Interpretation |
|---|---|---|
| Create run A and run B | 202 each, distinct 128-bit IDs, both completed | Runs are addressable individually |
| Read run B with the same gateway key | **200**, full run record | **Any holder of the one key can read any run** |
| Read run B with no `Authorization` | **401**, "Invalid gateway API key" | Key required |
| Read run B with a wrong key | **401**, same message | No key bypass |
| Read run B via `/p/other-profile/v1/runs/{id}` | **404**, "Unknown or unconfigured profile" | Profile prefix is not a hidden cross-tenant path; profiles must be configured |
| `GET /v1/runs` (enumerate) | **405** | No run listing endpoint |
| Read a guessed run ID | **404**, `run_not_found` | IDs are not enumerable; unguessability is **not** authorization |

The run record's `session_id` equals its `run_id`, and transcripts persist in the shared profile state.

## 3. Conclusion

- **The harness has exactly one trust domain: the gateway key.** It has no user identity, no per-user session namespace, and no per-run owner check beyond the profile that started the run.
- Therefore Hermes **cannot** provide Habi's cross-user isolation. Habi must enforce ownership on every read, and must not pass raw harness IDs to clients as capability.
- Two remediation shapes remain, both already anticipated by H-005: (a) Habi-side authorization with one shared profile, accepting that a compromised gateway key exposes all runs, or (b) a segregated gateway/profile per user, which multiplies operational surface.
- Neither can be evaluated without a two-user deployment, because the decisive tests are the ones the harness cannot answer: API ownership predicates, queue payloads, file paths, caches, logs, and event-stream authorization.

## 4. Blocked criteria

| Criterion | Why blocked |
|---|---|
| Two-user access matrix across API, queue, event stream, storage | No Habi API, queue, or storage exists |
| Harness IDs insufficient for authorization | Proven at harness level; needs an application layer to prove Habi rejects them |
| Cross-user tests through every exposed endpoint | No endpoints exist beyond `GET /health` |
| Failure recorded as launch blocker and remediation decision | Requires the application shape to choose between shared-profile and per-user-profile designs |

## 5. Non-claims

No isolation is claimed, no failure is waived, and no P0 gate is passed. The probe used synthetic prompts and a stub provider; it did not test a real provider, encryption at rest, or multi-profile routing with a configured second profile.
