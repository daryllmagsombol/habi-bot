# Auth Architecture Decision Dossier — H-008 Preliminary Research

- **Status:** Historical preliminary research kept as the pre-decision record. The owner subsequently accepted the H-008 design locally at planning fidelity (2026-10-23), and that design is prepared for user-authorized publication on 2026-10-28. Remote acceptance remains unrecorded: issue #8 is OPEN and depends on H-002, which is CLOSED remotely without published acceptance evidence. No auth code/schema exists and no P0 gate has passed.
- **Date:** 2026-10-23
- **Scope:** H-008 — choose an auth architecture and SSO constraints for the POC. This dossier compares options and recommends one; it is not the final ADR.
- **Authority:** [issue #8](https://github.com/daryllmagsombol/habi-bot/issues/8), the accepted [H-001 boundary](../specs/2026-10-21-poc-boundary-and-journeys-design.md), the owner-approved [H-002 object model](../specs/2026-10-22-object-and-context-model-design.md) (local revision), and the prior [auth constraints note](./2026-10-21-object-model-and-auth-constraints.md).
- **Repository state:** runnable foundation only. Local manifests pin Next.js 16.4.2, NestJS 12.2.0, and Node 24.20.0; no auth, session, cookie, OAuth, or persistence code or dependency exists (`apps/web/package.json`, `apps/backend/package.json`, `.node-version`, `AGENTS.md`).
- **Boundary:** No provider registration, credential, model call, install, VM/cloud access, GitHub write, commit, or push. Provider facts were refreshed from official documentation on 2026-10-23; no vendor-wide research was performed.

**Post-research owner decisions — 2026-10-23:** the owner approved all consolidated choices: Nest-owned auth/session issuance and validation; a same browser-origin reverse-proxy `/api` target (no domain/vendor/deployment assumed); invite-only for email/password **and** new SSO signup; email-bound invites where the verified activation address must match the intended invite; one unique verified canonical login/recovery email per active account; a Habi-verified reachable recovery email before activation when verified email is missing/unusable; no email auto-merge; linking requires fresh existing-account proof plus new-provider ownership; block unlinking the last working method; email reset only replaces an existing password, while a first password requires fresh existing-provider authentication and an explicit add; and the #8/#21/#17/#16 responsibility split. These are recorded in the [locally accepted H-008 design](../specs/2026-10-23-auth-architecture-and-sso-design.md). The design is prepared for publication; remote acceptance is pending after publication and remains H-002-dependent. Implementation is not authorized by planning acceptance. §11 below is the pre-decision research record.

## 1. Decision question

Issue #8 asks for one recorded architecture covering callback handling, session issuance, CSRF, API authorization, provider setup, linking, missing-email behavior, registration mode, and recovery. It explicitly does **not** implement pages or register production providers.

The decision is constrained by:

- SSO proves **identity only**; no mailbox, calendar, drive, or offline-access scope ([H-001 note:67-71](../specs/2026-10-21-poc-boundary-and-journeys-design.md), [issue #8](https://github.com/daryllmagsombol/habi-bot/issues/8)).
- Accounts and sessions are owner-scoped; backend authorization is authoritative ([H-002 §5.1, §16.1](../specs/2026-10-22-object-and-context-model-design.md)).
- Missing email must be handled; identities must never silently merge ([H-001 note:33](../specs/2026-10-21-poc-boundary-and-journeys-design.md), [issue #8](https://github.com/daryllmagsombol/habi-bot/issues/8)).
- BYO inference-provider credentials are a separate concern from human identity (§9).

## 2. Options compared

**Terminology:** an **origin** is scheme + host + port; modern schemeful same-site checks use the scheme and registrable domain (eTLD+1). Same-origin is stricter than same-site. Cookie behavior depends on the origin/site relationship and on the browser's third-party-cookie policy.

| Criterion | Nest-owned | Next-owned | Split (API identity authority) |
|---|---|---|---|
| OAuth start/callback | API routes handle both | Web routes handle both | Web handles the browser redirect; API performs code exchange |
| Provider client secret | API only | Web runtime only | API only |
| Session issuance | API | Web | API |
| Session validation | API validates its own session | API validates a web-issued session/token at one boundary | API validates; web relays/forwards |
| Browser/API relationship | Same-origin or same-site is simplest; separate origins are possible with cross-site cookie or token-based API auth | Same-origin with web | Adds one internal hop; cookie domain still matters |
| CSRF surface | API routes | Web auth routes plus API calls | Web callback relay plus API routes |
| Main trade-off | Session issuance/validation and resource authorization stay in one runtime | Session issuance sits in the web runtime; API must share a validation contract | More moving parts and a session handoff between runtimes |

**Assessment**

- **Next-owned is not inherently insecure.** A Next-owned flow can issue sessions and have the API validate them centrally, while the Nest API still performs resource-level owner authorization. The cost is a cross-runtime session contract, shared configuration, and two places that must agree on cookie/token semantics. That is an engineering trade-off, not a security verdict.
- **Nest-owned keeps session issuance, session validation, and resource authorization in one runtime.** That reduces cross-runtime auth contracts and makes ownership checks and revocation easier to reason about. It does not make the API automatically secure; H-016 still owns resource authorization.
- **Separate origins or sites do not require a split.** A Nest-owned design can run across origins with appropriate cookie attributes or a token-based API, subject to third-party-cookie restrictions. A split is justified by a concrete deployment or trust constraint, not by topology alone.
- **Same-origin reverse proxy is a preference, not a deployed fact.** This repository does not establish a domain, proxy, or deployment topology (open decision 7).

**Recommendation (provisional, not accepted):** use **Nest-owned auth** so session issuance/validation and resource authorization share one responsibility boundary. Use **split** only if a concrete constraint (for example separate deploy/release ownership or a browser-facing web origin that cannot proxy the API) makes web-handled redirects preferable. Do not let Next issue sessions merely to simplify the UI. If a same-origin reverse proxy is later chosen, it simplifies cookies and CSRF; this dossier does not assume or approve that topology.

## 3. Session model requirements

A session cookie is a **bearer secret**, not a public resource identifier. Possession authenticates, so the value must be unguessable, transmitted only over TLS, marked `HttpOnly`, and validated against a server-side record on every request. Public resource IDs are different: they are never authorization and are always checked against the owner chain (H-002 §5.1).

| Concern | Requirement | Evidence / note |
|---|---|---|
| Session record | Server-side record keyed to `user_id`, with active/expired/revoked state | Issue #8 requires server-controlled sessions and revocation; #17 defines the lifecycle |
| Token generation | CSPRNG; at least 64 bits of entropy for the session identifier, and 128+ bits if a separate verifier/token is generated | OWASP Session Management Cheat Sheet, retrieved 2026-10-23 |
| Validation | Resolve the token to an active, unexpired, unrevoked session and an active user; reject otherwise | Bearer-secret handling; “never accept the identifier alone” applies to resource IDs, not to a validated session secret |
| Store hardening | Optional: store a one-way verifier plus a lookup identifier instead of the raw token | Research recommendation to reduce read-only store-disclosure impact; not a verified OWASP requirement or an adopted design |
| Cookie | `HttpOnly`, `Secure`, explicit `SameSite` (`Lax` or `Strict`), host-only where possible, `Path=/` | OWASP: HttpOnly mandatory; Secure required; never rely on the browser-default SameSite |
| Rotation | Regenerate on login, privilege change, linking/unlinking; destroy the pre-auth session | OWASP: renew after any privilege level change and invalidate previous IDs |
| Logout | Server-side invalidation, not just cookie deletion; logout-all-devices | OWASP: deleting a cookie alone does not invalidate a stolen copy |
| Revocation | Password reset, account disable/delete, provider unlink, suspicious activity, admin action | Issue #8 and #17 define triggers; H-002 §16.1 requires auth sessions revoked on account deletion |
| Timeouts | Idle and absolute, enforced server-side | OWASP recommends both; **numeric values are unselected** |
| Session listing | Per-device metadata and individual revocation | Issue #8 requires logout across devices; metadata fields deferred |

**Crypto baseline versus product limits.** Entropy and token-generation requirements are cryptographic baselines. Idle/absolute lifetimes, concurrency caps, and abuse thresholds are product/implementation limits; this dossier sets none. Issue #8 requires abuse limits to be defined, not a specific number, and the current research leaves all numbers unselected. Implementation must set and verify them before exposure.

**Cookie/SameSite branch.** `SameSite=Lax` works for an eligible top-level GET callback; `Strict` can suppress the initiating browser cookie. A cross-site `response_mode=form_post` also omits a Lax cookie. Neither an echoed transaction handle nor Origin validation alone proves that the receiving browser initiated the flow. Prefer a supported GET callback; a POST callback requires separately reviewed browser binding (for example a short-lived `SameSite=None; Secure` transaction cookie plus server-side state). Reject callbacks when binding cannot be verified. This is a design recommendation, not an adopted configuration.

## 4. Authorization-code flow requirements

### 4.1 Flow controls

- Use the authorization-code flow with a server-side code exchange. Never use the implicit flow for login.
- Use **PKCE with `S256`** where the provider supports or requires it. RFC 7636 says clients capable of `S256` MUST use it and servers must implement it; `plain` is only a fallback. PKCE does not replace `state` or redirect-URI validation.
- Validate `redirect_uri` against an exact allow-list before exchanging the code. Google requires an exact match; Meta requires Valid OAuth Redirect URIs and Strict Mode. Do not accept a `redirect_uri` supplied by the browser without an allow-list check.
- Generate a random, single-use `state`. Store it server-side with an expiry and bind it to the initiating browser session, the provider, the action (login/link), and the redirect URI. Verify and consume it on callback.
- For OIDC providers, validate the ID token signature, exact `iss`, `aud` containing the client ID, `nonce`, and expiry. Exchange the code server-to-server; never trust browser-supplied identity claims.
- For Facebook, exchange the code server-to-server with the app secret, then validate the access token with the debugging endpoint and check `app_id` and `user_id`. Meta states: “access tokens should never be assumed to be from the app that is using them, instead they should be checked using debugging endpoints.”
- Reject replayed or expired codes/states. A failed validation must not create a session or link.

### 4.2 Callback response mode

| Mode | Behavior | Control |
|---|---|---|
| `query` (default) | Provider redirects with parameters in the URL | Validate `state` against the initiating browser session; exact redirect URI |
| `form_post` | Provider auto-submits an HTML form via cross-site POST | Require independent initiating-browser binding in addition to single-use state; do not authenticate from a form handle or provider Origin alone; reject an unsupported binding mode |

**Login CSRF is not solved by per-provider `state` alone.** An attacker can start their own authorization flow and obtain a valid state. The transaction must be bound to the initiating browser independently of the callback parameters, and the post-login session must be new. An attacker-transferable one-time handle alone is not equivalent browser binding.

### 4.3 Threat table

| Threat | Vector | Primary control | Residual / owner |
|---|---|---|---|
| CSRF on state-changing API routes | Cross-site request with ambient cookie | Synchronizer token, Origin/Referer validation, SameSite defense-in-depth | Route coverage and token binding (#17) |
| Login CSRF | Attacker completes their own provider flow in the victim's browser | Pre-session transaction binding, new session after auth | Flow review and tests |
| Session fixation | Pre-set session identifier | Destroy pre-auth session; regenerate on authentication/privilege change | Implementation test |
| Session theft | XSS, insecure transport, logs | HttpOnly/Secure, TLS, no browser token storage, redaction | CSP and frontend review |
| Open redirect | Attacker-controlled `return_to` | Relative allow-list; exact registered redirect URIs | Callback tests |
| Provider mix-up | Wrong issuer or shared callback | Per-provider configuration/state; exact `iss`/`aud`; no generic callback without issuer checks | Multi-provider test |
| Code/state replay | Reused callback parameters | Single-use state/code, expiry, reject replay | Integration test |
| Token substitution (Facebook) | Token from another app/user | Debug endpoint, `app_id`/`user_id` check | Provider test |
| Account takeover via linking | Email collision or unverified email | No auto-link; prove existing Habi account plus new provider ownership | Linking tests |
| Account enumeration | Login/reset/linking errors | Generic responses; no other-account details | Abuse tests |
| Unlink lockout | Removing the last auth method | Require another working method first | Recovery test |

## 5. Provider facts refreshed 2026-10-23

| Provider | Verified from official documentation | Not stated / unavailable |
|---|---|---|
| Google | Basic request scope is `openid email`; `email` adds `email` and `email_verified`; “The value of this claim may not be unique to this account and could change over time,” so it must not be the primary identifier; exact authorized redirect URI match is required; documented setup needs a Cloud project, OAuth client, redirect URI, and consent screen ([Google OIDC](https://developers.google.com/identity/openid-connect/openid-connect), retrieved 2026-10-23) | Whether a Habi project/client exists; consent-screen verification or branding review status |
| Microsoft | OIDC scopes are `openid`, `email`, `profile`, `offline_access`; `email` gives the primary email claim; “The `email` claim is included in a token only if an email address is associated with the user account, which isn't always the case” ([Microsoft scopes](https://learn.microsoft.com/en-us/entra/identity-platform/scopes-oidc), retrieved 2026-10-23) | Exact current app-registration and redirect-URI console steps were not re-fetched; tenant/account-type choice and Habi app readiness are unknown |
| Facebook | `email` permission “allows your app to read a person's primary email address”; login security requires a `state` parameter, exact Valid OAuth Redirect URIs with Strict Mode, and token validation via debugging endpoints; apps accessing user data must provide a data deletion path with an HTTPS callback URL and a confirmation code ([Meta permissions](https://developers.facebook.com/documentation/development/permissions), [Meta login security](https://developers.facebook.com/documentation/facebook-login/security), [Meta data deletion](https://developers.facebook.com/documentation/development/create-an-app/app-dashboard/data-deletion-callback), all retrieved 2026-10-23) | The fetched official pages do **not** state that email presence is guaranteed, nor that `email` specifically requires App Review or Business Verification. Treat both as unavailable, not as “not required” |

**Consequence:** do not use email as the account key for any provider. Treat a missing email as an expected branch, not an error.

## 6. Account linking, collisions, and recovery

**Identity key:** OIDC providers use `(issuer, subject)`. Facebook uses the **app-scoped user ID** validated through its token-debug flow, not a global Facebook ID or email. These are provider-specific identity models, not interchangeable OIDC claims.

| Case | Required behavior |
|---|---|
| Link a provider to an existing Habi account | Require **fresh proof of the existing Habi account** (re-authentication with the current password or an already-linked provider) **and** proof that the user controls the new provider identity. A fresh login at the new provider alone is insufficient |
| Provider identity already linked elsewhere | Deny with a non-enumerating error; instruct the user to sign in to the existing account; no automatic merge |
| Same verified email, different provider subject | Do **not** auto-link. Require authentication to the existing Habi account before linking |
| Missing email | Anchor identity to the provider subject and **collect and verify a reachable recovery email before account activation**. Do not infer an address from the provider profile |
| Email-less account requested | Requires a separate, explicitly designed recovery model. A username alone is not equivalent proof of identity and not sufficient for recovery; no support override is assumed |
| Unlink | Require another working auth method first; if this is the last method, block until a password or another provider is added. Revoke or require re-authentication for affected sessions; #17 owns the exact trigger |
| Recovery | Password reset only for a verified Habi email. An account with no verified email needs the separately designed recovery path above |
| Deletion | Revoke sessions and provider links; H-002 §16.1 requires provider connections to be revoked/deleted |

Collision and linking errors must not reveal another account's existence or provider details. “No silent merge” is both an issue #8 acceptance criterion and an H-001 rule.

## 7. Identity-only scopes and provider setup

| Provider | Minimal scopes | Explicitly excluded |
|---|---|---|
| Google | `openid email` (`profile` optional) | Mail, calendar, drive, `offline_access` |
| Microsoft | `openid email` (`profile` optional) | Mail, calendar, files, `offline_access` |
| Facebook | `email` (public profile is baseline) | Friends, posts, pages, messaging, ads |

**Documented setup requirements versus Habi readiness**

| Provider | Documented required setup | Habi readiness |
|---|---|---|
| Google | Cloud project, OAuth client ID/secret, authorized redirect URI (exact match), consent screen | Unknown: no project or client is recorded |
| Microsoft | OIDC scopes above; app registration and redirect URI configuration are platform prerequisites (exact current console steps not re-fetched) | Unknown: no app registration is recorded |
| Facebook | App with Facebook Login, Valid OAuth Redirect URIs and Strict Mode, `state`, data deletion callback URL in the App Dashboard, privacy-policy deletion instructions | Unknown: no app is recorded; App Review/Business Verification applicability for `email` is unstated in the fetched docs |
| All | Production/staging hostnames, TLS, proxy/cookie-domain layout, per-environment secrets, email sender domain and DNS authentication | Unknown: open decision 7 and deployment prerequisites |

“Unknown readiness” means the project has no confirmed registration; it does not mean the provider lacks a documented requirement.

## 8. Secrets, tokens, verification, and reset ownership

- Provider client secrets live only in the API/secret store, never in `NEXT_PUBLIC_*`, client bundles, browser storage, logs, or the repository.
- Identity-only flows **may still process short-lived provider tokens**: a Google/Microsoft ID token, or a Facebook access token used for a server-side Graph `/me` request. Process them server-side only, do not expose them to the browser, and do not persist them beyond the verification step unless a later flow justifies storage.
- Do not request `offline_access` or refresh tokens by default. No long-lived provider token is needed for identity-only SSO.
- The API owns token generation, verification, reset state, and session invalidation. The web renders forms and submits to the API; it does not mint or validate auth tokens.
- Reset and verification responses must not enumerate accounts; tokens must be single-use and expiring (values deferred); a successful reset revokes existing sessions.
- Email delivery (sender domain, SPF/DKIM/DMARC) is a prerequisite not yet verified.

## 9. Identity SSO versus BYO inference-provider credentials

These are different trust relationships and should not share one credential model.

| Concern | H-008 (identity SSO) | #21 / BYO inference provider | #17 / crosscutting | #16 / ownership |
|---|---|---|---|---|
| Purpose | Prove who the human is | Connect a user's own model access | Session/secret lifecycle | Tenant isolation |
| Credential | OIDC client secret (Habi's), short-lived provider token for verification, session | User-supplied API key or per-user sign-in token | Provider-key storage, rotation, redaction | Owner predicates on connections |
| Scope | `openid email` only | Provider-specific inference scope | Secret storage/rotation | Cross-user denial |
| Failure mode | Account takeover / merge | Cross-user credential leakage, billing, terms violation | Secret exposure | Cross-tenant access |

**Proposed boundary (not approved):** #8 owns human identity, SSO, sessions, and identity linking; #21 owns inference-provider connection behavior, validation, adapter use, and revocation; #17 owns the shared secret-storage, rotation, and redaction mechanics because issue #17 explicitly includes “provider-key storage, access control, rotation, and redaction”; #16 owns tenant-ownership enforcement. The H-002 design defers the BYO schema to “#8/#21,” so the exact storage implementation ownership still needs an owner decision.

## 10. Abuse controls (no numeric thresholds)

| Surface | Controls to define | Numeric values |
|---|---|---|
| Signup | Per-IP and per-account limits, disposable-email handling, invite gate if selected | Unselected |
| Login | Progressive delay/lockout, credential-stuffing detection, generic errors | Unselected |
| Password reset | Per-account/IP limits, single-use tokens, no enumeration | Unselected |
| SSO callback | State/nonce failure limits, malformed-callback throttling, provider error handling | Unselected |
| Linking/unlink | Re-auth requirement, attempt limits, audit | Unselected |
| Sessions | Concurrent-session policy, revocation on suspicion | Unselected |

Numeric limits belong to #14/#15/#17/#23 after measurement. This research leaves them unselected; implementation must set and verify them before exposure.

## 11. Material owner questions and recommendations (pre-decision record)

These were the questions before the 2026-10-23 owner decisions; the decisions are recorded at the top of this note and in the design draft.

1. **Deployment topology / domain (open decision 7).** Same-origin proxy, same-site different origins, or separate sites? *Recommendation:* choose a same-origin reverse proxy if operationally available; it simplifies cookies and CSRF. Do not treat it as already deployed.
2. **Architecture.** *Recommendation:* Nest-owned, because session issuance/validation and resource authorization stay in one runtime; split only for a concrete deployment or trust constraint. This is a recommendation, not acceptance.
3. **Registration mode (open decision 2).** *Recommendation:* invite-only for the shared-VM POC; public registration is not a default. Owner must record the decision.
4. **Linking policy.** *Recommendation:* no auto-link; require fresh proof of the existing Habi account plus proof of the new provider identity; collision denies without revealing another account.
5. **Missing-email fallback.** *Recommendation:* collect and verify a reachable recovery email before activation, anchored to the provider subject. If email-less accounts are desired, design a separate recovery model; do not assume username-only recovery or support override.
6. **BYO boundary.** *Recommendation:* #8 identity, #21 inference connections, #17 secret mechanics, #16 ownership. Proposed only; owner confirms.

## 12. Deferred implementation inputs

- Auth library or hand-rolled OIDC client; session store (PostgreSQL table vs library store); cookie names and exact attributes.
- Numeric idle/absolute timeouts, concurrency limits, abuse thresholds, and token TTLs.
- Email provider, sender domain, SPF/DKIM/DMARC setup.
- Secret manager and rotation procedure; audit-event schema.
- Provider tenant/account-type configuration and per-environment registrations.
- Whether the web is server-rendered behind the proxy or calls the API directly.

None of these changes the recommendation to keep one session issuer/validator.

## 13. Gaps and genuine blockers

Items 1 and 3–4 were open at research time and still constrain implementation; items 2, 5, and 6 were resolved or re-scoped by the 2026-10-23 owner decisions. Issue state was re-read on 2026-10-28; the project board was not re-checked for this revision.

1. **Deployment topology is undecided**, so cookie/session mechanics are conditional. This remains the main blocker to a final architecture.
2. **H-008 dependency record:** H-002 is owner-approved locally and prepared for publication alongside the H-008 design, but its remote acceptance is not published; issue #2 is CLOSED remotely without published acceptance evidence. H-008 cannot be marked accepted remotely until that is reconciled after publication.
3. **Facebook email availability and review applicability are not stated** in the fetched official pages. Do not claim either way.
4. **Provider registration readiness is unknown** (projects, clients, redirect URIs, consent screens, app review, data deletion callback). These depend on decision 7 and actual registrations.
5. **Registration mode** was an owner decision at research time; the owner has since recorded invite-only for both password and SSO signup (design D3).
6. **BYO ownership split** was proposed here, not approved at research time; the owner recorded the split (design D7: #8 identity, #21 inference connections, #17 secret mechanics, #16 ownership). Exact storage remains downstream.

## 14. Sources

| Source | Use | Retrieved |
|---|---|---|
| [Issue #8](https://github.com/daryllmagsombol/habi-bot/issues/8) | H-008 outcome, checklist, acceptance, non-goals | 2026-10-23 |
| [H-001 boundary note](../specs/2026-10-21-poc-boundary-and-journeys-design.md) | SSO identity-only, missing email, no silent merge, open decisions 2/7 | 2026-10-21; accepted 2026-10-22 |
| [H-002 object model](../specs/2026-10-22-object-and-context-model-design.md) (local approved revision) | Owner chain, non-enumerating denial, auth-session revocation, BYO deferral | Approved 2026-10-23; prepared for publication, not merged |
| [Auth constraints note](./2026-10-21-object-model-and-auth-constraints.md) | Prior option and requirement analysis | 2026-10-21 |
| [Issue #16](https://github.com/daryllmagsombol/habi-bot/issues/16) | Tenant ownership at every boundary | 2026-10-23 |
| [Issue #17](https://github.com/daryllmagsombol/habi-bot/issues/17) | Session/secret lifecycle, provider-key storage and rotation | 2026-10-23 |
| [Issue #21](https://github.com/daryllmagsombol/habi-bot/issues/21) | Provider/harness adapter and key handling | 2026-10-23 |
| [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect) | Scopes, email claims, redirect URI exact match | 2026-10-23 |
| [Microsoft OIDC scopes](https://learn.microsoft.com/en-us/entra/identity-platform/scopes-oidc) | Scopes and conditional email claim | 2026-10-23 |
| [Meta permissions reference](https://developers.facebook.com/documentation/development/permissions) | `email` permission and Advanced Access verification | 2026-10-23 |
| [Meta login security](https://developers.facebook.com/documentation/facebook-login/security) | `state`, exact redirect URIs, Strict Mode, token debugging | 2026-10-23 |
| [Meta data deletion callback](https://developers.facebook.com/documentation/development/create-an-app/app-dashboard/data-deletion-callback) | HTTPS callback, confirmation code, deletion path | 2026-10-23 |
| [RFC 7636 (PKCE)](https://www.rfc-editor.org/rfc/rfc7636) | `S256` requirement and public-client PKCE | 2026-10-23 |
| [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html) | `iss`/`aud`/signature/nonce/state validation | 2026-10-23 |
| [OAuth 2.0 Form Post Response Mode](https://openid.net/specs/oauth-v2-form-post-response-mode-1_0.html) | Cross-site POST callback behavior | 2026-10-23 |
| [OWASP Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html) | Session record, cookie, entropy, rotation, logout, timeouts | 2026-10-23 |
| [OWASP CSRF Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html) | Synchronizer token, SameSite limits, login CSRF | 2026-10-23 |
| `apps/web/package.json`, `apps/backend/package.json`, root `package.json`, `.node-version` | Runtime baselines; no auth dependencies | 2026-10-23 |

**This dossier records no acceptance by itself:** the H-008 design was accepted locally afterwards at planning fidelity and is prepared for publication. Remote H-008 acceptance remains unrecorded while the issue is OPEN; no runtime proof exists and P0 has not passed.
