# Provider Access and Daily Allowance — Design (proposed H-001 amendment)

- **Status:** Amendment A1 **accepted by the owner on 2026-11-03** at planning fidelity, alongside acceptance of the single-user CommandCode scope. The remaining implementation safeguards stay proposed, not approved. Acceptance does **not** grant multi-user use: the shared key remains owner-only until CommandCode provides written permission, and it does not authorize implementation, deployment, paid access, or vendor contact. **P0 has not passed.**
- **Date:** 2026-10-28 (actual date; all day-boundary statements use Asia/Manila).
- **Phase:** P0 — Feasibility. Constrains H-001, H-003, H-004, H-008, and issues #16, #17, #21, #22.
- **Scope:** Planning only. Describes a proposed platform-funded default CommandCode path, an optional per-user BYO path, and a daily token allowance that applies **only** to a shared key used by anyone other than the owner. No product capability, authentication, chat, provider call, or persistence exists today.
- **Supersedes:** the earlier "proposal only" state. **Amends** the accepted [H-001 boundary](./2026-10-21-poc-boundary-and-journeys-design.md) via amendment A1 below, accepted by the owner on 2026-11-03. The no-sharing, no-resale, and no-silent-paid-fallback rules remain in force.
- **Authority:** owner instructions in the 2026-10-28 session; the accepted [H-001 boundary](./2026-10-21-poc-boundary-and-journeys-design.md); the owner-approved [H-002 object model](./2026-10-22-object-and-context-model-design.md) (local revision); the owner-accepted [H-008 auth design](./2026-10-23-auth-architecture-and-sso-design.md) (local revision); and the CommandCode evidence in §14.

## 1. Current state and non-claims

The repository is a runnable foundation only: a Next.js shell, a NestJS `GET /health` API, an inert worker, shared packages, and local PostgreSQL Compose tooling. Authentication, chat, Bots, model calls, Hermes in product, persistence, queueing, and deployment are not implemented. `apps/backend` wires only the health controller.

Nothing here claims a working allowance, an enforced cap, a provider connection, or multi-user permission. No code was written, no dependency installed, no provider called, no credential read, and no vendor contacted for this document.

## 2. Owner-approved intent (2026-10-28)

1. Habi intends a **platform-funded CommandCode default**: the owner's CommandCode account funds the default path.
2. Habi also intends an **optional per-user BYO** path, where a user connects their own supported provider access and uses it only for their own requests; exact providers and permissions remain to be established.
3. The **personal-only POC** uses the **shared key for the owner alone**, with **no token limit for now**. This is the only currently permitted operating mode.
4. **Before access by any other person**, the shared key is gated by:
   - a **per-user allowance of 100,000 input+output tokens per day** against the shared key;
   - a daily reset at **00:00 Asia/Manila**;
   - shared-key requests **stopping at the allowance**, with an offer to connect an own key;
   - **no automatic paid fallback**;
   - **unknown usage blocking further shared-key requests** until reconciled;
   - **BYO usage accounted separately** from the shared allowance.
5. The shared key **must not** serve multiple users before **written CommandCode authorization** under an appropriate plan or agreement.

These are recorded owner decisions. They are planning intent, not runtime behavior.

## 3. H-001 amendment A1 — accepted 2026-11-03

H-001 currently says, in the owner-requested BYO goal addition ([H-001 note:67-71](./2026-10-21-poc-boundary-and-journeys-design.md)):

> "…never share credentials/allowances across users, bypass restrictions, or silently fall back to paid/platform-funded access."

H-001 forbids sharing credentials or allowances across users and forbids **silent fallback** to paid/platform-funded access; it does not categorically forbid every explicitly chosen platform-funded service. A shared key for multiple users conflicts with its no-sharing boundary. This design does **not** reinterpret that clause away. It proposes the following amendment, to be accepted or rejected explicitly:

> **Amendment A1 (accepted by the owner 2026-11-03).** Habi may operate a **platform-funded CommandCode default key** for a **single-user owner POC**. Before the shared key serves any other person, it must be gated by a per-user daily token allowance, atomic pre-dispatch reservation, fail-closed unknown-usage handling, and written CommandCode authorization for multi-user use under an appropriate plan or agreement. BYO connections remain owner-isolated. Automatic paid fallback, pooled subscriptions, and resale of access remain prohibited.
>
> **Acceptance is conditional and does not enable multi-user use.** As of 2026-11-03 no written CommandCode permission exists, so the shared key stays owner-only and the allowance mechanics remain unimplemented requirements.

