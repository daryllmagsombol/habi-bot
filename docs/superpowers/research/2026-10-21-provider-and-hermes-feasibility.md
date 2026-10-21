# Provider and Hermes Feasibility — Preliminary Research

## Owner clarification after research (2026-10-21)

The owner confirmed that the intended project is `NousResearch/hermes-agent` and that Console/Zen API access exists. This resolves the earlier project-identity ambiguity and the access-unconfirmed baseline. The inspected v0.22.2 commit remains a proposed spike baseline, not production adoption. The interface remains unselected. The approved local credential path was verified; one bounded request was sent and returned HTTP 403 `FreeTierError` (§3.4). No Hermes runtime test was performed, and no runtime or phase-gate acceptance is implied.

- **Status:** Preliminary research only. No provider, harness, version, adapter, or deployment shape is adopted. One bounded credentialed provider probe was performed; no Hermes runtime test was performed.
- **Date:** 2026-10-21
- **Scope:** H-003 (Zen free provider), H-004 (Hermes run lifecycle), H-005 (multi-user Hermes isolation).
- **Gate state:** H-001 remains open; P0 has not passed. H-003 has one access-backed negative result and remains unaccepted. H-004 depends on H-003; H-005 depends on H-002 and H-004. All three remain unaccepted. This note does not start implementation or accept a gate.
- **Repository state:** runnable foundation only. No auth, chat, Bots, model-call, Hermes, persistence, queue, or deployment code exists.

## 1. Evidence ranks and method

| Rank | Meaning in this note |
|---|---|
| **A** | Primary source inspected at an immutable commit: source code or docs in the candidate repository at the pinned commit below. |
| **B** | Official vendor documentation retrieved on 2026-10-21. Live pages can change; they are not immutable. |
| **C** | Inference from naming, ecosystem, or code shape. Not sufficient for a decision. |
| **D** | Unknown, blocked, or not verified. |

Method: `gh` reads of the public repository, issues, releases, tags, and raw files; direct `webfetch` of official documentation; and one bounded credentialed provider probe recorded in §3.4. No external search provider, no private repository content, no install, no host/VM access, no GitHub writes. Hermes findings remain **static inspection**, not runtime proof.

## 2. Identity status: project confirmed, version/interface open

