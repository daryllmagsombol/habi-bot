# Subscription Provider Options — Preliminary Research

- **Status:** Public read-only research. No provider was adopted, no account was accessed, no credential was read, and no model/API call or billing operation was performed.
- **Date:** 2026-10-21
- **Scope:** CommandCode GOAT (first pass) and ChatGPT Plus / Codex (second pass), in that order. Both are subscription products; neither is a free-provider substitute.
- **Gate state:** Preliminary only. This note does not accept H-003, start implementation, or authorize multi-user traffic.

## Post-publication observation — CommandCode GOAT API probe (2026-10-22)

Two bounded synthetic Chat Completions requests were later made against the documented CommandCode Provider API with `deepseek/deepseek-v4.1-flash`, a local owner-provided key, and no tools or retries. The non-streaming request returned HTTP 200 with `OK` and 44 total tokens. The streaming request returned HTTP 200, 22 SSE events through `[DONE]`, and 107 total tokens, but consumed the 64-token completion budget as reasoning and returned no visible text.

The ZDR header was omitted from the streaming request at the owner's direction because it may affect price. This is therefore **personal-only transport evidence**, not zero-retention/no-training evidence, multi-user permission, or proof of included-credit/no-extra-charge billing. The vendor's documented default retention risk of up to 30 days applies. The rest of this note remains the dated 2026-10-21 terms and feasibility assessment.

## 1. Vendor and product identity