Until A1 is accepted and recorded by the owner (and, where applicable, on the issue), the published H-001 baseline governs. If A1 is rejected, the shared-key default path must not proceed beyond the owner-only POC.

Acceptance of A1 would amend one clause only. It would **not** accept CommandCode as an H-003 provider, close H-003, approve multi-user terms, or pass P0.

## 4. Single-user versus multi-user gate

The gate is by **identity of the person served**, not by deployment environment, invite status, or UI.

| Condition | Allowed |
|---|---|
| Owner only, owner's own CommandCode key or shared key, no allowance | **Permitted by the owner-only POC assumption** |
| Any second person on the shared key, even with allowance | **Blocked** until written CommandCode authorization, an appropriate plan/agreement, and the enforcement prerequisites in §8–§9 |
| Any second person on their own BYO key | **Blocked** until the same written-authorization question is resolved for that shape; BYO does not bypass the gate |
| Multi-user platform-funded shared key with no bounded output or no atomic reservation | **Blocked** (see §8.3); the owner-only no-limit POC is separate |

The system must **fail closed**: if the user cannot be definitively identified as the owner, or if authorization evidence is not recorded, shared-key requests are denied. There is no soft enablement, feature flag, or "trusted testers" exception in this design.

Authorizing evidence must be written, dated, and retained, and must identify the plan/agreement and the permitted use. An oral statement, support-chat paraphrase, or undocumented plan change is not sufficient. No vendor contact is authorized by this document.

## 5. Identity, authorization, and secret custody

### 5.1 Identity and authorization

- Backend identity comes from the H-008 session design: the **Nest API** validates the session, resolves the active user, and enforces ownership; the browser holds only an opaque session secret.
- The allowance bucket is keyed by **Habi user ID**, not by email, provider subject, browser, IP, or device. One Habi user has one shared-key allowance per day.
- Authorization to use the shared key is a **server-side decision**: active user, owner/shared-key eligibility record, and, when multi-user is enabled, a recorded authorization state. It is never derived from client-supplied headers, Bot Markdown, conversation content, or UI state.
- Workers never receive browser cookies or shared-key material. They receive run/job context and a scoped credential reference, and revalidate ownership per H-008 §6 and the #17 worker contract.
- Cross-user denial is non-enumerating. A user at their allowance, a user not eligible for the shared key, and a user whose usage is unreconciled should not be distinguishable by another user.

### 5.2 Secret storage