The owner confirmed on 2026-10-21 that the intended harness is [`NousResearch/hermes-agent`](https://github.com/NousResearch/hermes-agent). This resolves the project identity only. Habi’s own repository still does not pin a version, license, interface, endpoint, or adapter contract:

- “**Hermes** is the preferred harness in the plan, behind a replaceable adapter.” ([README.md:191](https://github.com/daryllmagsombol/habi-bot/blob/main/README.md#L191))
- “Hermes must stay on a private application/API path. Its sessions, tools, and persisted memory require isolation testing before multi-user exposure.” ([README.md:165](https://github.com/daryllmagsombol/habi-bot/blob/main/README.md#L165))
- The H-001 design note lists “Hermes cross-user memory/execution isolation and fallback approach” as unresolved, again without a project link ([design note](../specs/2026-10-21-poc-boundary-and-journeys-design.md)).
- Issues #3, #4, #5 and the repository plans name “Hermes” only as a harness.

No repository file, issue body, or committed plan pins the project. “Hermes” is also used by unrelated projects (for example a model family and a JavaScript engine), so the name alone was not an identifier.

**Confirmed project (owner, 2026-10-21):** [`NousResearch/hermes-agent`](https://github.com/NousResearch/hermes-agent).

- Public, MIT-licensed agent harness; homepage `https://hermes-agent.nousresearch.com`; created 2025-07-22.
- Its published capabilities match the Habi vocabulary: sessions, persistent memory, toolsets, profiles, gateways, subagents, and an OpenAI-compatible API server.
- Latest release at inspection: **v0.22.2**, published 2026-10-15. The annotated tag resolves to commit **`d923a5eb487a17c0a68801bba9ef0f56c81040a8`**. This commit is used to make the inspection reproducible, not as an adopted version.

**Remaining blocker:** the version and intended interface are not confirmed. This note treats every Hermes finding as **conditional on v0.22.2 at the commit above**. A human owner must pin the version and interface before H-004 or H-005 evidence can be accepted. Do not let an implementer silently adopt v0.22.2 merely because it was the latest inspected release.

## 3. H-003 — OpenCode Zen free provider

### 3.1 Official documentation baseline (rank B, retrieved 2026-10-21)

Source: [OpenCode Console Models](https://opencode.ai/v2/docs/console/models/).

The page lists multiple free models, not one. The free set includes:

`big-pickle`, `glm-5.3-flash-free`, `deepseek-v4.1-flash-free`, `minimax-m3.1-flash-free`, `beam-free`, `ll-alpha-free`, `longcat-2.5-preview-free`, `exo-free`, `mimo-v2.6-flash-free`, `mimo-v2.5-free`, `nemotron-3-ultra-free`, `nemotron-3.5-lightning-free`, `nemotron-3.5-super-vl-free`.

All except Jev use `https://opencode.ai/inference/openai/v1/chat/completions`; `jev-1.13-free` uses `https://opencode.ai/inference/systemone/v1/systemone`.

The free offer is explicitly limited-time and model-specific privacy differs:

| Model group | Documented privacy term |
|---|---|
| `deepseek-v4.1-flash-free`, `glm-5.3-flash-free`, `minimax-m3.1-flash-free`, `longcat-2.5-preview-free` | Provider follows zero-retention and does not train on data |
| `beam-free` | No training; retained 30 days for safety |
| `big-pickle`, `ll-alpha-free`, `exo-free`, `mimo-v2.6-flash-free`, `mimo-v2.5-free` | During the free period, collected data may be used to improve the model |
| `nemotron-3-ultra-free`, `nemotron-3.5-lightning-free`, `nemotron-3.5-super-vl-free` | Trial only; do not submit personal/confidential data; logged for security and product improvement |
| `jev-1.13-free` | No separate retention/training statement on the page |

The general page also states US/EU hosting and a general zero-retention policy “with exceptions”. The exceptions above materially limit which free model could be used for Habi prompts.

### 3.2 Still undocumented or unknown (rank D)

The page does **not** state, for these free models:

- context window or output-token limit;
- tool-calling support;
- vision support (a `VL` name is not evidence);
- streaming support;
- request, concurrency, or quota limits;
- the HTTP status/body when the free quota is exhausted;
- whether exhaustion can ever create a charge, or whether a paid fallback exists;
- data residency per model beyond the general US/EU statement.

These are acceptance blockers for H-003, not details to infer from model names.

### 3.3 Hermes-side provider surface (rank A, conditional on candidate)

The inspected Hermes project has a first-class provider definition for OpenCode Zen:

- `plugins/model-providers/opencode-zen/__init__.py` registers `opencode-zen` with alias `opencode`, env var `OPENCODE_ZEN_API_KEY`, and base URL `https://opencode.ai/zen/v1` ([pinned source](https://github.com/NousResearch/hermes-agent/blob/d923a5eb487a17c0a68801bba9ef0f56c81040a8/plugins/model-providers/opencode-zen/__init__.py)).
- Hermes’ provider documentation lists `OPENCODE_ZEN_API_KEY` / provider `opencode-zen` and says both OpenCode providers send a per-conversation `x-opencode-session` header ([pinned docs](https://github.com/NousResearch/hermes-agent/blob/d923a5eb487a17c0a68801bba9ef0f56c81040a8/website/docs/integrations/providers.md)).
- The same documentation says Hermes supports any OpenAI-compatible endpoint via a custom provider with `base_url` and model name ([pinned docs](https://github.com/NousResearch/hermes-agent/blob/d923a5eb487a17c0a68801bba9ef0f56c81040a8/website/docs/integrations/providers.md)).

**Interface mismatch to resolve before testing:** the official OpenCode page gives `/inference/openai/v1`, while the inspected Hermes provider hard-codes `/zen/v1`. Nothing inspected states these are aliases. Do not assume the built-in provider reaches the documented endpoint. A safe first test would configure a **custom OpenAI-compatible provider** at the exact documented URL, or first verify the relay behavior with a redacted request.

**Auxiliary-model risk, separate from provider fallback (rank A, conditional):** the same provider definition sets `default_aux_model="gemini-3-flash"` for `opencode_zen` ([pinned source](https://github.com/NousResearch/hermes-agent/blob/d923a5eb487a17c0a68801bba9ef0f56c81040a8/plugins/model-providers/opencode-zen/__init__.py#L119-L123)). That is a paid/unknown model, not a free candidate. Bounded call sites inspected:

- `_get_aux_model_for_provider()` returns `default_aux_model` when the provider is selected and no model is supplied ([source](https://github.com/NousResearch/hermes-agent/blob/d923a5eb487a17c0a68801bba9ef0f56c81040a8/agent/auxiliary_client.py#L783-L818)).
- The explicit-provider branch calls `_get_aux_model_for_provider(provider)` when the request has no model ([source](https://github.com/NousResearch/hermes-agent/blob/d923a5eb487a17c0a68801bba9ef0f56c81040a8/agent/auxiliary_client.py#L5312)).
- `_main_route_target()` uses the provider’s fast/aux model only when the task opts into `prefer_fast_model`; default `title_generation.prefer_fast_model` is `false`, and default `provider: auto` resolves to the **main provider + main model**, not `default_aux_model` ([source](https://github.com/NousResearch/hermes-agent/blob/d923a5eb487a17c0a68801bba9ef0f56c81040a8/agent/auxiliary_client.py#L4563-L4588), [config defaults](https://github.com/NousResearch/hermes-agent/blob/d923a5eb487a17c0a68801bba9ef0f56c81040a8/hermes_cli/config_defaults.py#L774-L786)).

So `gemini-3-flash` is **not automatically selected in the default auto configuration**; the risk is configuration-dependent. It becomes reachable if an auxiliary task names `opencode-zen` with an empty model, or if `prefer_fast_model: true` is set for title generation. If that happens, an auxiliary call can bill or fail independently of the main chat model and independently of the paid-fallback policy. This is a **required proof item**, not an established charge: disable auxiliary tasks that are not needed, or pin every used auxiliary task to the chosen free model or a local model, then capture the auxiliary call log.

### 3.4 Live probe — 2026-10-21 (rank A, observed)

Access was confirmed by the owner, and an approved local credential file was used. Before any internal read, the file was verified as a regular non-symlink file owned by the current uid with mode `0600`, and its parent directory as owned by the current uid with mode `0700`. Parsing was line-based with `shlex`; no `source`, `eval`, environment dump, key length, or credential output occurred. No secret was printed or placed in a child prompt.

Public documentation still listed `deepseek-v4.1-flash-free` at the exact endpoint on 2026-10-21 before the call. **One** credentialed request was then sent to the documented endpoint:

- Request: `tiny_normal`, synthetic prompt `Reply with exactly OK.`, `max_tokens: 64`, 30-second timeout, no retries, no redirects, no fallback or auxiliary model.
- Result: **HTTP 403** in 1.1 seconds.
- Redacted body: `{"type":"error","error":{"type":"FreeTierError","message":"OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai and keep building."}}`
- Stop condition: 403 reached, so the remaining streaming, long-prompt, and tool-declaration probes were **not** sent. No usage was returned.

This is an observed provider-policy rejection, not an authentication failure. It does not prove the key is invalid, and it does not prove the account lacks paid entitlement. It does show that the documented free model is **not usable from this external client shape** on 2026-10-21. The free listing is not billing or access proof.

The inspected Hermes provider uses a different relay path (`/zen/v1`) and sends an `x-opencode-session` header. Whether either changes this policy is **untested** and must not be assumed. No workaround, header experiment, alternate model, or additional request was attempted after the 403.

Sanitized evidence was retained outside the repository by the research lane.

### 3.5 H-003 acceptance matrix

| Acceptance item | Status | Evidence / gap |
|---|---|---|
| Exact model ID and endpoint with dated primary source | **Confirmed; live access rejected** | `deepseek-v4.1-flash-free` at the documented endpoint, 2026-10-21. One credentialed call returned 403 `FreeTierError`; no usable response |
| Tool support verified/unsupported/unknown | **Not tested** | 403 stopped the probe; no tool-declaration request was sent |
| Vision support stated | **Unknown** | Not documented; not tested; names are not evidence |
| Streaming support stated | **Not tested** | 403 stopped the probe; no streaming request was sent |
| Context and output limits stated | **Unknown** | Not documented; no successful request |
| Rate/concurrency/quota windows | **Unknown** | Not documented; no successful request |
| Exhaustion returns recoverable error | **Unknown** | No documented status/body; no successful request |
| No automatic paid charge on main-chat exhaustion | **Unknown** | No documented guarantee and no account/billing evidence |
| No paid auxiliary model selected | **Not exercised** | Provider registers `default_aux_model="gemini-3-flash"`. The 403 occurred before any auxiliary path; disable/override and log proof still required if the Hermes path is pursued |
| Privacy/data handling actionable | **Partial** | Model-specific terms documented; acceptance requires product/security review and a chosen model |
| Hermes compatibility cited from evidence | **Unknown / unproven** | Built-in provider uses `/zen/v1` + `x-opencode-session`; the documented endpoint rejected this external client with a free-tier policy error. The Hermes path was not tested |
| Go/no-go decision | **No-go for direct external use on 2026-10-21** | The documented free tier explicitly rejected a non-OpenCode client; no streaming/tool/long/usage evidence exists |

**Recommendation:** keep H-003 **open and unaccepted**. Do not adopt this free model for a direct adapter, do not enable paid fallback, and do not describe the provider as Hermes-compatible. Do not work around the 403 with alternate headers, relays, models, or retries. If the Hermes path is pursued, it needs a separately authorized test and a documented reason to expect a different policy result; the current evidence does not support one.

## 4. H-004 — Hermes run lifecycle

### 4.1 Candidate interface (rank A, conditional)

The candidate exposes three programmatic interfaces ([programmatic integration docs](https://github.com/NousResearch/hermes-agent/blob/d923a5eb487a17c0a68801bba9ef0f56c81040a8/website/docs/developer-guide/programmatic-integration.md)):

| Interface | Transport | Fit for Habi |
|---|---|---|
| ACP | JSON-RPC over stdio | IDE-oriented; not a server-side multi-user API |
| TUI gateway | JSON-RPC over stdio/WebSocket | Rich sessions/approvals, but host-oriented and stateful |
| API server | HTTP + SSE | Best fit for a backend-owned adapter; documented OpenAI-compatible surface |

The API server is implemented in `gateway/platforms/api_server.py` and `gateway/platforms/api_server_runs.py`. It exposes:

`POST /v1/runs`, `GET /v1/runs/{id}`, `GET /v1/runs/{id}/events`, `POST /v1/runs/{id}/approval`, `POST /v1/runs/{id}/steer`, `POST /v1/runs/{id}/stop`, plus `/api/sessions/*` and `/v1/chat/completions` ([route table](https://github.com/NousResearch/hermes-agent/blob/d923a5eb487a17c0a68801bba9ef0f56c81040a8/gateway/platforms/api_server.py#L83-L98)).

### 4.2 Source-inspected lifecycle behavior

| Operation | What the source shows | Gap / risk |
|---|---|---|
| Create | `POST /v1/runs` accepts `input`, optional `session_id`, `X-Hermes-Session-Key`, model overrides; returns `202` with `run_id` and `queued`/`started` ([handler](https://github.com/NousResearch/hermes-agent/blob/d923a5eb487a17c0a68801bba9ef0f56c81040a8/gateway/platforms/api_server_runs.py#L620-L758)) | No Habi owner/conversation/budget fields; mapping is external |
| Idempotency | Durable SQLite `run_idempotency` table; unique `(scope, key)` inserted under `BEGIN IMMEDIATE`; fingerprint covers body + `X-Hermes-Session-Key`; replay returns the original run with `Idempotency-Replayed: true`; mismatch returns `409` ([store](https://github.com/NousResearch/hermes-agent/blob/d923a5eb487a17c0a68801bba9ef0f56c81040a8/gateway/platforms/api_server_run_idempotency.py), [reserve](https://github.com/NousResearch/hermes-agent/blob/d923a5eb487a17c0a68801bba9ef0f56c81040a8/gateway/platforms/api_server_runs.py#L638-L730)) | Scope is profile + API key, not Habi user. Two users sharing one key collide; Habi must namespace keys per owner. Retention is 24h; durable only when the SQLite path is usable |
| Event stream | SSE with monotonic `seq`, `Last-Event-ID`/`last_seq` replay, `replay.truncated` when the retained window starts later; in-memory `_RunStream` backlog ([stream](https://github.com/NousResearch/hermes-agent/blob/d923a5eb487a17c0a68801bba9ef0f56c81040a8/gateway/platforms/api_server_runs.py#L116-L160), [events handler](https://github.com/NousResearch/hermes-agent/blob/d923a5eb487a17c0a68801bba9ef0f56c81040a8/gateway/platforms/api_server_runs.py#L1064-L1155)) | No durable event log. Reconnect within the same process can replay; a process restart loses the stream. Habi must own durable events if replay across restart is required |
| Cancel | `POST /stop` sets `stopping`, sets a stop flag, calls `request_hard_interrupt`, reaps that run’s background processes, returns `{"status":"stopping"}`; terminal `cancelled` follows ([handler](https://github.com/NousResearch/hermes-agent/blob/d923a5eb487a17c0a68801bba9ef0f56c81040a8/gateway/platforms/api_server_runs.py#L1253-L1276)) | Cooperative: the source explicitly notes the executor thread may outlive the request. For a run delegated to a live Bot Chat owner, stop cancels the API run but cannot recall the owner’s turn ([source](https://github.com/NousResearch/hermes-agent/blob/d923a5eb487a17c0a68801bba9ef0f56c81040a8/gateway/platforms/api_server_runs.py#L864-L911)). “No further tokens billed” is **not** established |
| Steer | `POST /steer` only accepted while status is `running`; text is appended and delivered at the next tool boundary; if undelivered it returns as `pending_steer` on the terminal event ([handler](https://github.com/NousResearch/hermes-agent/blob/d923a5eb487a17c0a68801bba9ef0f56c81040a8/gateway/platforms/api_server_runs.py#L1219-L1251)) | Steering is text, but it does not itself widen tool policy; policy is server/profile-wide (see H-005). A 200 means queued, not consumed |
| Restart recovery | Run status is persisted in the idempotency store. If a nonterminal run’s owner PID is gone, `GET` rewrites it to `interrupted` with “The gateway restarted before this run settled.” ([source](https://github.com/NousResearch/hermes-agent/blob/d923a5eb487a17c0a68801bba9ef0f56c81040a8/gateway/platforms/api_server_runs.py#L394-L417)) | Transcript remains in SQLite, but the in-flight turn is not resumed and the SSE position is not restorable. Habi would have to reconcile a run to a terminal/interrupted state itself |
| Usage | Terminal status/event carries token usage from the agent’s session counters ([source](https://github.com/NousResearch/hermes-agent/blob/d923a5eb487a17c0a68801bba9ef0f56c81040a8/gateway/platforms/api_server_runs.py#L759-L766), [finish](https://github.com/NousResearch/hermes-agent/blob/d923a5eb487a17c0a68801bba9ef0f56c81040a8/gateway/platforms/api_server_runs.py#L986)) | Usage has `run_id`/`session_id`, not a Habi owner or budget record; Habi must attribute and persist |
| Ownership of run control | `_request_owns_run` compares the caller’s profile+key scope; foreign scope returns 404 ([source](https://github.com/NousResearch/hermes-agent/blob/d923a5eb487a17c0a68801bba9ef0f56c81040a8/gateway/platforms/api_server_runs.py#L1023-L1053)) | This is per key/profile, not per end user. It prevents cross-key access, not cross-user access within one key |

### 4.3 H-004 acceptance matrix

| Acceptance item | Status | Reason |
|---|---|---|
| Adapter contract defined for create/stream/cancel/steer/status/usage/restart | **Not met** | Candidate operations exist; no Habi adapter contract or mapping is written |
| Run creation with harness/session ID and ownership mapping | **Not met** | `run_id`/`session_id` exist; Habi owner mapping is external and untested |
| Ordered event stream with guarantees and gaps | **Partial (source only)** | `seq` + `Last-Event-ID` exist; no capture; no durable replay across restart |
| Cancel proves terminal and no further billing | **Not met** | Cooperative stop; billing behavior unverified and not guaranteed |
| Steering cannot expand permissions | **Partial (source only)** | Steer is text; tool policy is not per-request, so the claim depends on the actual server-side policy used in the test, not on H-006 acceptance |
| Restart recovery restores transcript and event position | **Not met** | Transcript durable; event stream is in-memory; nonterminal run becomes `interrupted` |
| Duplicate idempotency key yields one effective run | **Partial (source only)** | Durable reservation and replay exist; no test; scope must be per Habi user |
| Usage attributable to one user/conversation/run | **Not met** | Only run/session counters; no owner field |
| Adapter boundary documents replaceability | **Not met** | No adapter design yet |
| Known gaps explicit | **This note only** | Not an issue-accepted deliverable |

**Recommendation:** H-004 is **blocked**, first by the version/interface pin, then by H-003 acceptance. Do not start the spike. The API server is the most plausible interface, but it does **not** supply durable event replay, owner attribution, or a cancellation/billing guarantee; Habi would own those.

## 5. H-005 — multi-user Hermes isolation

### 5.1 Threat model relevant to the candidate

An authenticated Habi user, guessing IDs, replaying requests, or modifying payloads must not read, invoke, cancel, steer, delete, or fork another user’s session, run, memory, files, profile, or artifacts. A network position available to an application component must not bypass the API boundary. A successful single-user run proves nothing.

### 5.2 Source-inspected findings (rank A, conditional)

1. **One bearer principal per profile.** The API server’s `_check_auth` compares the request bearer token to one configured `API_SERVER_KEY` (or a profile-scoped key under `/p/<profile>/`) ([source](https://github.com/NousResearch/hermes-agent/blob/d923a5eb487a17c0a68801bba9ef0f56c81040a8/gateway/platforms/api_server.py#L1559-L1585)). There is no end-user identity, session cookie, or per-user token in this surface.
2. **Session IDs are selectors, not authorization.** `GET /api/sessions` lists the profile’s persisted sessions; `GET /api/sessions/{id}`, `/messages`, `PATCH`, `DELETE`, and `/fork` resolve by ID ([handlers](https://github.com/NousResearch/hermes-agent/blob/d923a5eb487a17c0a68801bba9ef0f56c81040a8/gateway/platforms/api_server.py#L3066-L3310)). The only gate inspected is the shared API key. A component that reaches Hermes with that key can read or delete any session ID in the profile, including one guessed or obtained from a log; whether a Habi user can reach that component depends on Habi’s backend.
3. **Run control is scoped to key/profile, not user.** `_run_idempotency_scope` hashes profile + expected API key ([source](https://github.com/NousResearch/hermes-agent/blob/d923a5eb487a17c0a68801bba9ef0f56c81040a8/gateway/platforms/api_server_runs.py#L360-L375)). Run IDs from another key/profile are denied, but all users behind one Habi backend key are the same principal.
4. **Memory is profile-scoped.** `MEMORY.md` and `USER.md` live under the profile home; the docs say memory is “scoped per profile by design” and warn that two writers sharing one home compound each other’s entries ([memory docs](https://github.com/NousResearch/hermes-agent/blob/d923a5eb487a17c0a68801bba9ef0f56c81040a8/website/docs/user-guide/features/memory.md)). There is no per-end-user memory file in the default local memory path. `X-Hermes-Session-Key` is a client-supplied memory-continuity scope, not an ownership check ([source](https://github.com/NousResearch/hermes-agent/blob/d923a5eb487a17c0a68801bba9ef0f56c81040a8/gateway/platforms/api_server.py#L1825-L1843)).
5. **Tool policy is profile/platform-wide.** The API server builds `enabled_toolsets` from `_get_platform_tools(config, "api_server")`, not from the requesting user ([source](https://github.com/NousResearch/hermes-agent/blob/d923a5eb487a17c0a68801bba9ef0f56c81040a8/gateway/platforms/api_server.py#L2374-L2409)). The documented `hermes-api-server` toolset drops only `clarify`, TTS, computer-use, and kanban; it keeps file, terminal, browser, code execution, memory, and the rest ([toolsets reference](https://github.com/NousResearch/hermes-agent/blob/d923a5eb487a17c0a68801bba9ef0f56c81040a8/website/docs/reference/toolsets-reference.md)). A shared profile therefore cannot give user A and user B different capabilities, and any prompt injection that reaches the agent sees the same tools.
6. **Profiles are logical isolation, not OS-user isolation.** One process per profile, or the multiplexing gateway, scopes config, secrets, `state.db`, sessions, memory, skills, and adapter lanes per profile. The multiplexing design states “profile A’s turns must never observe profile B’s state” ([multiplexing docs](https://github.com/NousResearch/hermes-agent/blob/d923a5eb487a17c0a68801bba9ef0f56c81040a8/website/docs/developer-guide/multiplexing-gateway.md)). That is a promising remediation shape, but it is still one UNIX user and one filesystem; a compromised application component with host file access is outside this boundary. It also multiplies profiles/processes and has not been tested under Habi’s deployment constraints.

### 5.3 H-005 acceptance matrix

| Acceptance item | Status | Reason |
|---|---|---|
| Two-user access matrix denies every cross-user resource | **Not met; unmediated shared-principal access is a design blocker** | Shared API key + ID-addressed sessions gives no Hermes owner predicate; whether Habi users can exploit it depends on backend authorization, which is not implemented or tested |
| No shared session/memory/file/artifact namespace reachable by ID | **Not met for default shared profile** | Session IDs are global within a profile; default memory is profile-wide. Habi must disable or isolate memory before this can pass |
| Harness IDs mapped server-side and insufficient for authorization | **Not met** | Habi would have to add this mapping; Hermes does not |
| API, queue, event stream, storage paths all covered | **Not met** | No queue or storage integration exists; only API source inspected |
| Failures recorded as launch blockers | **No failure recorded** | This note is research, not the H-005 test |
| Remediation decision before P1 exposure | **Not made** | Candidate options listed below; none accepted |
| Evidence reproducible, redacted, no credentials | **Not met** | No test run |

**Static conclusion (not runtime proof):** Hermes supplies **no end-user authorization** on the API-server surface. One shared profile is an unmediated shared principal: any caller that reaches Hermes with the profile key can use ID-addressed sessions, and the default memory is shared. That is a design-level blocker **for exposing Hermes directly or for treating profile sharing as isolation**.

This is not proof that Habi users can bypass Habi’s backend. The intended plan has the Habi backend as the sole Hermes client, so the whole design can still isolate users **if** the backend enforces ownership on every operation and disables or isolates Hermes memory/artifacts. H-005 must trace that backend authorization and memory path before any whole-design conclusion. Static inspection also does not establish that every shared-profile deployment fails: a deployment that never exposes Hermes, maps every ID server-side, and disables shared memory is a different shape and must be tested as such.

The separate ChatGPT Sign in with ChatGPT app path is evaluated in [the subscription-provider note](2026-10-21-subscription-provider-options.md); it does not change this Hermes API-server multi-user finding.

**Remediation candidates, none accepted:**

- **Profile or process per user**, with a distinct `API_SERVER_KEY` per profile and the backend as the only client. This uses documented profile isolation but adds operational cost and does not create an OS boundary.
- **Direct model adapter for P1**, dropping Hermes for the multi-user path. This avoids Hermes session/memory/tool state but loses harness behavior.
- **A segregated gateway in front of Hermes** that owns identity and maps every request to an owner-scoped harness instance. This is additional Habi code and must be tested, not assumed.

## 6. Decision summary

| Issue | Decision now | Blocking condition |
|---|---|---|
| H-003 | **No-go for direct external use; unaccepted** | Documented free tier rejected the external probe with 403 `FreeTierError`; no usable streaming/tool/long/usage evidence. Do not work around it |
| H-004 | **Do not start** | Version/interface pin; H-003 accepted; adapter contract; runtime evidence |
| H-005 | **Do not expose unmediated; default shared profile is not isolation** | H-002 and H-004 accepted; backend authorization trace; memory disable/isolation; two-user runtime matrix; remediation decision |

No issue is accepted, no phase gate advances, and no provider/harness is adopted.

## 7. Minimal safe local spike plan (proposed, not executed)

Guardrails: disposable local environment; loopback-only API server; no host mounts beyond a dedicated scratch directory; no production data; no real user prompts; separate synthetic users; secrets in an approved local store only; redact IDs and tokens; no public bind; no paid fallback; stop after acceptance evidence is collected.

1. **Pin version and interface (blocking).** The project is confirmed as `NousResearch/hermes-agent`. Record the version/commit, license, and interface in a short ADR. If v0.22.2 is chosen, pin `d923a5eb…` for the spike and re-check the tag. Do not proceed on an unpinned “latest”.
2. **Provider surface (H-003) — direct probe blocked.** The documented endpoint at `deepseek-v4.1-flash-free` returned 403 `FreeTierError` from this external client; do not repeat it as-is or work around it with headers, relays, alternate models, or retries. Any further provider work needs a separately authorized basis and must still disable unused auxiliary tasks and pin every used one (`compression`, `title_generation`, `vision`, `approval`, `skills_hub`, `mcp`, etc.) to a free/local model, or set `prefer_fast_model: false` and never name `opencode-zen` as an auxiliary provider with an empty model. Capture status/body and auxiliary-call logs, redact credentials, and keep main-chat fallback proof separate.
3. **Build a restricted local profile (spike guardrail, not H-006 acceptance).** Disable terminal, file, browser, code execution, MCP, and unrelated toolsets at the server config layer; keep only the minimum needed for the test. Verify with `/v1/toolsets` and a tool-request prompt. These restrictions are a safety guardrail for the lifecycle test; they are **not** H-006 evidence, and H-004 does not acquire an H-006 dependency. H-006 remains a separate P0 item.
4. **H-004 lifecycle script (same profile, two synthetic conversations).** Create with an idempotency key; stream and record `seq`; reconnect with `Last-Event-ID`; stop and record terminal status/usage; restart the process and query status/events; repeat the same key and assert one effective run; record which state Habi must own. Use a stub/echo provider for mechanics if H-003 is still blocked, clearly labelled as non-provider evidence.
5. **H-005 two-user probe.** First test the **unmediated** boundary: user A creates a session; user B, holding the same backend key, reads it by ID. This confirms the shared-principal behavior but is not a Habi-user bypass. Then test the **intended mediated shape** with a minimal backend shim that enforces owner checks on every API/event/artifact operation and disables or isolates Hermes memory. Attempt cross-user reads, writes, run control, memory reads, and artifact paths through that shim. Then test the candidate remediation: two profiles with distinct keys, separate memories, and separate sessions; attempt cross-profile ID reads and run control. Record deny/allow for every case. Do not use unguessable IDs as the only control.
6. **Decide.** If the shared-profile matrix fails and profile-per-user is too costly or still leaks through host paths, choose the direct adapter for P1. Do not expose Hermes until H-005 evidence is accepted.

## 8. Open questions that block acceptance

1. Which `NousResearch/hermes-agent` version/commit, license, and interface should Habi pin?
2. Does the intended deployment use the API server, TUI gateway, ACP, or an in-process library?
3. Does the built-in Hermes relay/header (`/zen/v1`, `x-opencode-session`) change the free-tier 403 policy, or is it also rejected? This is untested; do not assume an exception.
4. What are the chosen model’s context/output limits, tool/vision/streaming behavior, and quota-exhaustion response?
5. Can Habi guarantee no paid charge on exhaustion, and where is that enforced? Separately, can Habi prove that no auxiliary task selects the paid `gemini-3-flash` default, and where is that configuration checked?
6. Which Hermes state is authoritative for Habi: run status, transcript, event sequence, memory, or usage?
7. Is profile-per-user acceptable operationally, and does it meet the H-005 threat model including direct application-component access?
8. What is the exact adapter contract and capability policy that Habi will enforce outside Hermes?
9. Does Habi’s backend enforce owner checks on every Hermes session/run/event/artifact operation, and is Hermes memory disabled or isolated per user? Static Hermes inspection cannot answer this.

## 9. Sources

| Source | Use |
|---|---|
| [Issue #3](https://github.com/daryllmagsombol/habi-bot/issues/3) | H-003 outcome, prerequisites, acceptance |
| [Issue #4](https://github.com/daryllmagsombol/habi-bot/issues/4) | H-004 lifecycle checklist and acceptance |
| [Issue #5](https://github.com/daryllmagsombol/habi-bot/issues/5) | H-005 isolation checklist and acceptance |
| [README.md:152-166, 178-193, 293-303](https://github.com/daryllmagsombol/habi-bot/blob/main/README.md#L152-L166) | Security boundaries, planned runtime, open decisions |
| [H-001 design note](../specs/2026-10-21-poc-boundary-and-journeys-design.md) | Approved product baseline; unresolved Hermes isolation |
| [OpenCode Console Models](https://opencode.ai/v2/docs/console/models/) | Free model IDs, endpoint, privacy (retrieved 2026-10-21) |
| [`NousResearch/hermes-agent` v0.22.2](https://github.com/NousResearch/hermes-agent/tree/d923a5eb487a17c0a68801bba9ef0f56c81040a8) | Confirmed project; v0.22.2 is the proposed inspection baseline, not an adopted version |
| [Programmatic integration](https://github.com/NousResearch/hermes-agent/blob/d923a5eb487a17c0a68801bba9ef0f56c81040a8/website/docs/developer-guide/programmatic-integration.md) | ACP / TUI gateway / API server surfaces |
| [API server docs](https://github.com/NousResearch/hermes-agent/blob/d923a5eb487a17c0a68801bba9ef0f56c81040a8/website/docs/user-guide/features/api-server.md) | Bearer key, endpoints, streaming |
| [Security docs](https://github.com/NousResearch/hermes-agent/blob/d923a5eb487a17c0a68801bba9ef0f56c81040a8/website/docs/user-guide/security.md) | Approval, isolation claims, container boundary |
| [Memory docs](https://github.com/NousResearch/hermes-agent/blob/d923a5eb487a17c0a68801bba9ef0f56c81040a8/website/docs/user-guide/features/memory.md) | Profile-scoped memory, shared-home warning |
| [Profiles docs](https://github.com/NousResearch/hermes-agent/blob/d923a5eb487a17c0a68801bba9ef0f56c81040a8/website/docs/user-guide/profiles.md) | Per-profile config/memory/state |
| [Multiplexing docs](https://github.com/NousResearch/hermes-agent/blob/d923a5eb487a17c0a68801bba9ef0f56c81040a8/website/docs/developer-guide/multiplexing-gateway.md) | Profile-scoped secret/home/session isolation |
| [Toolsets reference](https://github.com/NousResearch/hermes-agent/blob/d923a5eb487a17c0a68801bba9ef0f56c81040a8/website/docs/reference/toolsets-reference.md) | `hermes-api-server` tool surface |
| [Session storage](https://github.com/NousResearch/hermes-agent/blob/d923a5eb487a17c0a68801bba9ef0f56c81040a8/website/docs/developer-guide/session-storage.md) | SQLite/WAL durability and lineage |
