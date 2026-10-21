# Object Model and Auth Constraints — Preliminary Research

- **Status:** Preliminary research only. No object model, schema, auth architecture, or provider registration is selected or implemented.
- **Date:** 2026-10-21
- **Scope:** H-002 (object/context model) and H-008 (auth architecture and SSO constraints).
- **Gate state:** H-001's product baseline was approved by the owner on 2026-10-21 in session, but security acceptance is **not** performed and H-001 remains open. P0 has not passed. H-002 depends on H-001; H-008 depends on H-002; both remain **Backlog** and unmet.
- **Repository state:** runnable foundation only. No persistence, schema, ORM, auth, session, chat, Bot, or model code exists.

## 1. Sources

| Source | Use |
|---|---|
| [Issue #2 — H-002](https://github.com/daryllmagsombol/habi-bot/issues/2) | Object-model outcome, checklist, acceptance, non-goals |
| [Issue #8 — H-008](https://github.com/daryllmagsombol/habi-bot/issues/8) | Auth outcome, checklist, acceptance, non-goals |
| [README.md:152-166](https://github.com/daryllmagsombol/habi-bot/blob/main/README.md#L152-L166) | Approved security/context boundaries |
| [README.md:178-187](https://github.com/daryllmagsombol/habi-bot/blob/main/README.md#L178-L187) | Planned storage/runtime ownership |
| [README.md:293-303](https://github.com/daryllmagsombol/habi-bot/blob/main/README.md#L293-L303) | Open P0 decisions, including registration mode and deployment prerequisites |
| [H-001 design note](../specs/2026-10-21-poc-boundary-and-journeys-design.md) | Approved product baseline and unresolved decisions |
| [Project #1 README](https://github.com/users/daryllmagsombol/projects/1) | Phase-gate and status policy |
| Google OpenID Connect docs, retrieved 2026-10-21: https://developers.google.com/identity/openid-connect/openid-connect | Google authentication scopes and email-claim behavior |
| Microsoft identity platform OIDC scopes, retrieved 2026-10-21: https://learn.microsoft.com/en-us/entra/identity-platform/scopes-oidc | Microsoft scopes and missing-email behavior |
| Meta permissions reference, retrieved 2026-10-21: https://developers.facebook.com/documentation/development/permissions | Facebook `email` permission |
| `packages/contracts/src/index.ts:1-8` | Only existing shared contract |
| `apps/backend/src/health/health.controller.ts:1-10` | Only existing API endpoint |

## 2. Existing evidence in the repository

- The only shared contract is `HealthResponse`; it is type-only and defines no user, Bot, conversation, run, or memory vocabulary (`packages/contracts/src/index.ts:1-8`).
- The only API behavior is `GET /health` returning `{ status: 'ok', service: 'api' }` (`apps/backend/src/health/health.controller.ts:1-10`).
- There is no schema, migration, entity, ORM, queue, session, cookie, CSRF, OAuth, or provider code. Searches for those terms return no application matches.
- The README states that authentication, users, workspaces, Bots, conversations, messages, memory, attachments, artifacts, persistence, queues, and deployment are not implemented (`README.md:7-9`, `README.md:34-41`).
- The foundation design deliberately excluded application Docker contexts and a schema, so H-009 evidence does not cover this work (`docs/superpowers/specs/2026-10-19-initial-foundation-design.md:183`).

**Conclusion:** H-002 and H-008 have no implementation evidence. Everything below is a constraint analysis, not a design artifact and not acceptance evidence.

## 3. H-002 — required ownership, context, and lifecycle constraints

These are **derived requirements** from issue #2 and the approved security boundary, not a schema. Names are the issue's vocabulary; no speculative entity is added.

### 3.1 Entity ownership matrix

| Entity | Authorization anchor (owner) | Parent / scope | Default visibility | Lifecycle concerns to define | Deletion path to define |
|---|---|---|---|---|---|
| User | The user identity itself | None | Self only | Account states, disable/delete, export | Required by #32; exact tombstone vs purge unresolved |
| Bot | Owning user | User | Owner only | Creation, edit, selection, deletion; capability must not survive deletion | Owner-initiated delete; effect on conversations unresolved |
| Conversation | Owning user | User + Bot | Owner only; isolated even under the same Bot | Active/ended/cancelled states not defined; deletion behavior | Must remove or tombstone messages/runs consistently |
| Message | Owner via conversation | Conversation | Owner only | Ordering and pagination must not rely on wall-clock time alone | Cascade or tombstone with conversation/run |
| Run | Owner + conversation | Conversation | Owner only | Terminal outcomes: success, failure, cancellation, timeout, retry, restart reconciliation | Retention and deletion tied to conversation policy |
| Skill | Not specified by issue | Version chain | Owner only if user-created (proposal, unconfirmed) | Versioning and activation; P2 scope | Version retention and delete semantics unresolved |
| Memory | Owning user | User + per-Bot selection | Owner only; recall only after explicit opt-in | User-accepted fact lifecycle, inspect/delete audit | Must support inspection and deletion |
| Attachment | Owning user + conversation | Conversation | Owner only | Retention, quota metadata, validation state | Download authorization and deletion required |
| Artifact | Owning user + conversation | Conversation (and producing run) | Owner only | Generation state, retention, download authorization | Delete with conversation or explicit action |
| Routine | Owning user | User + Bot | Owner only | Schedule state; P3 only, not POC | Not in POC scope; deletion behavior deferred |

**Unresolved by the issue and not decided here:** whether a "workspace" is a first-class entity at all. Issue #2 explicitly forbids "a generic 'workspace' abstraction that silently weakens isolation", and H-001's note calls the workspace a personal scope, not a shared container. No workspace table should be added without a separate justified decision.

### 3.2 Required authorization predicates

For every entity above, the model must express:

1. **Owner predicate** — the authenticated user must equal the entity's owner (directly or through its parent chain).
2. **Conversation scope** — messages, runs, attachments, artifacts, and memory selection must be reachable only through an owned conversation.
3. **Bot capability predicate** — effective capability is the intersection of user identity, Bot allow-list, and selected conversation context (`README.md:152-166`).
4. **Default deny** — absence of a matching predicate denies; a guessed identifier is insufficient.
5. **No ID-as-authorization** — opaque or unguessable identifiers are not an authorization mechanism; they must still be checked against the owner (`README.md:156-166`).

**Open:** the response shape for a denied cross-owner request (explicit 403 vs non-enumerating 404) is not decided. H-005 must test the chosen behavior; H-002 must state it.

### 3.3 Run contract (required fields)

From issue #2 and `README.md:160`, every queued run must carry:

| Field | Purpose | Open question |
|---|---|---|
| Owner | Authorization anchor | None |
| Conversation | Scope and history association | None |
| Idempotency key | Prevent duplicate enqueue/execution on retry | Uniqueness scope (per conversation vs global) undecided |
| Status | Current lifecycle position | Exact state machine not yet defined |
| Timestamp | Ordering/audit | Whether separate created/started/finished timestamps required |
| Usage budget | Spending/limit enforcement | Units and who sets them unresolved |
| Terminal outcome | Success/failure/cancel/timeout | Representation and retention undecided |

The state model must additionally represent **cancellation, timeout, retry, and restart reconciliation**, per issue #2. No state names or counts are invented here.

### 3.4 Message ordering

- Ordering must be stable and not depend on wall-clock timestamps alone.
- A monotonic per-conversation sequence (or equivalent stable key) is required for pagination.
- Run/event ordering must remain consistent with message ordering after reconnect and replay (H-020).
- Exact key design is open; no schema is proposed.

### 3.5 Memory and context

- Memory is user-accepted facts, not implicitly inferred profile data.
- Recall requires per-Bot selection plus explicit opt-in; no silent cross-conversation recall (`README.md:156-158`).
- Audit fields must allow the user to inspect and delete memories.
- Project-wide/shared context is out of POC scope (P4 research; H-036).
- **Unresolved:** whether memory is stored as discrete fact rows with embeddings, JSONB, or another representation. This note does not choose a storage technique.

### 3.6 Storage split

- Relational constraints and indexes must carry ownership keys, parent keys, idempotency uniqueness, and pagination keys.
- JSONB may hold non-authoritative metadata only; it must never be the authorization boundary (`README.md:152-166`, issue #2 non-goals).
- One PostgreSQL database; no Redis, NoSQL store, or second database (`README.md:178-187`).
- No table, column, index, or migration is defined in this preliminary note.

## 4. H-008 — required auth constraints

The issue requires a selected architecture with rationale, but this preliminary note **selects none**. Nothing below is an approved vendor or architecture choice.

### 4.1 Architecture options to evaluate

| Option | Callback handling | Session issuance | CSRF surface | API authorization | Preliminary risk |
|---|---|---|---|---|---|
| Nest-owned | API routes handle provider callbacks | API issues session | API endpoints | API validates its own session | Browser/API origin and redirect handling must be proven |
| Next-owned | Web handles callbacks | Web issues session | Web routes plus API calls | API must validate a web-issued session/token | Two authorization paths risk drift |
| Split | Web handles browser redirect; API owns identity exchange | API issues, web forwards | Both surfaces | API is the single validation authority | More moving parts and token handoff risk |

**No recommendation is recorded.** A recommendation requires the H-002 vocabulary, a threat model, and the deployment topology decision (open decision 7).

### 4.2 Session requirements (must be specified and testable)

- Server-controlled session with a server-side record; the browser must not be the source of truth.
- Cookie attributes must be explicitly decided: `HttpOnly`, `Secure`, `SameSite`, `Path`, and expiry/rotation behavior.
- Session rotation on privilege or authentication change; revocation; logout across devices.
- Session records must be owner-scoped and deleted/revoked on account deletion.
- Provider access/refresh tokens must never be stored in browser-readable storage; secrets stay server-side (`README.md:163`).
- No numeric session lifetime, rotation interval, or concurrency limit is proposed here; those require a decision with evidence.

### 4.3 Account linking and missing email

- Linking requires an authenticated action plus verification; a provider login must not silently merge into an existing account (`README.md:162`).
- Collisions must be explicit; the user must re-authenticate or verify before linking.
- Facebook may omit email (approved constraint, `README.md:162`). Microsoft also documents that the `email` claim is included only when an address is associated with the account (https://learn.microsoft.com/en-us/entra/identity-platform/scopes-oidc).
- Google documents that the `email` claim may not be unique and can change, so it must not be the primary identifier (https://developers.google.com/identity/openid-connect/openid-connect).
- **Open:** the fallback identity for a provider user without email (provider-specific subject identifier plus a verified secondary identifier, or a guided completion step). This note does not choose one.
- **Open:** email verification and password-reset ownership boundaries between web and API (H-008 checklist).

### 4.4 Provider prerequisites and minimal scopes

These are documented scope constraints, not a registration claim. No app registration, domain, or credential was verified.

| Provider | Minimal authentication scopes | Documented caveat | Source |
|---|---|---|---|
| Google | `openid email` (`profile` optional) | `email` claim only when the `email` scope is requested; email may not be unique or stable | https://developers.google.com/identity/openid-connect/openid-connect |
| Microsoft | `openid email` (`profile` optional) | `email` claim only if an address is associated; app must handle its absence; least privilege required | https://learn.microsoft.com/en-us/entra/identity-platform/scopes-oidc |
| Facebook | `email` | Grants read of the primary email; the fetched official page does not state that email is always present or whether App Review is required | https://developers.facebook.com/documentation/development/permissions |

- No mail, calendar, drive, or offline-access scope is proposed; SSO is identity only (`README.md:162`).
- Registration prerequisites still to collect: callback/redirect URIs, allowed origins, consent-screen configuration, app-review requirements, secret storage, and per-environment credentials. These are **not verified**.
- Google's docs note refresh tokens require `access_type=offline`; that is out of scope because Habi does not need provider API access for identity-only sign-in.

### 4.5 Registration, abuse, and threat model

- Registration mode (public vs invite-only) remains **open decision 2**; the handoff recommends invite-only on the shared VM but that is not approved (`README.md:298`). No default is assumed.
- Abuse limits must be defined for signup, login, password reset, and SSO callbacks. No numeric thresholds are proposed; they require decision and evidence.
- Threat model must cover CSRF, session fixation, open redirects, account takeover, and provider mix-up (state/nonce validation). No mitigation is selected here.
- Secrets must have a server-side storage plan; none may reach client code, the repository, logs, or ordinary chat (`README.md:163`).

## 5. Unresolved decisions and blockers

| Item | State | Blocker / owner |
|---|---|---|
| H-001 security acceptance | Pending | Security review not performed; H-002 dependency remains unmet |
| Object model review with tenant ownership (#16) and export/delete (#32) | Required by #2 | Depends on #16/#32 design input |
| Workspace as entity | Undecided; default is not to add one | Needs explicit justification |
| Run state machine and event schema | Undecided | H-002 vocabulary then H-022 |
| Message sequence/pagination key | Undecided | H-002 then H-019/H-020 |
| Memory representation and embedding approach | Undecided | H-002 then H-030 |
| Attachment/artifact retention and quota metadata | Undecided; open decision 3 for types/sizes | H-002 then H-026/H-028 |
| Auth architecture (Nest/Next/split) | **Not selected** | H-008; needs threat model and topology |
| Session store and cookie attributes | Not selected | H-008/H-017 |
| Account linking and missing-email fallback | Not selected | H-008 |
| Registration mode | **Open** (decision 2) | Product/owner |
| Provider registrations, callback domains, secrets | **Not verified** | Deployment prerequisites (decision 7) |
| Abuse-limit values | Not set | H-008/H-014/H-015/H-017 |
| Skill ownership/versioning | Unspecified by issue | H-002 then H-031 |
| Routine ownership/schedule | P3 only, out of POC | H-033/H-034 |

## 6. Downstream contracts

| Consumer | Contract this work must provide |
|---|---|
| #5 isolation proof | Owner/visibility predicates and cross-user deny semantics |
| #6 no-tool proof | Effective-capability definition distinct from Bot Markdown |
| #8 auth architecture | User identity anchor, session-to-user mapping, account states |
| #14/#15 signup/login/SSO | Identity, session, linking, and recovery vocabulary |
| #16 tenant ownership | Authorization predicates for every entity |
| #17 session/secret lifecycle | Session record, rotation, revocation, secret boundaries |
| #19 persistence | Entity keys, ownership foreign keys, message ordering |
| #20 stream/replay | Run/event ordering and stable replay cursor |
| #22 durable runs | Run fields, idempotency, terminal states, reconciliation |
| #24 Bot profiles | Bot configuration vs effective capability |
| #25 acceptance suite | Testable acceptance matrix |
| #26–#32 P2 | Attachment/artifact/memory/skill/export-delete scopes |

## 7. Acceptance evidence matrix

Nothing below is met; the matrix shows what evidence would satisfy each criterion.

### H-002

| Criterion | Status | Evidence required |
|---|---|---|
| Every entity has owner, visibility, lifecycle, deletion path | **Not met** | Entity-relationship diagram, field dictionary, deletion behavior per entity |
| No cross-user read/invoke by identifier | **Not met** | Two-user matrix with guessed-ID attempts and deny results |
| Conversation isolation default; memory recall opt-in | **Not met** | Visibility matrix plus opt-in state test |
| Bot instructions cannot change capability | **Not met** | Capability test with malicious Bot Markdown |
| Run ownership, idempotency, usage, terminal state | **Not met** | Run field dictionary and state-transition table |
| Attachment/artifact scoped to user+conversation | **Not met** | Download-authorization matrix |
| No speculative entity | **Not met** | Reviewed entity list justified line-by-line from issue/source |

### H-008

| Criterion | Status | Evidence required |
|---|---|---|
| One architecture selected with rationale and rejected alternatives | **Not met** | ADR with comparison and decision |
| Session, CSRF, rotation, revocation testable | **Not met** | Session spec plus tests |
| Provider prerequisites and minimal scopes documented | **Partially informed** | Scopes above are cited; registration prerequisites still unverified |
| Missing-email and linking rules explicit; no silent merge | **Not met** | Linking decision plus collision tests |
| Registration mode recorded, not accidental | **Not met** | Product decision (open decision 2) |
| Provider secrets server-side only | **Not met** | Secret-storage plan and client-bundle check |
| Decision grants no mailbox/calendar/file access | **Not met** | Scope inventory proving identity-only |

## 8. Bounded future test plan

Disposable local/test environment only; no production data, no real provider credentials, no quota exhaustion. Counts below are test-design fixtures, not product limits.

| Area | Bounded test | Evidence |
|---|---|---|
| Cross-user object access | Create two users, two Bots, two conversations; attempt read/write/cancel using guessed IDs | Request/response matrix, all denied |
| Message ordering | Insert messages with identical/clock-skewed timestamps; paginate | Stable order, no duplicates or gaps |
| Run idempotency | Replay the same enqueue request; simulate restart mid-run | Single execution; reconciled terminal state |
| Attachment/artifact scope | Request another user's download by ID | Denied; no metadata leak |
| Memory opt-in | Attempt recall without selection, then with selection | No recall without explicit selection |
| Session rotation/revocation | Rotate after login; revoke one device; logout all | Old session rejected; other devices per decision |
| CSRF | Submit state-changing request without/with invalid token | Rejected; valid token accepted |
| Open redirect | Craft callback return URL to an external origin | Rejected to a safe destination |
| Linking collision | Sign in with a provider identity already linked elsewhere | No silent merge; explicit verification path |
| Missing email | Provider account without email claim | Documented fallback; no merge |
| Secret exposure | Inspect built client assets and logs for provider secrets | None present |

## 9. Preliminary conclusion

- H-002's ownership vocabulary can be derived from approved scope, but the entity lifecycle details, Run state machine, message key, memory representation, and attachment retention remain undefined. No schema should be written until those are reviewed with #16 and #32.
- H-008 cannot select an architecture without the H-002 vocabulary and the deployment topology. The provider scope constraints are documented; registrations, missing-email fallback, linking policy, session mechanics, and abuse thresholds are not.
- Both issues remain **Backlog**; neither is Ready, and this note is not acceptance evidence.

## 10. Citation index

- https://github.com/daryllmagsombol/habi-bot/issues/2
- https://github.com/daryllmagsombol/habi-bot/issues/8
- https://github.com/daryllmagsombol/habi-bot/blob/main/README.md#L152-L166
- https://github.com/daryllmagsombol/habi-bot/blob/main/README.md#L178-L187
- https://github.com/daryllmagsombol/habi-bot/blob/main/README.md#L293-L303
- H-001 design note: linked relatively above
- https://github.com/users/daryllmagsombol/projects/1
- https://developers.google.com/identity/openid-connect/openid-connect
- https://learn.microsoft.com/en-us/entra/identity-platform/scopes-oidc
- https://developers.facebook.com/documentation/development/permissions