- Shared and BYO CommandCode keys are stored **server-side only**, never in the browser bundle, logs, traces, prompt text, repository, or export.
- **#21** owns inference-connection behavior (create, list, revoke, per-user BYO binding). **#17** owns shared secret-storage, rotation, and redaction mechanics. **#16** owns cross-user enforcement. **#8** supplies identity only and does not own inference credentials.
- The shared key must be **distinct** from any BYO key and must never be returned to a client. API responses expose connection metadata and status, never key material.
- A worker's credential reference must be scoped to one dispatch and must not be reusable after the run or after revocation.
- Account deletion revokes BYO connections and destroys stored key material per H-002 §16.1.
- Exact cipher, key hierarchy, table, and rotation interval are **not selected here** (#17).

## 6. Allowance model

- **Unit:** tokens, defined in §7. The allowance is **100,000 input+output tokens per user per day** against the shared key.
- **Day:** the allowance period is the calendar day in **Asia/Manila (PHT, UTC+8, no daylight saving)**. The period starts at **00:00:00 Asia/Manila**, i.e. **16:00:00 UTC on the previous calendar date**. Reset is a boundary change, not a credit event: unused tokens do not carry over, and no balance is granted proactively.
- **Scope:** one bucket per Habi user per day. Concurrent requests from the same user share it.
- **Excluded from the bucket:** BYO usage. BYO usage may still be recorded for observability and user display, but it must never consume, replenish, or offset shared allowance.
- **What it is not:** the allowance is a **token quota, not a dollar cap**. It bounds counted tokens only; it does not bound provider charges, taxes, cache pricing, or plan overage. It is not a provider entitlement and does not override CommandCode account limits.
- **Owner-only mode:** while only the owner is served, no allowance is applied. The 100,000 figure is not retroactively imposed on owner-only use.

## 7. Token accounting semantics

The allowance must count each billed token **once**. Provider-reported fields are not additive by default.

### 7.1 Definitions

| Term | Definition |
|---|---|
| Gross prompt (input) tokens | The full prompt size billed for the request, as reported by the provider, **including** any cached and cache-write portion reported within it |
| Gross completion (output) tokens | The full generated-token count billed for the request, as reported by the provider, **including** reasoning tokens when the provider reports reasoning within completion |
| Allowance units | `gross prompt tokens + gross completion tokens` for one request |

### 7.2 Non-additivity rules

- **Cached tokens require provider-specific interpretation.** Some APIs include cached tokens in their prompt total; others report cache reads or writes separately from input. Map the documented provider fields before summing, and never double-count a subset.
- **Reasoning tokens require provider-specific interpretation.** When reported as a subset of completion, do not add them on top of completion; an unknown relationship must not be guessed.
- **Hermes reconciliation is not billing authority.** The observed Hermes "canonical usage" adds cached prompt tokens, uncached input, and output (for example 617 + 256 + 24 = 897). That figure reconciles Hermes' counters; it is not proof of the provider's billed total. Habi must record the raw reported fields and apply the definitions above, not adopt a third-party sum.
- If a provider reports only an aggregate total with no breakdown, accept the aggregate as the request total and do **not** attempt to reconstruct a breakdown.
- If the reported fields are internally inconsistent (for example, cached tokens exceed prompt tokens, or components sum beyond the reported total), record **partial** or **unknown** per §7.3 rather than choosing a favorable interpretation.

### 7.3 Known, partial, unknown

| Status | Meaning | Allowance effect |
|---|---|---|
| `known` | All required totals are present and internally consistent | Charge the stated total |
| `partial` | Some components are present but the total is not reliable | Charge the largest defensible reported total; flag for review; keep the user eligible only if the reservation still bounds the worst case |
| `unknown` | No reliable usage, or dispatch outcome is ambiguous | **Never treated as zero.** Block further shared-key requests for that user until reconciled (owner action, §9.4) |

The H-002 rule already applies: terminalization records `usage_status` as known, partial, or unknown, and **unknown must never be represented as zero charges**.

## 8. Request admission, reservation, and caps

### 8.1 Admission order (shared key)

Before dispatch, the backend must, in order:

1. Resolve the authenticated user and confirm shared-key eligibility.
2. Resolve today's bucket for that user in Asia/Manila.
3. Refuse if the bucket has an unreconciled `unknown` record.
4. Compute remaining allowance from **committed usage plus outstanding reservations**.
5. Refuse if remaining is below the minimum admissible reservation.
6. Atomically reserve an upper bound for this request.
7. Dispatch at most once.
8. Finalize the reservation from reported usage, or mark it `unknown` on ambiguity.

Steps 4–6 must be one atomic operation (§9). A check-then-dispatch without reservation is not compliant.

### 8.2 Cap policy is TBD, not invented

This design does **not** choose a per-request output cap, per-request input cap, request-count cap, concurrency cap, or minimum reservation. Those are open (§12) and must be set before multi-user enablement. The current pinned Hermes evidence shows output-cap settings were not transmitted as `max_tokens`/`max_completion_tokens`/`max_output_tokens`; this design must not assume Hermes can bound output today.

### 8.3 Why 100,000 cannot yet be guaranteed

Two independent prerequisites are unmet:

- **Bounded request output.** A single request with unbounded completion can exceed 100,000 tokens. No allowance check can prevent that after dispatch. Without an enforced output bound, the stated daily quota is not a guarantee.
- **Atomic reservation.** Without a reservation that includes outstanding in-flight requests, two concurrent requests can both observe the same remaining allowance and collectively exceed it.

Therefore, until both are implemented and verified, the accurate statement is: the shared key **intends** to stop at 100,000 tokens/day, but the cap is **not enforceable by claim alone**. This document leaves the cap mechanism open rather than inventing an enforcement detail. Multi-user shared-key access remains blocked in the meantime.

## 9. Reservation and usage lifecycle

### 9.1 States

| Reservation state | Set when | Later transition |
|---|---|---|
| `reserved` | Immediately before dispatch, atomically | → `committed_known`, `committed_partial`, or `unknown` |
| `committed_known` | Provider usage is complete and consistent | Terminal |
| `committed_partial` | Usage is incomplete but a defensible total exists | Terminal for the request; may be reconciled by owner |
| `unknown` | Timeout, ambiguous outcome, missing usage, error-in-success shape, or crash before finalization | Terminal until owner reconciliation |

The reserved amount counts against the bucket while in flight. Committed amounts replace the reservation; they must not be added on top of it.

### 9.2 Atomicity

The bucket must be updated with a conditional write inside one database transaction: read the current committed total and outstanding reservations, verify the requested reservation fits, and insert the reservation, all under a lock or compare-and-set on the bucket row. PostgreSQL row locking or a conditional update on a version/`updated_at` predicate is sufficient; the exact mechanism is an implementation choice (#22).

A failed reservation means **no dispatch**. A dispatch must never occur on an uncommitted or lost reservation.

### 9.3 Dispatch and finalization

- Idempotency: a duplicate client retry with the same run idempotency key must not create a second reservation or a second provider dispatch.
- Finalization writes usage fields, the terminal status, and the reservation transition in the same atomic terminal contract described in H-002 §7.
- A stale worker (lost lease epoch) cannot finalize usage.

### 9.4 Ambiguous dispatch and unknown usage

The following are ambiguous and must be treated as `unknown`, never as zero and never auto-retried:

- request timeout or connection reset after dispatch;
- no response, or a response without usable usage;
- **HTTP 200 with `finish_reason: "error"` and/or `hermes.failed: true`** (the observed API-server shape);
- **HTTP 202 run created then polled as `failed`**;
- worker crash or lease expiry after dispatch;
- any provider error shape whose semantics are not established.

On `unknown`, the user's shared-key path blocks until an owner reconciliation records actual usage or an explicit allowance adjustment. Retrying the same ambiguous dispatch automatically is prohibited; a user-initiated new attempt is a new reservation and is refused while the block stands.

### 9.5 Allowance exhaustion

When committed usage plus reservations reaches the allowance, further shared-key requests are refused with a visible, non-blaming explanation and an offer to **connect an own key**. Refusal is a normal state, not an error to retry. The refusal must not queue, schedule, or silently resume at reset.

## 10. BYO path

- A BYO connection is owned by exactly one Habi user and is used only for that user's requests. It is not pooled, shared, lent, or used for another user's run.
- BYO usage is recorded separately and does not consume shared allowance. Conversely, shared allowance use does not reduce or restore BYO anything.
- **No automatic fallback in either direction.** A failed, exhausted, or unreconciled BYO connection must not silently switch to the shared key, and a user at shared allowance must not silently switch to BYO. The user must take an explicit action to connect or select a key.
- Removing or revoking a BYO connection deletes its stored key material and does not change shared allowance.
- BYO does not bypass the multi-user gate in §4: the hosted per-user arrangement still needs written provider permission for that shape.

## 11. Account limits and billing risk

- Provider-side account limits (rate limits, concurrency, included credits, plan windows) are **not** the Habi allowance and may bind first. Habi must surface the failure and must not auto-upgrade, auto-top-up, or enable auto-reload on a user's behalf.
- CommandCode documentation describes on-demand credits and spending outside subscription windows. Exhaustion may therefore coincide with **charges** rather than a clean stop; a token allowance does not prevent that. Actual exhaustion response and billing behavior are unobserved.
- The owner's current CommandCode settings (required ZDR, included credits only, auto-reload and top-ups off) were confirmed by the owner on 2026-10-28 and are not independently verified. Habi must not assume they persist or apply to another account.
- A failed request may still cost money. The fabricated fixtures reported zero usage; that is not proof.
- Cost status reported by Hermes as `unknown` is not evidence of zero charge.

## 12. Open issues with owners

| # | Issue | Owner |
|---|---|---|
| 1 | ~~Formal acceptance or rejection of amendment A1 and its recording on H-001~~ — **accepted 2026-11-03**; implementation and multi-user permission remain open | Owner |
| 2 | Written CommandCode authorization for any multi-user shared-key use, with plan/agreement identity | Owner / H-003 |
| 3 | Written position on hosted per-user BYO | Owner / H-003 |
| 4 | Per-request input/output cap, concurrency cap, minimum reservation, and admission policy | #22 with H-004 |
| 5 | Whether Hermes can be made to send and honor an output bound at all; if not, an enforceable alternative | H-004 / #21 |
| 6 | Reservation table shape, day-bucket keying, and atomic update mechanism | #17 / #22 |
| 7 | Raw usage field mapping per provider response shape, including the error-in-200 and 202-then-failed shapes | H-004 |
| 8 | Owner reconciliation workflow for `unknown` usage and auditable allowance adjustment | #17 / #22 |
| 9 | User-facing copy for allowance refusal, unknown-usage block, and BYO offer | #21 / web |
| 10 | Whether BYO usage is displayed to the user, and retention of that display | #21 / #19 |
| 11 | Provider-side account limit and billing-risk runbook, including spend alerts | Owner |
| 12 | Verification that the 00:00 Asia/Manila boundary is computed from a trusted server clock and stored unambiguously | #17 |

None of these is decided by this document.

## 13. Tests and dependencies (planned, none run)

Planned verification once implementation is authorized:

- Reservation atomicity under concurrency: N parallel requests cannot jointly exceed the bucket; a lost reservation never dispatches.
- Day-boundary test across 00:00 Asia/Manila, including a request reserving before and finalizing after the boundary.
- Known/partial/unknown classification fixtures, including HTTP 200 error-in-success, timeout, missing usage, and inconsistent components.
- Unknown-usage block: further shared requests are refused until reconciliation; no auto-retry and no auto-reset at midnight.
- No-double-count tests: cached prompt subset and reasoning subset counted once; Hermes canonical sum not adopted.
- No-fallback tests: BYO failure never dispatches shared; allowance refusal never dispatches BYO.
- Owner-only mode: no allowance applied, no multi-user path reachable.
- Fail-closed test: unidentified or unauthorized user is denied shared access.
- Secret tests: no key material in responses, logs, traces, exports, or client bundles.
- Idempotency: duplicate submits produce one reservation and one dispatch.

Dependencies: H-002 usage fields, H-004 adapter contract and error classification, H-008 session/identity, H-016 ownership, H-017 secret lifecycle, H-021 inference connections, H-022 duplicate/crash handling. No P0 criterion is met by this plan, and no test above has been executed.

## 14. Original terms reference

The [CommandCode terms](https://commandcode.ai/terms), checked 2026-10-28, grant a **personal, non-sublicensable, non-transferable** license for the account holder's internal business or personal purposes, and restrict **time sharing, service bureau purposes, or use for the benefit of a third party**. Whether a platform-funded key serving other users, or a hosted app holding a user's own key, falls within those restrictions is **unresolved**. Neither permission nor prohibition is established. Team plans and pooled seats must not be presumed to cover external users.

The [Provider API](https://commandcode.ai/docs/provider) and [headless](https://commandcode.ai/docs/headless) documentation support the technical mechanism only. [Pricing and limits](https://commandcode.ai/docs/resources/pricing-limits) and [ZDR](https://commandcode.ai/docs/resources/zdr) were checked on the same date for billing and retention context, not as permission.

No vendor contact was made or is authorized. If the owner later seeks a reply, retain it verbatim with date, plan, and redacted account details.

Supporting observations: [CommandCode per-user BYO assessment](../research/2026-10-28-commandcode-byo-assessment.md), [personal CommandCode with pinned Hermes](../research/2026-10-28-personal-commandcode-hermes.md), and the [H-003 decision note](../research/2026-10-28-h003-provider-decision.md). These record observed evidence and open questions, not provider acceptance.

## 15. Acceptance status

- **Approved direction (2026-10-28):** platform-funded default plus optional BYO; no token limit while only the owner uses it; 100,000 input-plus-output tokens per user per day before others gain access; reset at 00:00 Asia/Manila; stop at the limit and offer BYO; and block shared-key requests on unknown usage until reconciled. Multi-user use requires written CommandCode permission. These are planning decisions, not implementation approval.
- **Amendment A1 accepted (2026-11-03):** the owner accepted amendment A1 at planning fidelity together with the [single-user CommandCode scope](../research/2026-11-03-h003-commandcode-scope-acceptance.md). Multi-user use remains disabled; no written CommandCode permission exists.
- **Proposed safeguards:** identity and secret boundaries, reservation mechanics, detailed token-field mappings, partial-usage handling and the exact amendment text require further review; they were not individually approved merely by approving the direction above.
- **Not approved:** any numeric request cap, schema, cipher, column, API shape, UI copy, implementation, deployment, paid access, vendor contact, or specific enforcement mechanism. Open items in §12 remain open.
- **Not established:** CommandCode multi-user permission, CommandCode provider acceptance under H-003, H-004 compatibility, runtime security, or any P0 gate.
- This document does not amend H-001 by itself; the published H-001 text governs until the owner formally accepts and records A1.
