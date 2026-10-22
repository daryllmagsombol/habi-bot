# POC Security Requirements Checklist — AI Planning Review

> **2026-10-22 update:** the owner [accepted the AI-assisted planning-boundary review](https://github.com/daryllmagsombol/habi-bot/issues/1#issuecomment-6341720556). The pending-acceptance statements below describe the original 2026-10-21 review, not the current owner decision. This is not independent human security certification or runtime verification. H-001 closure also requires these documentation-link corrections to be merged and recorded; P0 has not passed.

- **Status:** AI planning review only. **Not security signoff, not independent review, and not implementation verification.**
- **Date:** 2026-10-21
- **Scope:** H-001's narrow security acceptance criterion and the requirements it hands to downstream issues, principally [H-006 / issue #6](https://github.com/daryllmagsombol/habi-bot/issues/6).
- **Gate state:** H-001's product baseline is approved (owner, 2026-10-21, in session), but **no security acceptance is recorded**. H-001 remains open. P0 has not passed. #6 is **Backlog** and depends on H-001 and H-004; neither dependency is accepted.
- **Boundary:** This note does not edit the H-001 baseline, repository policy, or issue text. Hermes source behavior and isolation evidence belong to the #4/#5 lanes and are not re-derived here.

## 1. Sources

| Source | Use |
|---|---|
| [Issue #1](https://github.com/daryllmagsombol/habi-bot/issues/1) | H-001 acceptance criteria and non-goals; narrow security-review requirement |
| [Product approval update](https://github.com/daryllmagsombol/habi-bot/issues/1#issuecomment-6313626362) | Product approval only; security explicitly not covered |
| [Published baseline comment](https://github.com/daryllmagsombol/habi-bot/issues/1#issuecomment-6313596610) | Approved journeys and boundary wording |
| [H-001 design note:3-9](../specs/2026-10-21-poc-boundary-and-journeys-design.md) | Status and gate state |
| [H-001 design note:16-24](../specs/2026-10-21-poc-boundary-and-journeys-design.md) | Boundary principles |
| [H-001 design note:26-38](../specs/2026-10-21-poc-boundary-and-journeys-design.md) | Journey behavior and recovery |
| [H-001 design note:40-53](../specs/2026-10-21-poc-boundary-and-journeys-design.md) | Phase gates and traceability |
| [H-001 design note:67-79](../specs/2026-10-21-poc-boundary-and-journeys-design.md) | BYO-provider goal and acceptance status |
| [README.md:124-156](https://github.com/daryllmagsombol/habi-bot/blob/e47dedb3612e9c46ee4ed7db7e31639f20114a1c/README.md#L124-L156) | Journey, POC scope, exclusions |
| [README.md:158-172](https://github.com/daryllmagsombol/habi-bot/blob/e47dedb3612e9c46ee4ed7db7e31639f20114a1c/README.md#L158-L172) | Repository-wide security/context rules |
| [AGENTS.md:42-43](https://github.com/daryllmagsombol/habi-bot/blob/main/AGENTS.md#L42-L43) | Project security guardrails |
| [Issue #6](https://github.com/daryllmagsombol/habi-bot/issues/6) | No-tool policy acceptance criteria |
| [Project #1 README](https://github.com/users/daryllmagsombol/projects/1) | Phase-gate policy |

## 2. What H-001 actually gates

Issue #1 requires: "The non-goals and SSO-identity-only rule are unambiguous and **reviewed with security**." That is the security gate. It does **not** require H-001 to design enforcement, audit, idempotency, provider terms, uploads, sessions, or schema; #1 explicitly forbids UI, vendor, and limit design.

Issue #1's own acceptance criteria are otherwise product-level: journeys complete, non-goals unambiguous, conversation isolation and memory stated as product rules, gates explicit, decisions open, no feature claimed.

**Therefore:**

- **A. True H-001 gate:** a recorded security acceptance of the non-goals and SSO-identity-only rule. It is absent.
- **B. Downstream obligations:** execution-layer enforcement, audit events, retry/idempotency contracts, provider data terms, upload handling, session mechanics, and object fields are owned by #6, #2, #3, #8, #20/#22, and #26/#27. They are tracked there, not defects in H-001.

No particular reviewer role, human process, or artifact format is mandated by the issue. The owner decides who reviews and how acceptance is recorded. This AI checklist is evidence input, not acceptance.

## 3. Requirement checklist (baseline vs downstream)

Status: **Baseline** = stated in the approved H-001 baseline; **Repo principle** = stated in repository-wide guidance but not necessarily in the H-001 baseline; **Downstream** = owned by another issue. No item is verified.

| # | Requirement | Source | Where it sits | Owner of proof |
|---|---|---|---|---|
| R1 | SSO proves identity only; no mail/calendar/file access | README.md:134; H-001 note:21 | **Baseline** | H-001 security review (identity-only); #8/#15 scopes |
| R1b | Linking requires authenticated action; no silent merge; Facebook may omit email | README.md:168; H-001 note:33 | **Baseline (partial)** — journey says "never silently merge"; explicit linking flow is not specified | #8 |
| R2 | Owner/conversation isolation by default, including same-Bot conversations | README.md:162-164; AGENTS.md:42; H-001 note:22-24 | **Baseline** | #5 evidence; #16 enforcement |
| R3 | Bot Markdown is untrusted and never grants capability | README.md:165; H-001 note:23 | **Baseline** | #6 test; #16 enforcement |
| R4 | Uploads are untrusted; scoped, validated, controlled, never tool-granting | README.md:167 | **Repo principle** — not in H-001 journeys (P2 feature) | #6 test; #26/#27 design |
| R5 | Effective capability = user × Bot allow-list × conversation | README.md:165; AGENTS.md:42; H-001 note:23 | **Baseline** | #6 matrix; #2 representation |
| R6 | Memory recall only after explicit opt-in; no silent recall | README.md:164; H-001 note:22 | **Baseline** | #2/#30 audit fields; #5 isolation evidence |
| R7 | Default-deny tools: no shell, arbitrary web, browser, unsafe file, unrelated MCP; server-side enforcement | README.md:154,172; H-001 note:23-24 | **Baseline (capability rule)** — enforcement mechanics downstream | #6 execution-layer proof |
| R8 | Prompt-injection tests across user text, Markdown, filenames, extracted text, alternate paths | Issue #6 | **Downstream** | #6 |
| R9 | Retries/replays do not duplicate sends; reconnect/replay consistent; terminal cancellation/timeout | H-001 note:36; README.md:166 | **Baseline (behavior)** — contract downstream; no replay window mandated | #2/#20/#22 |
| R10 | Provider quota error recoverable; no silent paid fallback; no secrets client-side | README.md:169-170; H-001 note:36 | **Baseline (behavior)** — provider terms downstream | #3 for terms; #17 for secrets |
| R11 | Session: server-controlled, rotation, revocation, CSRF, safe redirects | README.md:162; H-001 note:33-34 | **Baseline (invariant)** — mechanics downstream | #8/#17 |
| R12 | Blocked/denied actions produce a safe audit event | Issue #6 | **Downstream** | #6 |
| R13 | Emergency tool-disable path documented and verified | Issue #6 | **Downstream** | #6 |
| R14 | Hermes stays private; sessions/memory isolated before multi-user exposure | README.md:171 | **Gate dependency** | #4/#5; not analyzed here |

## 4. H-001 gate status and downstream obligations

### 4.1 True H-001 gate

| Item | Status | Note |
|---|---|---|
| Product baseline approved (journeys, boundary, gates, decisions left open) | **Recorded** | Owner, 2026-10-21, comment 6313626362 |
| Non-goals unambiguous | **Met by baseline** | Published comment / design note |
| SSO identity-only unambiguous | **Met by baseline** | README.md:134; H-001 note:21 |
| Security review of non-goals + SSO identity-only recorded | **Not met** | No acceptance record |
| H-001 closure | **Open** | Security acceptance absent; P0 not passed |

The missing H-001 security item is recorded acceptance of the boundary review; the issue does not prescribe a particular reviewer role. Separately, the decision note is a documentation artifact; its existence or publication does not by itself satisfy the H-001 security acceptance. This review does not authorize closure.

### 4.2 Downstream obligations (not H-001 defects)

| Obligation | Owner | Why it is not an H-001 gate |
|---|---|---|
| Execution-layer no-tool proof, fail-closed behavior, audit events, injection corpus, emergency disable | #6 | H-001 states the capability rule; #6 owns proof. H-001 does not need the enforcement design |
| Send/run idempotency and replay contract | #2 (fields), #20/#22 (stream/run) | H-001 states behavior ("retries must not duplicate sends"); contract is downstream. No numeric window is mandated |
| Provider retention/training/residency terms | #3 | H-001 does not choose a provider or its terms |
| Upload validation and controlled processing | #26/#27 (design); #6 (injection test) | P2 feature; only a repository principle applies now |
| Session store, cookie attributes, CSRF mechanics | #8/#17 | H-001 states session validity and isolation invariants only |
| Entity ownership fields, Run states, memory audit fields | #2 | Object model is a separate P0 gate |
| Hermes lifecycle and cross-user isolation | #4/#5 | Separate P0 gates; explicitly out of this lane |
| Numeric abuse limits | #8 / open decision | No number is invented or required by H-001 |

**Source clarification:** linking and uploads appear in repository-wide guidance (`README.md:167-168`), but H-001's baseline only states "never silently merge identities" and omits upload journeys. They must not be treated as H-001 acceptance criteria.

## 5. Evidence matrix

### H-001

| Criterion | Status | Evidence |
|---|---|---|
| Non-goals unambiguous | **Met** | Published baseline |
| SSO identity-only unambiguous | **Met** | README.md:134; H-001 note:21 |
| Reviewed with security | **Not met** | Owner-accepted evidence that the review occurred; this checklist can be input, not acceptance |

### H-006 (downstream; included for traceability)

| Criterion | Status | Evidence |
|---|---|---|
| Default deny with explicit allow-list | **Not met** | Runtime configuration |
| Shell/web/browser/unsafe file/MCP cannot execute | **Not met** | Execution-layer config and attempted-use results |
| Bot instructions and uploads cannot change policy | **Not met** | Malicious Markdown and upload injection results |
| Prompt-injection corpus (direct/indirect/file-borne) | **Not met** | Corpus and observed outcomes |
| Alternate execution paths closed | **Not met** | Alias/URL/queue/callback/traversal tests |
| Blocked attempt logged safely | **Not met** | Audit sample without secrets/prompts |
| Public-web decision remains off | **Partially specified** | Config proof; open decision 5 |
| Emergency disable documented and verified | **Not met** | Procedure and post-disable test |

## 6. Bounded future test plan (downstream evidence)

No test was executed; no environment exists. Fixtures are test-design counts, not product limits. No replay window or rate threshold is prescribed.

| Test | Requirement | Expected evidence |
|---|---|---|
| Two-user guessed-ID matrix across API, stream, queue, storage | R2 | Every cross-owner operation denied |
| Malicious Bot Markdown claiming permission | R3, R5, R7 | Capability unchanged; tool use denied |
| Injection via user text, filename, extracted text | R4, R8 | No policy change; blocked attempt visible |
| Disabled tool invocation (direct and alternate path) | R7, R8, R13 | Fail-closed error; audit event; disable verified |
| Replay same send/enqueue and reconnect mid-run | R9 | One send; deterministic replay; terminal state |
| SSO callback with altered state/redirect | R1, R11 | Rejected; safe destination only |
| Session rotation/revocation replay | R11 | Old session rejected; policy-consistent logout |
| Provider exhaustion (mocked) | R10 | Recoverable error; no paid provider call |
| Secret scan of client bundle and logs | R10 | No provider secret or prompt content |

## 7. Conclusion

- This is a **planning checklist**, not security acceptance. No code was inspected and no test was run.
- H-001's product baseline is approved. Its **only** unmet security gate is a recorded security acceptance of the non-goals and SSO-identity-only rule.
- Enforcement, audit, idempotency, provider terms, uploads, sessions, and object fields are downstream obligations with named owners. They are not H-001 acceptance defects.
- #6 cannot proceed until H-001 security acceptance and H-004 are resolved; its own criteria require runtime evidence that does not exist.
- No policy, baseline, or issue text is changed by this note.

## 8. Citation index

- https://github.com/daryllmagsombol/habi-bot/issues/1
- https://github.com/daryllmagsombol/habi-bot/issues/1#issuecomment-6313596610
- https://github.com/daryllmagsombol/habi-bot/issues/1#issuecomment-6313626362
- https://github.com/daryllmagsombol/habi-bot/issues/6
- https://github.com/daryllmagsombol/habi-bot/blob/e47dedb3612e9c46ee4ed7db7e31639f20114a1c/README.md#L124-L156
- https://github.com/daryllmagsombol/habi-bot/blob/e47dedb3612e9c46ee4ed7db7e31639f20114a1c/README.md#L158-L172
- https://github.com/daryllmagsombol/habi-bot/blob/main/AGENTS.md#L42-L43
- ../specs/2026-10-21-poc-boundary-and-journeys-design.md
- https://github.com/users/daryllmagsombol/projects/1
