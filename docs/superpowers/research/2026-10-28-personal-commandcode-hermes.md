# Personal CommandCode with pinned Hermes — source assessment

- **Status:** Documentation-only and **observed**; **pending remote issue reconciliation**. Owner chose their own CommandCode key as a **single-user POC assumption**, not a multi-user authorization or provider acceptance. H-003 remains open, and issue #3 and the board are unchanged. Publication of this three-file documentation unit is authorized.
- **Date:** 2026-10-28. No Hermes execution, installation, credential access, or provider request beyond the separately authorized and dated runs recorded below.
- **Prior evidence:** [CommandCode assessment](./2026-10-28-commandcode-byo-assessment.md) and [personal REST probes](./2026-10-21-subscription-provider-options.md). The prior HTTP 200s were direct REST, not Hermes interoperability.

## What the pinned source establishes

Hermes at `d923a5eb487a17c0a68801bba9ef0f56c81040a8` declares the `commandcode` chat provider, `COMMANDCODE_API_KEY`, the provider endpoint, and a default auxiliary model ([provider source](https://github.com/NousResearch/hermes-agent/blob/d923a5eb487a17c0a68801bba9ef0f56c81040a8/plugins/model-providers/commandcode/__init__.py#L73-L99)). This is a configuration surface, not proof of a working round trip. Avoid confusing Hermes' key variable with the differently named variable in CommandCode's headless CLI documentation.

**Default safety is insufficient for a bounded no-tool test:**

- Hermes' [API-server toolset](https://github.com/NousResearch/hermes-agent/blob/d923a5eb487a17c0a68801bba9ef0f56c81040a8/toolsets.py#L196-L199) includes powerful tools. A no-shell/no-browser configuration must be verified by inspecting the actual advertised tools, not merely by asking the model not to use them. The [toolset registry](https://github.com/NousResearch/hermes-agent/blob/d923a5eb487a17c0a68801bba9ef0f56c81040a8/toolsets.py#L383-L390) recognizes `all`/`*` for suppression, but plugin and MCP interactions need testing.
- The pinned [defaults](https://github.com/NousResearch/hermes-agent/blob/d923a5eb487a17c0a68801bba9ef0f56c81040a8/hermes_cli/config_defaults.py#L130-L139) include `api_max_retries: 3` and `auto_recovery_cycles: 5`. Title generation and background review are also enabled ([defaults](https://github.com/NousResearch/hermes-agent/blob/d923a5eb487a17c0a68801bba9ef0f56c81040a8/hermes_cli/config_defaults.py#L774-L811)); compression can trigger additional calls. These facts were checked directly in the pinned source. A simple prompt alone does not establish a one-request budget.
- Automatic auxiliary routing can discover other providers if the main route fails ([routing source](https://github.com/NousResearch/hermes-agent/blob/d923a5eb487a17c0a68801bba9ef0f56c81040a8/agent/auxiliary_client.py#L4676-L4703)). Preventing silent paid fallback requires validated configuration, isolated credentials, and checks of actual outgoing requests; do not assume an empty main fallback list controls every auxiliary path.
- CommandCode documents [zero-data-retention controls](https://commandcode.ai/docs/resources/zdr), but the built-in profile does not itself demonstrate that the required header is sent. Generic custom-header support is a possible mechanism, not verified CommandCode ZDR. The earlier probe omitted ZDR, so it does not demonstrate zero retention.
- [CommandCode pricing and limits](https://commandcode.ai/docs/resources/pricing-limits) should be checked on the owner's account before any paid call. Included-credit exhaustion and auto-reload behavior are not established by the earlier successful requests. Never assume a one-request test cannot incur a charge.

## Proposed next proof, not authorization

First design and separately authorize a **local stub test** with a dummy key and no vendor traffic. Capture actual client request counts, model and header names, and tool declarations without logging secrets or prompt contents. Check title/background/compression, retries/recovery, fallback paths, MCP/plugins, and ZDR header handling. A stub confirms only observed local behavior, not vendor retention, pricing, or a real Hermes–CommandCode round trip.

Only after that evidence, a separately approved synthetic live test could establish one Hermes round trip. Its request budget cannot be guaranteed from configuration alone; even one observed client POST does not establish vendor-side inference count or billing. Explicitly check the account's paid settings and obtain a fresh test authorization first.

Single-user use of the owner's own key does not resolve hosted multi-user terms, backend isolation, or H-005. Do not treat this note as gate acceptance, deployment permission, or permission to access a key.

## Local stub result — 2026-10-28

The owner subsequently authorized a temporary runtime install and loopback-only stub. Pinned Hermes was run with a dummy key, isolated home, restricted sandbox, disabled tools and auxiliary features, and `nemo-relay` excluded. Sandbox probes observed external TCP, UDP and DNS blocked, loopback stub permitted, and child-process restrictions inherited. No provider request or real credential was used.

- A successful **CLI one-shot** made **one chat POST**, with zero declared tools and zero reported auxiliary calls; it also made six loopback metadata probes. It returned the stub response successfully. This is not an API-server integration test.
- An induced HTTP 500 produced one chat attempt and no observed retry or fallback in that scenario. This is not proof for all errors or configurations.
- A benign configured custom header arrived at the stub; no ZDR header was sent. Neither vendor ZDR behavior nor retention was tested.
- Dependency hashes were enforced using the existing frozen lock export, but lock consistency with the project manifest was not revalidated: `uv export --locked` failed. The omitted relay and local endpoint alter runtime conditions, and relay-specific behavior and the real HTTPS metadata path were not exercised.

Raw sanitized request metadata, sandbox results, commands and limitations are retained outside the repository under the approved temp workspace at `hermes-d923a5eb/lane/evidence/REPORT.md`. The stub establishes only observed local behavior, not real provider interoperability, billing, or H-003 acceptance. A real request needs separate approval, including a deliberate spending and data-retention decision.

### ZDR-header follow-up

The owner selected required ZDR and included credits only, and confirmed auto-reload and on-demand top-ups were off with included credits available. A subsequent sandboxed dummy-key stub run observed `x-cmd-zdr: 1` on the chat POST, zero declared tools, and one reported chat call with no auxiliary calls. A separate simulated HTTP 422 also resulted in one observed chat POST and no observed retry or fallback. The stub received six and five additional local metadata probes respectively. The chat requests had no explicit maximum-token field, so a bounded live completion budget is **not yet established**.

This demonstrates header transmission in the local CLI configuration only. It does not prove the provider accepts or enforces ZDR, that real HTTPS follows the same path, or that credits cannot be consumed. No live request was authorized or sent. Additional artifacts are in the same temporary evidence directory (`requests-zdr-success.jsonl` and `requests-zdr-422.jsonl`).

### Output-token limit follow-up

The pinned source documents removal of user-facing output-cap settings ([provider documentation](https://github.com/NousResearch/hermes-agent/blob/d923a5eb487a17c0a68801bba9ef0f56c81040a8/website/docs/integrations/providers.md)). A sandboxed negative-control test set both `model.max_tokens: 128` and `HERMES_MAX_TOKENS=128`; the stub observed **no** `max_tokens`, `max_completion_tokens`, or `max_output_tokens` field. One chat POST carried the ZDR header and no tools. This shows those settings did not impose a 128-token cap; it does not establish a provider-side limit. Evidence: temporary `lane/evidence/output-cap-assessment.md` and `requests-cap128.jsonl`. No live call was made.

## Owner-authorized live probe — 2026-10-28

The owner authorized one synthetic personal-key Hermes chat attempt despite the absent output cap, requiring `x-cmd-zdr: 1` and included credits only. Auto-reload and on-demand top-ups were owner-confirmed off; billing was not independently inspected. A sandboxed Hermes CLI used a loopback guard that forwarded at most one chat POST to the official CommandCode endpoint; nine local metadata/probe requests were denied rather than forwarded. A first launch failed before dispatch because the sandbox denied its working directory; no provider request was made until the corrected launch.

At 11:58:54–11:58:58 UTC, the guard forwarded one non-streaming `deepseek/deepseek-v4-flash` chat POST with ZDR header, zero tools, and no output-token field; CommandCode returned HTTP 200 and Hermes returned `OK`. Hermes reported 851 input and 2 output tokens, one API call and zero auxiliary calls. Its cost status was **unknown**, not evidence of zero charge. The guard proves one forwarded client request, not the provider's internal inference count. The local key file was removed after use; deletion does not revoke the provider key.

This is one real **CLI** round trip through the guard, not an API-server integration or multi-user isolation test. The header was transmitted; vendor-side ZDR enforcement and actual retention were not independently verified. Relay was omitted and normal HTTPS metadata lookups were blocked. H-003 remains open. Sanitized evidence is outside the repository in `hermes-d923a5eb/lane/evidence/live-run-evidence.md` and `live-guard-events.jsonl`.

## Beam synthetic-only exception — 2026-10-28

The owner separately authorized up to three synthetic `reflection/beam:free` requests without ZDR, after being told the provider may retain prompts and outputs and use them for training. No user or private content was sent; the exception does not apply to real content, and it is a narrow synthetic-only privacy exception rather than a retention decision for any later use. [CommandCode pricing](https://commandcode.ai/docs/resources/pricing-limits) says Beam requests cost no credits while capacity lasts, but its provider may retain and train on prompts and Beam cannot run in a ZDR session. The provider's actual billing and retention were not independently verified.

Three guarded POSTs returned HTTP 200 without retry or tool execution:

1. **Hermes CLI non-streaming:** returned `OK`, no tools, one reported API call, zero auxiliary calls.
2. **Hermes CLI streaming:** SSE was relayed and Hermes returned `OK`, no tools, one reported API call, zero auxiliary calls.
3. **Direct API, not Hermes:** an inert fictional tool was declared; a response was returned but **no tool call** was observed. This does not prove tool-calling capability. The direct request specified `max_tokens: 128`, but provider enforcement was not verified.

The two Hermes requests had no output-token field. Hermes' [canonical usage](https://github.com/NousResearch/hermes-agent/blob/d923a5eb487a17c0a68801bba9ef0f56c81040a8/agent/usage_pricing.py#L75-L81) adds cached prompt tokens to uncached input and output: 617 + 256 + 24 = 897, and 615 + 256 + 26 = 897. Reasoning tokens are not added again. This reconciles Hermes' counters, not actual billing; the raw provider usage was not retained for those two responses. Cost status was unknown, not proof of zero charge. One guard forwarded at most three client POSTs; this is not a vendor-side inference or billing count. The local key file was removed, not revoked.

Evidence is retained outside the repository in `hermes-d923a5eb/lane/evidence/beam-run-evidence.md`. Neither CLI result establishes API-server isolation, exhaustion handling, vendor retention, or H-003 acceptance.

## Parallel local checks — 2026-10-28

- **Simulated exhaustion:** an isolated stub returned a fabricated HTTP 429 `insufficient_quota` error. The Hermes CLI displayed a billing/credits message, made one chat attempt, and showed no observed retry or automatic fallback. The message suggested adding credits or manually switching models. This is not a captured CommandCode exhaustion response and does not establish Habi's handling. Evidence: temporary `hermes-d923a5eb/quota-simulation-check/EVIDENCE.md`.
- **API server:** the core-only temporary environment lacked `aiohttp`; a later separately isolated copy received a hash-pinned eight-wheel closure. In an egress-restricted sandbox, a real loopback API listener rejected missing/incorrect bearer credentials, accepted the dummy key, and returned HTTP 200 for a synthetic stub-backed run with no tools advertised. `/health` was unauthenticated. This is one static gateway key, not per-user identity or Habi tenancy; SSE, concurrency and real provider traffic were not tested. Evidence: temporary `api-isolation-check/evidence/REPORT.md`.
- **Habi multi-user isolation:** not testable in the current foundation: `apps/backend/src/app.module.ts` wires the health controller, and `apps/backend/src/worker.module.ts` is empty. Authentication, owned resources, and a cross-user request path are not implemented. Standalone Hermes authentication is not Habi tenant authorization.

These checks used local stubs and dummy credentials; no provider calls or deliberate quota exhaustion. H-003 remains open, and none of these findings establishes H-005 isolation.

### API-server error simulation follow-up

In the isolated API-server lane, fabricated `insufficient_quota` and ordinary rate-limit HTTP 429 errors each resulted in one upstream stub chat request with no observed automatic retry or fallback under the tested configuration. **The `/v1/chat/completions` client response was HTTP 200 despite the upstream failure**, with `finish_reason: "error"` and `hermes.failed: true`; clients must inspect the response's failure fields rather than rely on HTTP status alone. The fabricated quota response through `/v1/runs` returned HTTP 202 at creation, then a polled `failed` run. A separate fabricated 422 `cmd_zdr_no_providers` with `x-cmd-zdr: 1` likewise surfaced as HTTP 200 plus an error finish and failed flag, with one stub call and no observed retry or fallback. The error copy classified the 422 as a malformed request, so it is not a reliable ZDR-specific user explanation.

The API response reported zero usage on these failed simulations; that must not be interpreted as proof that a real failed or ambiguous dispatch incurred zero usage or charges. The rate-limit error copy suggested adding a backup provider, but no automatic fallback was observed in the tested configuration. These were fabricated fixtures, not real CommandCode exhaustion or retention evidence, and do not demonstrate any Habi-side handler. Detailed observations: temporary `api-isolation-check/evidence/REPORT.md`, addenda 1–2.

**Implication for H-004:** the adapter contract must treat HTTP 200 with `finish_reason: "error"` / `hermes.failed: true`, and the `/v1/runs` 202-then-`failed` run shape, as failures rather than success; it must surface them to callers, must not auto-retry, fall back, or upgrade on them, and must not depend on vendor error copy for classification. The fabricated fixtures do not establish how a real CommandCode error looks.
