# Habi POC Boundary and User Journeys — Design

- **Status:** Product baseline approved by the owner on 2026-10-21; AI-assisted planning-boundary review accepted by the owner on 2026-10-22 (see acceptance status below). H-001 closure also requires these documentation-link corrections to be merged and recorded on the issue; this file alone does not close H-001. P0 has not passed. Neither publication nor planning acceptance establishes runtime security.
- **Date:** 2026-10-21
- **Phase:** P0 — Feasibility (H-001)
- **Scope:** Planning specification only. No product flow described here is implemented.
- **Source draft:** [Published H-001 comment, 2026-10-21](https://github.com/daryllmagsombol/habi-bot/issues/1#issuecomment-6313596610)
- **Supersedes:** nothing. Complements the P0 boundary already stated in issue #1 and the repository scope rules.

## Current state versus planned flows

The repository contains only a runnable development foundation: a pnpm/Turborepo workspace, a minimal web shell, a `GET /health` API, an inert worker, shared packages, and local PostgreSQL Compose tooling. Authentication, chat, Bots, model calls, Hermes, persistence, queues, and deployment are not implemented ([README.md:7-9](https://github.com/daryllmagsombol/habi-bot/blob/e47dedb3612e9c46ee4ed7db7e31639f20114a1c/README.md#L7-L9), [README.md:34-41](https://github.com/daryllmagsombol/habi-bot/blob/e47dedb3612e9c46ee4ed7db7e31639f20114a1c/README.md#L34-L41)).

Every flow below is planned behavior, not current functionality.

## Existing planning boundary

Sources: [issue #1](https://github.com/daryllmagsombol/habi-bot/issues/1) and [repository scope/security rules](https://github.com/daryllmagsombol/habi-bot/blob/e47dedb3612e9c46ee4ed7db7e31639f20114a1c/README.md#L124-L172).

- Landing → signup/login → personal workspace → create/select a Bot → private conversation.
- Email/password and Google/Microsoft/Facebook SSO are planned. SSO establishes identity only; mailbox/calendar/file access requires separate future consent.
- Conversations remain private even under the same Bot. Persistent memory and wider context require deliberate opt-in.
- Bot Markdown is untrusted style/workflow guidance, never authorization. Ownership and capability restrictions are enforced server-side.
- No arbitrary shell, autonomous browsing/computer use, sending messages, payments, external account actions, or job applications. Public-web search remains undecided and off.

## Proposed behavioral journeys — product-approved baseline, security review pending

These specify behavior, not UI layout, API contracts, vendors, or numeric limits.

| Journey / actor | Preconditions | Ordered steps | Success | Failure and recovery |
| --- | --- | --- | --- | --- |
| Landing / visitor | App reachable | Read description and POC limits → choose signup/login | Auth entry reached without advertising excluded capabilities | Navigation/load failure → show a recoverable failure where possible; retry |
| Signup/login / visitor | Auth method configured | Choose method → authenticate → validate identity/session → enter own workspace | Authenticated access to own records only | Invalid credentials, cancelled/unavailable SSO, missing email, or identity collision → explain failure and retry safely; never silently merge identities |
| Workspace entry / member | Valid session | Validate ownership → load personal Bots/conversations → proceed to Bot selection | Only owned records visible; first-run state supports the next step | Expired session → reauthenticate; load failure → retry; cross-owner request → deny without exposing another user's records |
| Create/select Bot / member | Own workspace accessible | Select an owned Bot, or submit Bot details/instructions → validate → select for conversation | Owned Bot selected; Markdown changes no permissions | Invalid input → correct/retry; unavailable Bot → return to selection; ownership failure → deny |
| Private conversation / member | Own Bot/conversation and valid session | Send → execute restricted run → receive response → retain ordered history → continue after reconnect | Owner-only history and response, with no excluded tool/action | Provider/quota error → visible recoverable failure, no paid fallback; disconnect → reconnect/replay; retries must not duplicate sends; timeout/cancellation → visible terminal state |

Workspace proposal: a personal Bot chooser and owner-scoped conversation list; the empty state allows creating/selecting a Bot before conversation. No seeded Bot, workspace-count rule, Bot cap, or file limit is decided here. Memory capabilities remain subject to their later phase gates.

## Phase gates and traceability

Source: [phase table](https://github.com/daryllmagsombol/habi-bot/blob/e47dedb3612e9c46ee4ed7db7e31639f20114a1c/README.md#L263-L270).

- **P0:** H-001–H-008 accepted with scope, object model, provider, Hermes lifecycle/isolation/no-tool, VM/runtime and auth evidence. Isolation failure blocks launch.
- **P1:** H-009–H-025 delivered with private-chat acceptance evidence.
- **P2:** H-026–H-032 delivered with conversation/context security evidence.
- **P3:** Routine design go/no-go, constrained implementation and notification evidence.
- **P4:** Separate research-first go/no-go for optional capabilities.
- **P5:** Separate research-first decisions for expansion.

Creating an issue or publishing this document does not authorize later-phase implementation.

Downstream: landing/auth [#14](https://github.com/daryllmagsombol/habi-bot/issues/14)/[#15](https://github.com/daryllmagsombol/habi-bot/issues/15); ownership/session [#16](https://github.com/daryllmagsombol/habi-bot/issues/16)/[#17](https://github.com/daryllmagsombol/habi-bot/issues/17); chat [#18](https://github.com/daryllmagsombol/habi-bot/issues/18); persistence [#19](https://github.com/daryllmagsombol/habi-bot/issues/19); stream/replay [#20](https://github.com/daryllmagsombol/habi-bot/issues/20); Bot lifecycle [#24](https://github.com/daryllmagsombol/habi-bot/issues/24); acceptance [#25](https://github.com/daryllmagsombol/habi-bot/issues/25). Object model [#2](https://github.com/daryllmagsombol/habi-bot/issues/2), isolation [#5](https://github.com/daryllmagsombol/habi-bot/issues/5), no-tool proof [#6](https://github.com/daryllmagsombol/habi-bot/issues/6) and auth architecture [#8](https://github.com/daryllmagsombol/habi-bot/issues/8) constrain these journeys.

## Open decisions — deliberately unresolved

Source: [open P0 decisions](https://github.com/daryllmagsombol/habi-bot/blob/e47dedb3612e9c46ee4ed7db7e31639f20114a1c/README.md#L299-L309).

1. Exact free provider/model and exhaustion behavior ([#3](https://github.com/daryllmagsombol/habi-bot/issues/3)).
2. Registration mode: public vs invite-only.
3. Initial file types and sizes.
4. Bot count policy.
5. Public-web research placement: P1 vs P4.
6. Hermes cross-user memory/execution isolation and fallback approach.
7. Deployment prerequisites: domain/proxy, VM load, email sender and SSO registrations.

## Owner-requested goal addition — bring your own provider

On 2026-10-21, the owner added the goal that each user can connect their own **OpenCode, CommandCode, Claude/Anthropic, or ChatGPT/OpenAI** access. Use API keys or officially supported per-user sign-in as appropriate; subscription access is not automatically API access or permission for Habi integration.

Connections must be owner-isolated, securely managed server-side, and revocable/deletable. Validate provider terms, data handling, quotas, and billing before enabling a connection; never share credentials/allowances across users, bypass restrictions, or silently fall back to paid/platform-funded access. This records a product goal only: provider-specific feasibility, connection design, and delivery phase remain open. It does not imply implemented support, security acceptance, or a passed P0 gate, and it does not replace H-003's existing free-provider research criteria.

## Acceptance status

- **Product baseline:** approved by the owner on 2026-10-21 in session. The approval covers the journeys, boundary, phase gates, and unresolved decisions as published in the [source comment](https://github.com/daryllmagsombol/habi-bot/issues/1#issuecomment-6313596610). The orchestrator records that approval on issue #1.
- **Security-boundary acceptance:** the owner accepted the AI-assisted planning-boundary review on 2026-10-22 ([decision record](https://github.com/daryllmagsombol/habi-bot/issues/1#issuecomment-6341720556)). This is not independent human security certification or runtime verification. H-001 closure also requires these documentation-link corrections to be merged and recorded on the issue.
- **H-001:** remains open. **P0:** not passed.
- **Documentation:** this file is part of the repository documentation. Its publication does not constitute issue acceptance, security review, or a passed gate.
- **Open decisions:** all seven above remain unresolved; none has been silently approved.

Planned flows in this document do not assert any implemented capability, and no phase gate advances because this document exists.
