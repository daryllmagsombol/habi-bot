# Session and Secret Lifecycle Design — H-017

- **Status:** **Proposed design at planning fidelity. Issue #17 remains OPEN; nothing here is accepted, implemented, or verified.** No schema, migration, code, dependency, credential, or runtime claim accompanies this document. The P0 exit gate is satisfied at the recorded fidelity (2026-11-03).
- **Date:** 2026-11-03. **Phase:** P1 — Security (H-017).
- **Scope:** Session record shape and lifecycle, cookie attributes, CSRF, revocation triggers, session validation by API and worker, and the at-rest lifecycle of per-user provider credentials. Numeric values are proposed defaults, not owner decisions.
- **Authority:** [issue #17](https://github.com/daryllmagsombol/habi-bot/issues/17), the accepted [H-008 auth design](./2026-10-23-auth-architecture-and-sso-design.md), the accepted [H-002 object model](./2026-10-22-object-and-context-model-design.md), the [provider-access design](./2026-10-28-provider-access-and-daily-allowance-design.md), the [H-005 isolation triage](../research/2026-11-03-h005-isolation-triage.md), and the [two-user spike results](../research/2026-11-03-p0-spike-two-user-ownership-results.md).
- **Repository state:** runnable foundation only. No session, cookie, CSRF, rate-limit, credential-storage, or persistence code exists. The H-005 spike's fixture bearer tokens are not authentication.

## 1. Relation to accepted work

| Reference | What this design takes | What it does not change |
|---|---|---|
| [H-008](./2026-10-23-auth-architecture-and-sso-design.md) §6 | Nest issues and validates sessions; opaque browser secret; synchronizer-token CSRF; rotation/revocation triggers | Auth flows, invite gate, linking, provider scopes |
| [H-002](./2026-10-22-object-and-context-model-design.md) §5, §16.1 | Server-resolved owner predicates; account deletion revokes sessions; no secrets in queue payloads, events, or exports | Object model, ownership transfer ban, purge timing |
| [Provider access](./2026-10-28-provider-access-and-daily-allowance-design.md) §5.2 | #17 owns storage, rotation, redaction mechanics; #21 owns connection behavior; keys never returned to clients | Allowance math, multi-user gate, provider choice |
| [H-005 triage](../research/2026-11-03-h005-isolation-triage.md) | Harness has one trust domain (the gateway key); unguessable IDs are not authorization | H-005 status; it remains blocked on #21/#22 |
| [Spike results](../research/2026-11-03-p0-spike-two-user-ownership-results.md) | Client identity headers ignored; harness IDs denied on every route; non-enumerating 404 | Spike code is disposable and not authentication |

## 2. Session lifecycle

A session is a **server-side record**; the browser holds only an opaque random secret. The database is the sole authority ([H-008](./2026-10-23-auth-architecture-and-sso-design.md) §6.1; one-database invariant from H-002).

| Stage | Design requirement |
|---|---|
| Creation | Only inside a successful authentication or activation transaction: email/password login, SSO callback success, invite activation, or re-authentication elevation. Never created for a pre-auth or registration transaction. |
| Secret | CSPRNG, at least 128 bits. Store a one-way verifier (`verifier_hash`), never the raw secret. Proposed default: SHA-256 over the secret; a slow KDF is unnecessary for high-entropy values but remains an implementation choice. |
| Mapping | One session row → exactly one `user_id`. No session may serve two users, and no user identity is ever read from a request header. |
| Idle expiry | Sliding, computed from server time on each validation. |
| Absolute expiry | Fixed at creation; never extended by activity or rotation. |
| Rotation | New secret and new row in the same transaction; the old row is retired, not reused. |
| Revocation | Sets `revoked_at` + `revoked_reason`; validation denies from that instant. Cookie deletion alone is not revocation. |
| Lineage | Rotations share a `session_family_id` so reuse of a retired verifier can revoke the whole family. |

### 2.1 Cookie attributes

| Attribute | Requirement |
|---|---|
| Name | `__Host-habi_session` where TLS and host-only scope hold; the `__Host-` prefix requires `Secure`, `Path=/`, and **no** `Domain` |
| `HttpOnly` | Required always; never readable by JavaScript |
| `Secure` | Required outside local development; `__Host-` cannot be used over plain HTTP, so a dev-only name without the prefix is a documented divergence |
| `SameSite` | `Lax` — the SSO callback is a top-level GET redirect ([H-008](./2026-10-23-auth-architecture-and-sso-design.md) §5.3); a `form_post` callback still fails closed |
| `Path` | `/` (required by the `__Host-` prefix) |
| `Domain` | Omitted; host-only |
| `Max-Age`/`Expires` | Mirrors server-side absolute expiry only; never a durable forever-cookie |
| Body/JS exposure | Never placed in `localStorage`, `sessionStorage`, readable cookies, URLs, or client logs |

### 2.2 Rotation and revocation matrix

| Trigger | Action |
|---|---|
| Login / SSO success / activation | Mint new session; destroy pre-auth state and any registration transaction |
| Privilege or credential change (password add/change, link, unlink, email change) | Rotate; optionally revoke sibling sessions (owner decision D2) |
| Re-authentication elevation | Rotate before granting the elevated scope |
| Logout | Revoke the presented session only |
| Logout-all | Revoke every session for the user, across devices |
| Password reset | Revoke all sessions except the one that completes the reset (which is itself rotated) |
| Email change | Revoke all sessions after the new address is verified |
| Account disable / delete | Revoke all sessions; deletion also triggers H-002 §16.1 store map |
| Suspicious activity (reuse detection, operator action) | Revoke the affected family or all sessions, and audit |

## 3. CSRF

CSRF protection is **distinct from the session identifier** and never derived from it alone.

- **Synchronizer token:** a per-session CSRF secret is issued to the page in a response body or response header, held by the web app in memory, and returned in an `X-CSRF-Token` header on state-changing requests. It is not a readable cookie and not persisted in browser storage ([H-008](./2026-10-23-auth-architecture-and-sso-design.md) §6.4 forbids double-submit).
- **Binding:** the token is bound to the session row; rotation re-issues it, revocation invalidates it.
- **Origin/Referer:** checked on every state-changing cookie-authenticated route as a second control. `SameSite=Lax` is defense-in-depth, not the only control.
- **Coverage:** all POST/PUT/PATCH/DELETE routes, including auth POSTs with a pre-auth browser-bound token. The SSO/link callback GET is the narrow protocol exception and uses transaction binding instead.
- **Failure shape:** `403 csrf_invalid` without account, invite, or session detail.

## 4. Session validation by API and worker

| Consumer | Contract |
|---|---|
| API (browser requests) | Validate the cookie on every request, resolve `user_id`, then run H-002 §5 predicates. A valid session never substitutes for an ownership check. |
| Worker | Receives **no** browser cookie and no session state. It consumes run/job context plus a scoped credential reference and reloads the Run, Conversation, Bot, and capability state ([H-002](./2026-10-22-object-and-context-model-design.md) §15). |
| Service-to-service | Uses short-lived internal credentials or signed scoped references, never a user's session secret; revocation of the user session does not require worker token replay. |

## 5. Secret lifecycle for per-user provider credentials

Applies to BYO inference keys and any later per-user provider credential. Provider client secrets, signing keys, and database credentials follow the same custody rules but are environment-scoped rather than user-scoped.

| Stage | Design requirement |
|---|---|
| Encryption at rest | **Envelope encryption.** A per-record data key (DEK) encrypts the credential with an AEAD cipher (proposed: AES-256-GCM, random 96-bit nonce, AAD binding `user_id`, credential id, provider, and `key_id`). The DEK is wrapped by a key-encryption key (KEK) held outside PostgreSQL. |
| Key custody | KEK material lives in an external KMS or secret manager, injected at runtime, never in the repository, image, database, logs, or client bundle. Only wrapped DEKs and ciphertext are stored. |
| Rotation | Two independent operations: **re-wrap** (unwrap DEK with the retiring KEK, wrap with the new `key_id`, atomic version bump, no plaintext exposure to logs) and **credential replacement** (user supplies a new key; old ciphertext destroyed). Both are audited without values. |
| Deletion | Delete the wrapped DEK and ciphertext row (crypto-shred); removal of only the wrapped DEK already makes the ciphertext unusable. Account deletion revokes connections and destroys material per H-002 §16.1. |
| Redaction | Never log or trace values. Structured logging uses an allow-list of fields; `Authorization`, `x-api-key`, cookies, and query strings are redacted at the logger boundary; provider-client errors are sanitized before logging. |
| Client exposure | Responses expose metadata only (provider, label, status, `key_id` version, created/last-used timestamps). No key material, no ciphertext, no wrapped DEK. |
| Owner scoping | Every read and write is keyed by `owner_user_id` resolved from the validated session; unique `(owner_user_id, provider, label)`; cross-user access denies non-enumeratingly. |
| Dispatch use | The API resolves the credential server-side at dispatch. A worker reference is scoped to one dispatch, single-use, bound to the Run owner, and unusable after run completion or revocation. |
| Access audit | One record per create, rotate, delete, use, and denial: actor, credential id, operation, purpose (`run_id`), result, `key_id`, timestamp. No plaintext and no ciphertext in audit. |
| Backup | Database dumps and snapshots contain **ciphertext plus wrapped DEKs only**; without KEK access they are not decryptable. KEK backup and restore are KMS responsibilities. A restored backup can reintroduce deleted ciphertext, so purge timing stays with #32/#12 and deletion is reported with that residual-copy caveat. |

## 6. Failure and abuse paths

| Path | Required behaviour |
|---|---|
| Missing / expired / revoked / unknown session | The **same** `401 unauthenticated` body and timing class; no distinction, no account hint, no redirect that varies by case |
| Reuse of a retired session secret | Detect against retained verifier hashes, revoke the entire `session_family_id`, audit, and return plain `401` |
| Clock skew | Server clock is authoritative for idle and absolute expiry; client timestamps are never trusted; a small provider-token skew allowance is a validation tolerance, not an extension of session lifetime |
| Concurrent sessions | Multiple devices allowed up to a cap; sessions are independent; logout-all revokes all; a device list shows coarse descriptors only |
| Session fixation | No session identifier is ever accepted from client input; a new secret is minted at authentication; pre-auth state is destroyed; retired secrets are never reissued |
| Rate limiting | Server-side, keyed per surface (login, reset, chat, upload, API, session validation), with account and IP keys kept separate so one attacker cannot lock a victim out; temporary and expiring. Numeric thresholds remain deferred (#23/#17) |
| Enumeration via sessions | Session endpoints never reveal whether an account, invite, or email exists; device lists are self-scoped |

## 7. Authorization interaction

- Identity is resolved **server-side only**, from a validated session row. Client headers (`x-user-id`, `x-spike-user-id`) are ignored — the spike showed spoofed headers granting nothing.
- A session id is a bearer secret for **one** user. It never grants access to another user's rows; H-002 §5 predicates run on every request after identity resolution.
- **Harness and provider IDs are never authorization.** The H-005 triage found the harness has exactly one trust domain — the gateway key — so any key holder could read any run, guessed IDs are non-enumerable but unguessability is not authorization, and the run record's `session_id` equals its `run_id`. The spike confirmed a `harness_…` value used as a Habi id returns `404` on read, events, audit, and tool routes. Session design therefore treats harness ids as opaque data mapped server-side.
- Non-enumerating denial for both cross-user and nonexistent resources stays H-002 §5.3.

## 8. Proposed data model sketch

**Proposed only. No migration, DDL, or column is approved; H-002's table set is unchanged and these are additive candidates for review.**

| Table | Key columns | Constraints / indexes |
|---|---|---|
| `auth_sessions` | `id`, `user_id`, `session_family_id`, `verifier_hash`, `auth_method`, `created_at`, `last_seen_at`, `idle_expires_at`, `absolute_expires_at`, `revoked_at`, `revoked_reason`, `rotated_from_id`, `device_label` | PK `id`; unique `verifier_hash`; FK `user_id`; indexes `(user_id, revoked_at)`, `(session_family_id)`, `(absolute_expires_at)` for purge |
| `auth_session_retired` | `verifier_hash`, `session_family_id`, `retired_at`, `reason`, `purge_after` | PK `verifier_hash`; index `(purge_after)`; bounded retention for reuse detection |
| `provider_credentials` | `id`, `owner_user_id`, `provider`, `label`, `status`, `key_id`, `wrapped_dek`, `ciphertext`, `nonce`, `aad_version`, `created_at`, `updated_at`, `last_used_at` | PK `id`; FK `owner_user_id`; unique `(owner_user_id, provider, label)`; index `(owner_user_id, status)` |
| `secret_access_audit` | `id`, `owner_user_id`, `credential_id`, `actor_type`, `operation`, `purpose_run_id`, `result`, `key_id`, `occurred_at` | PK `id`; indexes `(credential_id, occurred_at)`, `(owner_user_id, occurred_at)`; no value columns |

Rate-limit counters are **not** modeled here: they stay in PostgreSQL under the one-database invariant, with the shape owned by #23/#22.

## 9. Owner decisions versus proposed defaults

| # | Question | Proposed default | Status |
|---|---|---|---|
| D1 | Idle / absolute session TTL | 30 minutes idle, 12 hours absolute | **Owner decision required** |
| D2 | Whether credential-change rotation also revokes sibling sessions | Rotate the acting session; revoke siblings on password reset and email change only | **Owner decision required** |
| D3 | Re-authentication window for sensitive actions (password, email, secret create/rotate, delete) | 15 minutes | **Owner decision required** |
| D4 | Key management: external KMS versus operator-managed master key | External KMS/secret manager; no key in the database | **Owner decision required** |
| D5 | Whether the app decrypts credentials in-process at dispatch or delegates to a custody service | In-process decryption inside the API/worker with the KEK from the environment | **Owner decision required** |
| D6 | Concurrent-session cap per user | 10 | Proposed |
| D7 | Retired-verifier retention for reuse detection | 24 hours | Proposed |
| D8 | CSRF token delivery (response header vs body field) | Response header `X-CSRF-Token` | Proposed |
| D9 | Whether a non-reversible key fingerprint is shown to the user | No key-derived material; metadata only | Proposed |
| D10 | Rate-limit thresholds and storage mechanics | Deferred to #23/#22; PostgreSQL only | Deferred |
| D11 | Backup retention and purge window for ciphertext copies | Deferred to #32/#12 | Deferred |

## 10. Acceptance mapping and required tests

| #17 acceptance criterion | Design section | Test required (none run) |
|---|---|---|
| HttpOnly, Secure, SameSite cookies | §2.1 | Header assertions per environment; JS cannot read the cookie |
| Rotation and revocation across devices | §2.2 | Rotate on login/change; rotate-then-revoke; logout-all from a second device |
| CSRF on all state-changing routes | §3 | Missing/invalid/wrong-session token → `403`; route coverage sweep |
| Server-side rate limits with safe errors | §6 | Threshold behaviour, per-key separation, victim-recovery path |
| Provider keys server-side, access-controlled, redacted | §5 | Ciphertext-only dump; log/trace/export/bundle scans for values |
| No secret in bundle, repository, or chat | §5 | Build-artifact and repository scan |
| Tests for fixation, replay, expiry, revocation, CSRF | §2, §3, §6 | Fixation (client-supplied id ignored), retired-secret replay revokes family, idle vs absolute expiry, revocation immediacy |
| Operational rotation documented | §5, §9 | Runbook review; re-wrap drill without plaintext logging |
| Worker validation without browser cookies | §4 | Job with no cookie succeeds on ownership revalidation; mismatched payload rejected |

Additional required coverage: non-enumerating `401` equivalence, clock-skew behaviour at expiry boundaries, concurrent rotation race (one winner), crypto-shred verification after deletion, audit completeness without values, and backup-restore behaviour for deleted ciphertext.

## 11. Non-claims

- No session, cookie, CSRF, rate-limit, or credential-storage implementation exists; no test above has been run.
- No schema, column, cipher, KMS product, or numeric TTL is approved. §8 and the proposed defaults in §9 are review inputs only.
- No runtime security, isolation, or rotation capability is demonstrated; the H-005 harness probe did not test encryption at rest.
- Acceptance of this document would not close #17's implementation criteria, satisfy a P0 gate, or authorize code, deployment, provider calls, or secrets handling.
