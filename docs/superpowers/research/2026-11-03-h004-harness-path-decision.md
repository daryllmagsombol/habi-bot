# H-004 — Harness path decision (Hermes vs direct calls)

- **Status:** Recommendation at planning fidelity, 2026-11-03. The owner has not accepted it; H-004 remains open. It is based on the bounded single-user spike in [the lifecycle evidence](./2026-11-03-h004-hermes-spike-attempt.md), not on multi-user, tool-policy, or production evidence.
- **Question:** does Hermes remain the P1 harness path, or should Habi use a direct provider adapter?
- **Scope:** one decision and its conditions. No implementation, deployment, or provider-contract claim.

## 1. Decision

**Hermes remains the P1 harness candidate, behind the adapter contract, on the conditions in §3.** Habi must own the durable truth for runs, transcripts, status, and usage; the harness is treated as an in-flight executor that can lose work.

This is not an unqualified endorsement. The spike found two behaviours that would be unacceptable if Habi trusted the harness:

1. **Steering is acknowledged but not applied**, so it cannot be a product control.
2. **An in-flight run is lost across an unclean restart** (`404 run_not_found`), so recovery cannot depend on harness persistence.

Both are survivable only because the H-002 design already makes Habi authoritative for run state and requires `lost` / `execution_uncertain` outcomes with no automatic retry.

## 2. Evidence summary

| Behaviour | Observation | Effect on decision |
|---|---|---|
| Run creation | `POST /v1/runs` → 202 with `run_id` | Supports keeping Hermes |
| Idempotent create | Duplicate `Idempotency-Key` → same run, `Idempotency-Replayed: true`, replay survives restart | Supports keeping Hermes |
| Event stream | Ordered `seq` 0–2 with terminal `run.completed` last | Supports, with Habi-side dedupe |
| Cancellation | `stopping` → `cancelled`; terminal state visible after restart | Supports, with usage `unknown` |
| Usage | `input_tokens`, `output_tokens`, `total_tokens`, cached counters; `null` on cancellation | Supports, with allowance reconciliation |
| Steering | `200 accepted: true`, output unchanged, `pending_steer` retained | **Constraint:** unsupported control |
| In-flight restart | `404 run_not_found` after SIGKILL | **Constraint:** Habi-owned recovery only |
| Error shaping | HTTP 200 + `finish_reason: error` on the chat route; 202-then-`failed` on runs | Supports, with strict classification |
| Output cap | No user-facing cap reaches the provider (earlier finding) | **Constraint:** no bounded request guarantee |

## 3. Conditions for keeping Hermes

1. **Habi is authoritative.** Run status, transcript, terminal outcome, and usage status live in Habi; the harness mapping row is the only harness-owned data.
2. **Lost-run reconciliation.** Every non-terminal run after a restart is reconciled to confirmed terminal, still running, or `lost`; `lost` becomes `execution_uncertain` with **no automatic retry**.
3. **Steering is not exposed** as a working control until a configuration demonstrates an applied steer.
4. **Cancellation billing is unknown.** A cancelled run reports no usage; the allowance must treat that as `unknown` and block further shared-key use until reconciled.
5. **Failure classification is mandatory.** HTTP 200 with an error finish, and 202-then-`failed`, are failures; no silent retry or fallback.
6. **No tool capability is assumed.** H-006 must prove the runtime configuration, not the prompt.
7. **Single key, single user.** No multi-user dispatch until H-005 isolation and written provider permission exist.

## 4. Reversal triggers

Switch to a direct-call adapter (same contract) if any of these hold:

- **H-005** shows cross-user leakage through harness sessions, memory, files, or gateway credentials.
- **H-006** cannot prove a backend-enforced no-tool policy in the deployed shape.
- Steering becomes a required product capability before Hermes supports it.
- Cancellation billing or per-run usage cannot be reconciled to the allowance.
- A harness upgrade breaks the pinned contract or the version cannot be pinned reproducibly.

The adapter contract is deliberately small enough that this swap is an adapter change, not a product rewrite.

## 5. Consequences

- **H-005** stays the next gate: it needs a running two-user deployment, which does not exist.
- **H-006** needs the deployed runtime to prove no-tool enforcement.
- **#21** should implement the adapter against this contract, with Hermes as the first implementation and a direct-call implementation as the fallback.
- **H-004** closes only when this recommendation is accepted or rejected and the outstanding rows (steering permission expansion, retry safety) are recorded as accepted risk.

## 6. Non-claims

No claim of production readiness, vendor endorsement, multi-user permission, billing behavior, or a passed P0 gate. No provider call was made to write this note.