The vendor is **Langbase, Inc. d/b/a Command Code** ([Terms](https://commandcode.ai/terms), [Privacy](https://commandcode.ai/privacy)). The product is **Command Code**, a coding-agent CLI/desktop/IDE product with a separate **Provider API**. “GOAT” is a Command Code subscription plan, not a separate company or SDK.

This identity is unambiguous in the official terms and docs: the service is `commandcode.ai`, the API host is `api.commandcode.ai`, and the legal entity is Langbase, Inc.

## 2. GOAT plan and entitlements

Official pages conflict on the headline credit figure. The current Host connection was independently detected as GOAT by the official host plan tool on 2026-10-21, and that detection reports **$70 credits**, with **$14/5h** and **$35/week** windows. The tool result is **plan-tier evidence only**: it is not a balance, consumption total, quota, or permission, and the plan is not pinned.

| Item | Evidence | Source |
|---|---|---|
| Price | **$10/month** (pricing card: “$10/month + processing fee”) | [GOAT page](https://commandcode.ai/docs/plans/goat), [pricing](https://commandcode.ai/pricing) |
| Credits | Detected current Host plan: **$70**. Public marketing still says **$80 in credits** on the GOAT intro/pricing card; Pricing & Limits says **$70 of usage / $70 credits** | Host plan tool (2026-10-21, not pinned), [GOAT page](https://commandcode.ai/docs/plans/goat), [Pricing & Limits](https://commandcode.ai/docs/resources/pricing-limits), [pricing](https://commandcode.ai/pricing) |
| 5-hour cap | **$14 of usage** | [GOAT page](https://commandcode.ai/docs/plans/goat) |
| Weekly cap | **$35 of usage** | [GOAT page](https://commandcode.ai/docs/plans/goat) |
| Monthly cap | **$70 of usage** | [GOAT page](https://commandcode.ai/docs/plans/goat) |
| Marketing claim | “Unlimited coding on 30+ top open and closed models” | [GOAT page](https://commandcode.ai/docs/plans/goat) |

**Important:** “Unlimited” is contradicted by the same page’s metered 5-hour, weekly, and monthly credit caps. Treat the caps, not the marketing word, as the operative limit. For the current Host plan, use **$70** as the detected monthly allowance, not the $80 marketing figure; confirm the live balance/consumption separately in Billing/Usage.

**Do not sum the per-model allowance rows.** They are model-level allocations inside one shared plan pool, not independent credits. The published “requests / 5 hours / week / month” figures are illustrative estimates based on a typical agent request, not quotas or guarantees.

Top-ups are available at model cost, roll over, and are not subject to the rolling windows ([Pricing & Limits](https://commandcode.ai/docs/resources/pricing-limits)). The monthly allowance resets each billing cycle.

## 3. API access and billing relationship

GOAT has API access. The exact official statement is:

> “The GOAT plan has API access. You call the Provider API endpoints with your Command Code API key, and usage is metered against your GOAT credits and the models included above.”

([GOAT page — API support](https://commandcode.ai/docs/plans/goat))

This is **not** a separate API subscription. GOAT API calls draw down the same GOAT credits and are limited to the models included on GOAT. A separate **Provider** plan exists for pay-as-you-go production API traffic ($15/month + processing fee, then model rates), but it is not required to use the API on GOAT ([Provider API](https://commandcode.ai/docs/provider), [Pricing & Limits](https://commandcode.ai/docs/resources/pricing-limits)).

**Billing conclusion:** GOAT includes API access but not unlimited or free API usage. API calls and coding usage draw on the **same GOAT credit pool**; there is no evidence of a second per-token invoice separate from it. Top-ups/auto-reload are the overage path. The detected GOAT plan is not a separate API entitlement, balance, or permission. Exhaustion behavior is credit/window based, not a documented hard “free-tier” rejection.

## 4. API credentials, endpoints, and SDK

Official API surface ([Provider API](https://commandcode.ai/docs/provider)):

| Endpoint | Method | Format |
|---|---|---|
| `https://api.commandcode.ai/provider/v1/chat/completions` | POST | OpenAI Chat Completions |
| `https://api.commandcode.ai/provider/v1/responses` | POST | OpenAI Responses |
| `https://api.commandcode.ai/provider/v1/messages` | POST | Anthropic Messages |
| `https://api.commandcode.ai/provider/v1/models` | GET | Models list |
| `https://api.commandcode.ai/provider/v1/systemone` | POST | System One decisions |

- **Auth:** `Authorization: Bearer <token>` on any route; `x-api-key: <token>` for the Anthropic SDK on `/messages`.
- **Key creation:** Studio → API keys; the same key authenticates the CLI and the API ([Studio](https://commandcode.ai/docs/studio), [Provider API](https://commandcode.ai/docs/provider)).
- **CLI env var:** `COMMAND_CODE_API_KEY` for non-interactive/CI/Docker/scheduled use; the Provider API examples use the bearer token ([Studio](https://commandcode.ai/docs/studio)).
- **Naming mismatch:** Command Code’s CLI docs use `COMMAND_CODE_API_KEY`; the Hermes provider uses `COMMANDCODE_API_KEY`. They refer to the same kind of key but are different environment-variable names. Do not assume one is read by the other.
- **SDK:** no dedicated Command Code server SDK is documented. Official examples use the standard OpenAI SDK, Anthropic SDK, and AI SDK against the OpenAI/Anthropic-compatible endpoints ([Provider API](https://commandcode.ai/docs/provider)). A public CLI repository exists at [`CommandCodeAI/command-code`](https://github.com/CommandCodeAI/command-code), but it is the coding agent, not a documented provider SDK.

## 5. Terms: explicit permission vs silence

This is the decisive section for Habi’s multi-user product.

| Question | Finding | Classification |
|---|---|---|
| May a third-party OpenAI/Anthropic-compatible client call the API? | Yes. “Call Command Code's models from any OpenAI- or Anthropic-compatible client”; “Use any agent, anywhere. No lock-in.” | **Explicit permission** |
| May the API be used server-side / in CI / Docker / scheduled jobs? | Yes, the docs describe API keys for CI, Docker images, and scheduled jobs; the Provider API is described for production API traffic. | **Explicit permission** |
| Is use restricted to coding only? | No explicit coding-only clause was found. The plan is marketed as a coding plan, but the API docs say “any agent” and do not limit content to code. | **Silence / marketing emphasis, not an explicit prohibition** |
| May one GOAT account serve a multi-user general assistant? | No explicit permission. The terms grant a “personal, non-sublicensable, non-exclusive, non-transferable” license for “internal business or personal purposes,” and prohibit “time sharing or service bureau purposes or for the benefit of a third party.” | **No explicit permission; terms appear to prohibit the likely shape** |
| May the account be shared or used by multiple people? | Terms require one account per person and a non-transferable license; no seat-sharing permission was found. Team plans exist separately. | **Not permitted by the personal/non-transferable license; no explicit sharing grant** |
| May Habi proxy or resell the API? | Terms prohibit renting, leasing, selling, transferring, sublicensing, or reselling access, and prohibit time-sharing/service-bureau use. A backend proxy for the account holder’s own single-tenant app is different from a proxy service for others. | **Resale/redistribution explicitly prohibited; multi-tenant proxy likely prohibited** |
| May Habi replicate Command Code functionality? | Terms prohibit using the service to “replicate the functionality of the Company or its products.” | **Explicit prohibition** |

Exact terms: [Terms & Conditions](https://commandcode.ai/terms) — Temporary Use License, Accounts, Acceptable Use, Usage Restrictions.

**Conclusion:** A single-tenant internal integration where the GOAT subscriber is the operator/user is explicitly contemplated by the API docs. A **multi-user general assistant serving other people through one GOAT subscription is not explicitly permitted and likely falls inside the “service bureau / benefit of a third party / transfer access” prohibitions**. Do not treat “any agent anywhere” as multi-user authorization. Written vendor approval or an Enterprise/Team agreement is required before that shape.

This is a terms-risk assessment, not a legal opinion.

## 6. Quotas, context, streaming, tools, vision

| Item | Evidence |
|---|---|
| Quotas | GOAT 5-hour $14, weekly $35, monthly $70; monthly credits reset; top-ups exempt from windows ([Pricing & Limits](https://commandcode.ai/docs/resources/pricing-limits), [GOAT](https://commandcode.ai/docs/plans/goat)) |
| Rate limits | No numeric RPM/TPM published. “Rate limits built for production”; upstream 429 `rate_limit_error` with backoff ([Provider API](https://commandcode.ai/docs/provider)) |
| Context | Per model. Examples: DeepSeek V4.1 Flash 1M, GPT-5.6 1.1M, Claude Sonnet 5.5 1M, GLM-5.1 200K ([Pricing & Limits](https://commandcode.ai/docs/resources/pricing-limits#models)) |
| Streaming | Supported with `stream: true`; usage emitted at end of stream ([Provider API](https://commandcode.ai/docs/provider)) |
| Tools | “Tool arrays pass through as you send them. `function` and `custom` tools are executed by your client”; remote `type: "mcp"` tools rejected; with `x-cmd-zdr: 1`, only client-executed tools (`function`, `custom`, `local_shell`) are accepted ([Provider API](https://commandcode.ai/docs/provider)) |
| Vision | Text and images accepted; audio, file, and document parts rejected; model-specific vision support is not pre-gated ([Provider API](https://commandcode.ai/docs/provider)) |
| Free/promotional models | Exist, but some have different privacy terms; not suitable for private data without model-specific review ([Privacy](https://commandcode.ai/privacy), [Pricing & Limits](https://commandcode.ai/docs/resources/pricing-limits)) |

## 7. Data handling and retention

Official [Privacy Policy](https://commandcode.ai/privacy), last updated **October 7, 2026**:

- Command Code does **not** train its own models on prompts/source code and does not sell personal data.
- AI request content is retained for **up to 30 days** unless zero data retention is enabled or a different plan/agreement applies. “Sessions on free models may be shared with our data partners and used to train coding models.”
- `CMD_ZDR=1` (CLI) or `x-cmd-zdr: 1` (Provider API) enforces zero data retention and no prompt training, routes only through ZDR-capable upstreams, or **fails with 422 `cmd_zdr_no_providers`** rather than falling back.
- Some models lack a ZDR-capable upstream; the header can change which upstream serves the request and may cost more. Free/promotional models may run under different provider terms.
- Subprocessors include Anthropic, OpenAI, GitHub, Vercel, Cloudflare, OpenRouter, Supabase, Stripe, PostHog, Tinybird, and Axiom ([Privacy — Subprocessors](https://commandcode.ai/privacy)). Open-source models are routed across multiple upstreams; infrastructure is described as US/EU/Singapore.

**Implication for Habi:** a paid, ZDR-capable model with `x-cmd-zdr: 1` is the only defensible default. Free/promotional models are not suitable for user content. ZDR coverage must be verified per chosen model, and a 422 is a fail-closed outcome, not a retry-with-fallback signal. The detected GOAT plan does not change these privacy terms.

## 8. Hermes compatibility

The candidate Hermes source at the inspected commit has first-class CommandCode providers:

- `commandcode` — OpenAI Chat Completions, base URL `https://api.commandcode.ai/provider/v1`, env `COMMANDCODE_API_KEY` ([source](https://github.com/NousResearch/hermes-agent/blob/d923a5eb487a17c0a68801bba9ef0f56c81040a8/plugins/model-providers/commandcode/__init__.py)).
- `commandcode-anthropic` — Anthropic Messages, same key/base URL.
- Hermes’ provider docs explicitly say CommandCode “Works with GOAT/Pro/Max/Provider plans (not the $1 Go plan — no API access)” ([docs](https://github.com/NousResearch/hermes-agent/blob/d923a5eb487a17c0a68801bba9ef0f56c81040a8/website/docs/integrations/providers.md)).

Technical fit is good: exact base URL, OpenAI/Anthropic formats, function tools pass through, streaming supported. The blockers are commercial/terms, not protocol.

## 9. Assessment

**Technically:** GOAT is a viable Hermes provider for a **single-tenant internal** deployment. API access is explicitly included, credits meter the usage, the endpoint matches Hermes, tools/streaming are supported, and ZDR is available on eligible paid models.

**For Habi’s multi-user general assistant:** **not approved on current evidence.** The terms grant a personal, non-transferable license and prohibit time-sharing, service-bureau use, and use for a third party’s benefit. No official statement permits one GOAT subscription to serve multiple end users. The correct next step is a written vendor answer or an Enterprise/Team agreement, not a technical spike that treats silence as permission.

**For H-003 specifically:** GOAT is **not** a free provider and does not satisfy the Zen free-provider outcome. It is a paid subscription alternative that would need its own decision after the terms question is resolved.

## 10. Unresolved questions

1. Will Command Code give written permission for one GOAT subscription to back a multi-user general assistant, or is Team/Enterprise required?
2. Is the GOAT monthly credit **$70 or $80**? The official pages disagree; which value appears in Billing/Usage?
3. Are API calls and CLI coding usage drawn from the same credit pool and the same 5-hour/weekly windows?
4. What are the actual numeric rate limits (RPM/TPM/concurrency), and what is the 429 body/Retry-After behavior?
5. Which GOAT models support function/tool calling reliably, and is tool support identical across OpenAI and Anthropic endpoints?
6. Does `x-cmd-zdr: 1` work for the chosen model/upstream, and does it change price or model routing?
7. Does the “automated tools … automated searches or requests” clause apply to API traffic, or only website scraping? Get this clarified in writing.
8. What are the seat/sharing rules for a Team plan, and do they permit a backend service used by many end users?

## 11. ChatGPT Plus / Codex

### 11.1 Product and entitlement facts

| Item | Official finding | Source |
|---|---|---|
| ChatGPT Plus price | **$20/month, billed monthly** | [What is ChatGPT Plus?](https://help.openai.com/en/articles/6950777-what-is-chatgpt-plus) |
| Codex on Plus | “Codex is included across ChatGPT plans, including Free and Go.” Plus has Codex on web, CLI, IDE, and iOS; Codex Cloud is available to eligible Plus accounts, subject to rollout/workspace settings. | [Using Codex with your ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan), [Codex pricing](https://learn.chatgpt.com/docs/pricing) |
| Plus Codex limits | Estimated **5–45 local messages/5h** for GPT-6 Astra, **15–160** for GPT-6.1 Sol, **15–150** for GPT-6 Sol, **350–3,000** for GPT-6 Luna; these are “not fixed message limits”; weekly limits may also apply. | [Codex pricing](https://learn.chatgpt.com/docs/pricing) |
| API included? | **No.** “API usage is separate and billed independently.” | [What is ChatGPT Plus?](https://help.openai.com/en/articles/6950777-what-is-chatgpt-plus) |
| Billing systems | “ChatGPT and the API platform have separate billing systems.” “API usage is billed separately from your ChatGPT subscription.” | [Managing billing](https://help.openai.com/en/articles/9039756-managing-billing-for-chatgpt-and-the-api-platform) |

**Do not conflate “Plus includes Codex” with “Plus includes API credits.”** They are different products and billing systems.

### 11.2 Codex auth paths and the billing boundary

OpenAI documents two Codex sign-in methods ([Authentication](https://learn.chatgpt.com/docs/auth)):

1. **Sign in with ChatGPT** — “for subscription access”; uses the ChatGPT plan’s Codex allowance/credits.
2. **Sign in with an API key** — “for usage-based access”; “uses standard API pricing instead of included ChatGPT plan credits.”

Supported local clients for Codex itself are the **ChatGPT desktop app, Codex CLI, and IDE extension**; Codex Cloud requires ChatGPT sign-in. SIWC separately approves other apps, so this list is not the whole universe of plan-using clients. Separately, **Codex access tokens are an Enterprise feature**: “In ChatGPT Enterprise workspaces, admins can grant the access token permission…” They are “intended for trusted scripts, schedulers, and private CI runners,” and “For general OpenAI API calls, continue to use Platform API keys.” They are **not** the Plus OAuth path and do not authorize general app traffic.

**API is a separate product and bill.** “ChatGPT and the API platform have separate billing systems”; Plus does not include API credits.

### 11.3 Sign in with ChatGPT (SIWC) — the supported BYO-plan path

OpenAI explicitly supports using a ChatGPT plan in **participating apps and sites**, distinct from both the Codex CLI and the API:

- “If you have a Go, Plus, or Pro plan, you can also choose to use your ChatGPT plan for AI requests in participating commercial apps and sites that support this feature.”
- “Anyone can sign in to participating apps and sites with ChatGPT, but the option to use your ChatGPT plan … is only available with Go, Plus, and Pro.”
- “You can then choose whether to let that app or site use your ChatGPT plan.”
- “Using your ChatGPT plan does not by itself give the app or site access to your ChatGPT conversations or memories, and it does not share an OpenAI API key.”
- “An app limit is a cap, not a separate pool of usage.”

([Using your ChatGPT plan in other apps and sites](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites).)

**Hermes is explicitly listed.** The official partner directory’s “Apps with ChatGPT plan usage” list (retrieved 2026-10-21) includes **Hermes Agent** (alongside Amp Code, Conductor, Dactyl, Devin, Hyperagent, Kilo Code, Lovable (coming soon), Notion, Vercel, Vorflux, and Warp). The same page has separate lists: “Apps with sign-in only” (Airtable, Canva, GitLab, HubSpot, Supabase) and “Open-source integrations” (OpenClaw, OpenCode, Pi, T3) ([Sign in with ChatGPT partners](https://learn.chatgpt.com/docs/sign-in-with-chatgpt#partners)). This is the corrected finding: Hermes is not an unsupported third-party client.

**Habi is not listed.** Habi does not appear in the directory as retrieved on 2026-10-21, so Habi has no inherited approval or client ID.

**Developer path.** SIWC plan usage is documented for “open-source and locally hosted apps”; “If you’re interested in offering it in a paid or remotely hosted app, complete the interest form.” The plan-usage flow:

- requests permission “to use the user’s ChatGPT plan for eligible Responses API requests”;
- uses `POST https://api.openai.com/v1/responses` with the OAuth access token — explicitly “do not point it at ChatGPT’s `backend-api` endpoints”; no separate SIWC SDK was identified in the fetched material, so this is a direct Responses API integration;
- requires `store: false` and `stream: true`;
- limits models to the signed-in account’s catalog;
- rejects unsupported fields and hosted tools (including `background`, `conversation`, `max_output_tokens`, `temperature`, image generation, file search, Code Interpreter, native computer use, hosted MCP/connectors, and `tool_search`).

([SIWC open-source overview](https://developers.openai.com/siwc/token-sharing-open-source), [models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference), [preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations), [commercial interest form](https://openai.com/form/sign-in-with-chatgpt-interest/).)

No explicit coding-only limitation was found in the SIWC materials; they describe “AI requests,” not a code-only workload. That does not make general-chat Habi eligible automatically — app approval and the Responses API restrictions still apply.

**This is not the same as one owner sharing an account.** SIWC is explicitly **per end user**: each user signs in with their own ChatGPT account and chooses whether that app may use their plan. One owner’s subscription made available to all users remains prohibited by the consumer Terms. The distinction is **each user authorizes their own allowance** vs **one account’s allowance is shared across users**.

### 11.4 Terms: account sharing, resale, and multi-user service

When Codex is used with a ChatGPT account, the **ChatGPT Terms of Use** apply ([Help — Terms for using Codex](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan)). The consumer Terms, effective **January 1, 2026**, state:

- “You may not share your account credentials or make your account available to anyone else and are responsible for all activities that occur under your account.”
- You may not “Modify, copy, lease, sell or distribute any of our Services.”
- You may not “Automatically or programmatically extract data or Output.”
- You may not “circumvent any rate limits or restrictions or bypass any protective measures or safety mitigations.”

([OpenAI Terms of Use](https://openai.com/policies/row-terms-of-use/).)

The **OpenAI Services Agreement**, effective **January 1, 2026**, governs the API/enterprise path and states:

- “Customer will not share Account access credentials or individual login credentials between multiple users.”
- “Customer may not resell or lease access to its Account or any End User Account.”
- End Users may include the Customer’s employees, consultants, **customers**, agents, representatives, students, or others authorized to use the Services through the Customer’s Account.
- Customers may not “buy, sell, or transfer API keys” with third parties.

([OpenAI Services Agreement](https://openai.com/policies/services-agreement/).)

**Classification:**

| Shape | Finding |
|---|---|
| One person using their own ChatGPT Plus account in an approved SIWC app (including Hermes Agent) | **Supported BYO-plan path**, subject to that app’s own plan/feature availability and the consumer Terms. |
| Each Habi user authorizing their own ChatGPT plan in an approved Habi SIWC integration | **Potential supported path**, but only if Habi is accepted as an SIWC app; remote/paid hosting requires the commercial interest/approval route. Not established. |
| One ChatGPT Plus account backing Habi for all end users | **Not permitted.** This makes the account available to others; SIWC is per-user authorization, not one shared allowance. |
| Habi backend using a ChatGPT/Codex OAuth token outside an approved SIWC integration as a general API | **No documented permission.** Approved SIWC plan usage must use SIWC’s Responses endpoint; general API use requires an API key. |
| Habi backend using an OpenAI API key under the Services Agreement | **Documented multi-user/developer path**, subject to API billing, Usage Policies, End User authorization, and legal review. The backend holds the key; it is not shared with end users. |
| Codex Enterprise access tokens for general app traffic | **No.** Enterprise tokens are for trusted scripts/schedulers/private CI, not Plus OAuth or general API. |

### 11.5 Hermes SIWC support: explicit, but not transferable to Habi

The official partner directory explicitly lists **Hermes Agent** under “Apps with ChatGPT plan usage” ([partners](https://learn.chatgpt.com/docs/sign-in-with-chatgpt#partners)). That is official support for Hermes as an app, not a generic third-party OAuth grant.

The inspected `openai-codex` provider uses:

- `auth_type="oauth_external"`, `env_vars=()`;
- base URL `https://chatgpt.com/backend-api/codex`;
- API mode `codex_responses`.

([Hermes provider source](https://github.com/NousResearch/hermes-agent/blob/d923a5eb487a17c0a68801bba9ef0f56c81040a8/plugins/model-providers/openai-codex/__init__.py).)

That provider path is **not** the SIWC plan-usage endpoint: SIWC docs require `https://api.openai.com/v1/responses` and explicitly say not to use ChatGPT `backend-api` endpoints. Hermes may use different internal paths for different surfaces; the inspected provider alone does not establish which flow backs the partner listing. No runtime claim is made.

**Habi cannot inherit Hermes’s client ID, approval, or partner status.** If Habi wants BYO-plan usage, it needs its own SIWC registration/approval (OSS/local route or commercial interest form), and its app must fit the Responses API restrictions. A wrapper that merely exposes Hermes under Habi is a different app and is not automatically covered.

### 11.6 Privacy and data handling

OpenAI distinguishes consumer and business/API handling ([How OpenAI handles data in consumer services](https://help.openai.com/en/articles/7039943-how-openai-handles-data-in-consumer-services)):

- Consumer ChatGPT: “We may use content submitted to ChatGPT and our other services for individuals to improve model performance,” depending on settings.
- Business/Enterprise/Edu/Healthcare and the **API Platform**: “By default, OpenAI does not use content … to improve its models”; organizations can opt in where available.
- Codex with ChatGPT sign-in follows the ChatGPT workspace’s permissions, RBAC, retention, and residency settings; API-key use follows the API organization’s retention/data-sharing settings ([Codex authentication](https://learn.chatgpt.com/docs/auth)).

SIWC plan usage is still a consumer-plan path: it does not give the app access to ChatGPT conversations or memories, but it does not turn the user’s plan into a business/API data-processing agreement. For Habi’s user content, the API/business path remains the appropriate data regime unless a commercial SIWC agreement says otherwise.

### 11.7 Feasibility for Habi

| Shape | Feasible? | Conditions |
|---|---|---|
| Personal-only POC, one operator, own ChatGPT Plus, Hermes Agent | **Supported app path** (Hermes is listed for plan usage), subject to Hermes’ actual flow and plan limits. | One human, own account, no account sharing, no public exposure. Do not extract tokens or automate login. |
| Habi multi-user with each user authorizing their own ChatGPT plan | **Potential, not established.** | Habi must be accepted as an SIWC app; remote/paid hosting needs the commercial interest/approval route. General-chat use is not explicitly excluded, but must fit Responses API restrictions and OpenAI terms. |
| Habi multi-user using one ChatGPT Plus account for everyone | **No.** | Consumer Terms prohibit making the account available to others. SIWC is per-user, not a shared allowance. |
| Habi multi-user using OpenAI API | **Documented developer path**, subject to contract. | Separate API billing; server-side API key not shared with end users; Services Agreement, Usage Policies, End User terms, privacy/DPA, and legal review. |
| Habi multi-user using Codex Enterprise access tokens | **No for general app traffic.** | Enterprise-only trusted scripts/schedulers/private CI; not Plus OAuth. |

### 11.8 ChatGPT/Codex open questions

1. Is Habi eligible for SIWC as a commercial/remotely hosted app? What are the approval criteria, and does general-chat use qualify?
2. If Habi is open-source but remotely hosted, does it use the OSS/local path or the commercial interest path? The docs route paid/remotely hosted apps to the interest form.
3. Can Habi’s general-chat flow be implemented within SIWC’s Responses API restrictions (no `background`, `max_output_tokens`, `temperature`, hosted tools, file search, etc.)?
4. Does Hermes Agent’s partner listing cover only the Hermes app, or can an approved integration use Hermes as a component? No transfer of client ID/approval is documented.
5. Which OpenAI API agreement/tier is required for Habi’s multi-user product, and what DPA/retention/residency terms apply?
6. Do OpenAI Usage Policies or End User terms impose additional constraints on Habi’s end users and content?

## 12. Comparison and recommendation

| Dimension | CommandCode GOAT | ChatGPT Plus / Codex |
|---|---|---|
| Plan type | Paid coding subscription with explicit API access | Personal ChatGPT subscription; Codex included; API not included; approved SIWC apps can use a user’s plan |
| API billing | GOAT credits meter API usage; no separate API subscription | API is separate and independently billed; Plus credits do not carry over |
| Third-party client use | Explicitly permits any OpenAI/Anthropic-compatible client | Approved SIWC apps explicitly permitted; Hermes Agent is listed; unapproved apps are not covered |
| Server-side use | Explicitly contemplated (CI/Docker/scheduled) | API yes; SIWC remote/paid hosting requires commercial approval |
| Coding-only restriction | No explicit clause, though marketed as coding | SIWC is framed for “AI requests,” not coding-only; Codex itself is coding-focused |
| Multi-user | No explicit permission; terms prohibit service-bureau/third-party benefit | Per-user BYO plan possible in approved app; one account shared across users prohibited; API/enterprise is the standard multi-user path |
| Privacy | Paid ZDR-capable model + `x-cmd-zdr: 1`; default 30-day retention | Consumer plan path; conversations/memories not shared with app; API/business data terms differ |
| Habi fit | Single-tenant internal possible; multi-user not approved | Personal POC via Hermes possible; Habi multi-user needs SIWC commercial approval or OpenAI API/enterprise |

**Recommendation:**

1. **For Habi’s multi-user product, there are two legitimate paths, neither automatic:** (a) the **OpenAI API** under the Services Agreement/enterprise terms, separately billed with a server-side key; or (b) an **approved SIWC commercial integration** where each end user authorizes their own ChatGPT plan. The latter is a potential BYO-subscription path, not an established entitlement for Habi. One shared ChatGPT account for all users remains prohibited.
2. **For a personal-only POC,** Hermes Agent is explicitly listed for ChatGPT plan usage, so a one-operator POC is a supported app shape subject to Hermes’ actual flow and plan limits. CommandCode GOAT is the clearer single-tenant API option, but its multi-user terms remain restrictive.
3. **For H-003,** neither option is a free provider. CommandCode GOAT is paid and metered; ChatGPT Plus does not include API credits. Neither satisfies the Zen free-model outcome.
4. Do not extract OAuth tokens, automate login, proxy Codex/ChatGPT, or reverse-engineer the clients. Do not use Hermes’s partner listing/client ID as Habi’s authorization; Habi would need its own SIWC approval.

## 13. Sources

| Source | Use |
|---|---|
| [Command Code GOAT plan](https://commandcode.ai/docs/plans/goat) | Price, credits, usage caps, API support, model list |
| [Command Code Pricing & Limits](https://commandcode.ai/docs/resources/pricing-limits) | Plan comparison, credits, windows, model context/pricing |
| [Command Code pricing](https://commandcode.ai/pricing) | GOAT pricing card and Provider plan |
| [Command Code Provider API](https://commandcode.ai/docs/provider) | Endpoints, auth, plan eligibility, streaming, tools, ZDR, rate-limit errors |
| [Command Code Studio](https://commandcode.ai/docs/studio) | API key creation and CI/env usage |
| [Command Code Terms](https://commandcode.ai/terms) | License, account, acceptable use, service-bureau/resale restrictions |
| [Command Code Privacy](https://commandcode.ai/privacy) | Retention, training, ZDR, subprocessors |
| [Command Code Security](https://commandcode.ai/docs/resources/security) | Local storage, permissions, network/file access |
| [`CommandCodeAI/command-code`](https://github.com/CommandCodeAI/command-code) | Public CLI repository, not a provider SDK |
| [Hermes CommandCode provider](https://github.com/NousResearch/hermes-agent/blob/d923a5eb487a17c0a68801bba9ef0f56c81040a8/plugins/model-providers/commandcode/__init__.py) | Exact Hermes integration at pinned commit |
| [Hermes provider docs](https://github.com/NousResearch/hermes-agent/blob/d923a5eb487a17c0a68801bba9ef0f56c81040a8/website/docs/integrations/providers.md) | GOAT/Pro/Max/Provider plan compatibility statement |
| [What is ChatGPT Plus?](https://help.openai.com/en/articles/6950777-what-is-chatgpt-plus) | Plus price and “API usage is separate” |
| [Using your ChatGPT plan in other apps and sites](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites) | SIWC plan eligibility, per-user choice, app limits, commercial interest |
| [Sign in with ChatGPT partners](https://learn.chatgpt.com/docs/sign-in-with-chatgpt#partners) | Official partner directory; Hermes Agent listed under plan usage |
| [SIWC developer overview](https://developers.openai.com/siwc/token-sharing-open-source) | OSS/local plan-usage flow, client ID, commercial interest routing |
| [SIWC models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) | Responses endpoint, model catalog, streaming, backend-api warning |
| [SIWC preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) | Unsupported fields/tools and response constraints |
| [SIWC commercial interest](https://openai.com/form/sign-in-with-chatgpt-interest/) | Commercial partner application route |
| [Managing billing for ChatGPT and the API platform](https://help.openai.com/en/articles/9039756-managing-billing-for-chatgpt-and-the-api-platform) | Separate billing systems |
| [Using Codex with your ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan) | Codex inclusion, limits, sign-in, consumer Terms |
| [Codex pricing](https://learn.chatgpt.com/docs/pricing) | Plus Codex availability and estimated limits |
| [Codex authentication](https://learn.chatgpt.com/docs/auth) | ChatGPT vs API-key auth, supported clients, access-token scope |
| [OpenAI Terms of Use](https://openai.com/policies/row-terms-of-use/) | Consumer account-sharing, resale, automated-extraction, circumvention clauses |
| [OpenAI Services Agreement](https://openai.com/policies/services-agreement/) | API/enterprise account, credential-sharing, resale, API-key clauses |
| [OpenAI data handling](https://help.openai.com/en/articles/7039943-how-openai-handles-data-in-consumer-services) | Consumer vs business/API model-improvement defaults |
| [Hermes openai-codex provider](https://github.com/NousResearch/hermes-agent/blob/d923a5eb487a17c0a68801bba9ef0f56c81040a8/plugins/model-providers/openai-codex/__init__.py) | OAuth-external provider, no API key, Codex base URL |
