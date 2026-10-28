# H-003 Decision Note — Original Free-Zen Investigation Is a No-Go; Replacement Scope Pending

> **Direction update, 2026-10-28:** The owner subsequently chose their own CommandCode key for a **single-user POC assumption**, while keeping OpenCode and ChatGPT in the intended provider set; Cloudflare is parked. One real personal-key Hermes CLI round trip succeeded, and Beam synthetic-only streaming succeeded under a specific non-ZDR exception. See [personal CommandCode evidence](./2026-10-28-personal-commandcode-hermes.md). This update supersedes the earlier replacement-choice and test-authorization status below; it does not establish multi-user permission, accept H-003, or change the remote issue's original scope, and **remote reconciliation remains pending**.

- **Status as prepared on 2026-10-28:** H-003 remains **open and unaccepted**; remote issue reconciliation was pending. No criterion is waived, no P0 gate advances, and this note is not gate acceptance.
- **Date:** 2026-10-28. Documentation retrievals were performed on this date; older observations keep their original dates.
- **Scope:** H-003 only. It resolves the *original* OpenCode Zen free-model investigation and records the replacement-scope direction, without adopting a provider. Current provider direction is a **single-user POC assumption on the owner's own CommandCode key**; multi-user permission is **not** established for any provider.
- **Authority:** owner direction in the current session ("lets finish h-003") plus authorization to publish these decision/test notes. No new live test, credential access, install, inference, credential-store scan, or GitHub issue/board write was performed for this note beyond the observations dated below.
- **Related (publishable unit):** [2026-10-28 personal CommandCode with pinned Hermes](./2026-10-28-personal-commandcode-hermes.md), [2026-10-28 CommandCode per-user BYO assessment](./2026-10-28-commandcode-byo-assessment.md), [2026-10-21 provider and Hermes feasibility](./2026-10-21-provider-and-hermes-feasibility.md), [2026-10-21 subscription provider options](./2026-10-21-subscription-provider-options.md).
- **Citation convention:** unpublished historical research notes are identified by date and name without links; they are not included in this publication.

## 1. Current owner direction versus the remote issue scope

The remote issue still describes the **original** scope: pick an OpenCode Zen **free** model, evidence its limits/data handling/Hermes compatibility, and record a go/no-go. Local, later direction has moved:

| Item | Original remote scope (issue #3) | Current local direction (2026-10-28) |
|---|---|---|
| Provider objective | OpenCode Zen free model, zero cost | No single frozen scope; Cloudflare Workers AI is **parked** |
| Preferred in Hermes | Zen free models | **OpenCode, CommandCode, ChatGPT** — candidate intent only, not validated adoption |
| Access model | Owner/account access for a spike | **Single-user POC assumption**: the owner's own CommandCode key, used only by the owner |
| Multi-user permission | Not addressed | **Not established** for OpenCode, CommandCode, or ChatGPT; no pooled, shared, or platform-funded credential path is approved |
| Cloudflare Workers AI | Not contemplated | Parked as a candidate; the 2026-10-23 amendment and GLM note stay as history |

All of the above is **candidate intent, not adoption**. None of these providers is selected, approved, or production-ready, and no provider connection is implemented. The divergence is recorded so that neither the remote issue nor the local notes is silently rewritten to match the other; **reconciling it with the remote issue is pending** and is not performed by this note.

## 2. What is now conclusively established: free Zen is not usable in Hermes

The original free-provider outcome fails on two independent kinds of evidence, one observed and one official:

1. **Observed (2026-10-21):** one credentialed raw HTTP request to the documented free endpoint `https://opencode.ai/inference/openai/v1/chat/completions` for `deepseek-v4.1-flash-free` returned **HTTP 403** `FreeTierError` — "OpenCode's free tier can only be used from within OpenCode." No retry, no workaround, no usage returned ([provider note §3.4](./2026-10-21-provider-and-hermes-feasibility.md), [issue comment 6314361364](https://github.com/daryllmagsombol/habi-bot/issues/3#issuecomment-6314361364)).
2. **Official vendor documentation (retrieved 2026-10-28):** the [OpenCode Hermes harness page](https://opencode.ai/v2/docs/console/harnesses/hermes) states verbatim: "Hermes Agent includes OpenCode providers for pay-as-you-go and Go. It picks the right API for each paid or Go model. **Free-tier chat models require OpenCode and return HTTP `403` from Hermes.**" The same page lists only `opencode-zen` (pay-as-you-go) and `opencode-go` provider rows with `OPENCODE_ZEN_API_KEY` / `OPENCODE_GO_API_KEY`.

The second source closes the previously open question in [provider note §8 item 3](./2026-10-21-provider-and-hermes-feasibility.md) — whether Hermes' `/zen/v1` relay plus `x-opencode-session` header might produce a different policy result. The vendor says it does not: Hermes gets 403 on free-tier chat models. **No relay, header, alternative-model, or retry experiment should be attempted**, and none was attempted.

**Conclusion for the original objective:** free OpenCode Zen chat models are **not feasible for a Hermes-based Habi POC**. This is a conclusive negative feasibility result, not an unresolved question. It is also not a finding about paid OpenCode plans, whose multi-user permission remains unresolved (historical note, 2026-10-23 supported free provider paths §4).

## 3. Evidence that does *not* support a broader conclusion

| Evidence | What it does show | What it does not show |
|---|---|---|
| 2026-10-21 HTTP 403 `FreeTierError` | The documented free endpoint rejects a non-OpenCode external client | Not an auth failure; not proof the key/account is invalid; says nothing about paid plans |
| 2026-10-28 official Hermes page statement | Free-tier chat models are rejected from Hermes by policy | Not a runtime Hermes test; says nothing about `opencode-go`, Console pay-as-you-go, or `@opencode/sdk`/`client` entitlement |
| 2026-10-23 official CLI exit **HTTP 401 `provider.auth`** ("This API key has expired") | A local key was expired at that moment | **Separate from the 403:** it is a credential-expiry result, not an entitlement or policy result, and it neither confirms nor contradicts the free-tier rule (historical note, 2026-10-23 supported free provider paths §3.1) |
| 2026-10-22 CommandCode GOAT REST probes (non-streaming 200 `OK`; streaming 200 SSE to `[DONE]`) | Personal, single-operator **transport** works against the GOAT Provider API | **Not** Hermes runtime evidence, **not** a Hermes round trip, and **not** multi-user permission. GOAT's personal/non-transferable licence and time-sharing/service-bureau prohibitions are unresolved ([subscription note §5, §8–§9](./2026-10-21-subscription-provider-options.md)) |
| 2026-10-23 Cloudflare Workers AI native REST 200 | One request to one model on one account is technically compatible | Not Hermes interop; not multi-tenant permission; not capacity. The tested Llama model is blocked by Hermes' 64K context floor (historical note, 2026-10-23 Hermes–Cloudflare compatibility) |

### Observed API-server error shape — input to H-004

A local, isolated Hermes **API-server** lane (dummy key, stub upstream, egress-restricted sandbox) produced one shape that H-004 must handle explicitly: fabricated upstream failures surfaced to an OpenAI-compatible client as **HTTP 200** carrying `finish_reason: "error"` and `hermes.failed: true`, not as a non-2xx status. `/v1/runs` created a run with HTTP 202 and later reported it `failed` on polling.

- This is **stub-fabricated** error input (quota 429, ordinary 429, and a ZDR 422 `cmd_zdr_no_providers`), not a captured CommandCode exhaustion or ZDR response, and not evidence of vendor behavior.
- **H-004 consequence:** the adapter contract must inspect response failure fields rather than trust HTTP status alone, must not translate an error-in-200 into a silent success, and must not auto-retry, fall back, or upgrade on it. Error copy also misclassified the fabricated 422 as a malformed request, so text-based classification is unreliable.
- The fabricated responses reported zero usage; that is **not** proof that a real failed or ambiguous dispatch costs nothing. No Habi-side handler exists, and `apps/backend` still wires only the health controller.

Detailed observations are in the [personal CommandCode note](./2026-10-28-personal-commandcode-hermes.md); evidence files remain outside the repository.

## 4. Acceptance criteria — exact mapping

Issue #3 lists seven acceptance criteria. Status below is an **evidence mapping**, not an acceptance decision; only the owner can accept, waive, or close.

| # | Criterion | Status | Evidence | Limitation |
|---|---|---|---|---|
| 1 | Exact model ID and endpoint recorded with dated primary-source evidence | **Met** | `deepseek-v4.1-flash-free` at `https://opencode.ai/inference/openai/v1/chat/completions`, retrieved 2026-10-21 ([provider note §3.1](./2026-10-21-provider-and-hermes-feasibility.md), [issue comment 6313597072](https://github.com/daryllmagsombol/habi-bot/issues/3#issuecomment-6313597072)) | Dated 2026-10-21 only; the offer is documented limited-time and was not re-verified on 2026-10-28. The negative conclusion in §2 does not depend on the listing |
| 2 | Tool, vision, streaming, context, rate-limit support stated as verified, unsupported, or unknown | **Met (literal wording only)** | All five are recorded as **unknown/not tested** in the [§3.5 matrix](./2026-10-21-provider-and-hermes-feasibility.md) and the [issue comment 6314011642](https://github.com/daryllmagsombol/habi-bot/issues/3#issuecomment-6314011642) | The wording permits "unknown"; this establishes **no** capability. A replacement provider must supply real values, not unknowns |
| 3 | Exhaustion returns a recoverable error and does not trigger a paid provider | **Unmet / not exercised** | Never reached: the 403 is a policy rejection before quota accounting, and the page documents no exhaustion status/body ([provider note §3.2](./2026-10-21-provider-and-hermes-feasibility.md)) | No recoverable-exhaustion shape observed, and no no-paid-charge proof exists. This is the primary literal gap |
| 4 | Privacy and data-handling constraints documented in actionable language | **Partial** | Per-model terms are recorded (zero-retention: deepseek/glm/minimax/longcat; 30-day: beam; model-improvement: big-pickle, ll-alpha, exo, mimo; Nemotron trial-only/logged) ([provider note §3.1](./2026-10-21-provider-and-hermes-feasibility.md)) | No product/security acceptance. Material conflict unresolved: the [Terms](https://opencode.ai/legal/terms-of-service) say "If you are using the Services through an unpaid account, we may use Content to further develop and improve our Services," which does not reconcile with per-model zero-retention claims. Treat as blocking for user content, not settled |
| 5 | Test prompts and observed outputs attached without secrets or personal data | **Partial** | One synthetic prompt (`Reply with exactly OK.`) and the redacted 403 body are attached in the issue comment | No model output exists to attach. Attachments are public issue comments, not a versioned test-log artifact |
| 6 | Hermes-compatibility conclusion cites evidence, not a vendor claim alone | **Met (negative conclusion)** | Observed 403 from an external client (2026-10-21) plus the official Hermes harness statement (2026-10-28) plus static provider inspection ([provider note §3.3](./2026-10-21-provider-and-hermes-feasibility.md)) | No Hermes runtime was executed. The conclusion is "not compatible," so it does not claim an unverified capability. This does **not** create H-004 evidence |
| 7 | Clear go/no-go decision recorded for P0 planning | **Met locally; observed, remote reconciliation pending** | §2 and §7 of this note; [§3.5 matrix](./2026-10-21-provider-and-hermes-feasibility.md) first recorded no-go for direct external use on 2026-10-21 | Not reflected in issue #3 or Project #1; the remote issue still carries no decision. P0 planning reading this note sees a no-go for the original objective only |

**Net:** criteria 1, 2, and 6 are satisfiable, 4 and 5 are partial, and **3 is unmet**. The original investigation therefore ends as **no-go, with several literal criteria not satisfied** — the negative feasibility result is conclusive, the acceptance checklist is not. No acceptance is proposed.

## 5. Deliverables — exact mapping

| Deliverable | Status | Evidence | Limitation |
|---|---|---|---|
| Test log with request metadata, redacted responses, timestamps, and model ID | **Partial** | One request: model `deepseek-v4.1-flash-free`, endpoint above, window 2026-10-21T10:59:12Z–10:59:13Z, ~1.1 s, HTTP 403, redacted body, no retries/redirects/fallback ([issue comment 6314361364](https://github.com/daryllmagsombol/habi-bot/issues/3#issuecomment-6314361364)) | No successful response, no usage, no streaming/tool/long-prompt rows. Sanitized raw evidence was retained **outside** the repository by the research lane and is not linked from the issue |
| Short provider decision note linked from the issue | **Unmet on the issue** | This note is published in the repository as part of a three-file documentation unit; earlier notes were uncommitted | **Issue attachment/link has not happened.** Documentation publication does not satisfy the issue deliverable, and issue/board updates remain unauthorized |
| List of open questions that block production use | **Met locally** | [Provider note §8](./2026-10-21-provider-and-hermes-feasibility.md) plus §9 of this note | Local and repository documentation only; not posted to the issue |
| Confirmation that no credential appears in git, issue text, or logs | **Not verified** | The 2026-10-21 probe recorded that no secret was printed, sourced, or placed in a prompt; issue text contains no key | This is an **attestation, not a scan**. No repository history, issue-body, or log scan was performed for this note, and store/history scanning was explicitly out of scope. Do not record this deliverable as passed |

## 6. Why this note does not close or accept H-003

- Acceptance is an owner act. Nothing here is an owner approval, a criterion waiver, or an issue closure.
- Criterion 3 has no evidence at all, and criteria 4–5 are partial. Marking the investigation "no-go" answers the *feasibility* question; it does not satisfy the checklist.
- The replacement scope in §7 is **not** approved and does not retroactively satisfy the original free-provider outcome.
- The remote issue, Project #1 status, and README/board summaries are untouched and still divergent from these local notes; remote reconciliation is pending and is not performed here.

## 7. Recommendation: finish the original investigation as no-go, then decide the replacement

1. **Record the original objective as no-go** for a Hermes-based Habi POC on free OpenCode Zen. The 403 policy rejection plus the vendor's own Hermes statement make further free-tier probing pointless; repeating it, or working around it with headers/relays/alternate models, is out of scope.
2. **Do not treat the no-go as H-004 unblocking.** H-004 needs an *accepted* provider and a pinned Hermes version/interface ([provider note §4.3, §6](./2026-10-21-provider-and-hermes-feasibility.md)). A no-go on the original candidate supplies neither. Unblocking H-004 on a no-go would invert the gate and leave the adapter contract with no provider to target. Independently of any provider choice, H-004 must also design for the observed API-server error shape (§3 "Observed API-server error shape"), where an upstream failure arrives as **HTTP 200** with `finish_reason: "error"`.
3. **Respect the chosen replacement direction: OpenCode, CommandCode, and ChatGPT.** Choose one initial validation lane rather than reopen provider discovery. Sequencing one lane does not remove the other two from the owner's intended provider set.
4. **Keep paid fallback disabled, keep Cloudflare parked, and keep CommandCode/ChatGPT/OpenCode as candidate intent** until one provider's per-user path is approved and its terms/entitlement evidence is recorded.

## 8. Minimal decision needed for the replacement scope

The single decision that unblocks progress is narrow:

> **Which one provider, and which per-user approved hosted access path, may Habi evaluate next?**

This is the decision needed **before multi-user use**; it is not the current single-user POC. The owner-only POC runs on the owner's own key and does not answer it, and no answer is assumed here.

That decision has three parts:

| Part | What the owner must specify | Why it is the minimum |
|---|---|---|
| Provider | **One** of: paid OpenCode Console/Go, CommandCode GOAT/Provider, ChatGPT/OpenAI API (or an approved SIWC shape), or a revived Cloudflare lane | Picking one stops parallel free-tier exploration and gives H-004 a target |
| Per-user access path | How each Habi user authorizes **their own** access — API key or officially supported per-user sign-in — held server-side, owner-isolated, revocable | This is the only shape the recorded terms discussions leave open; shared or pooled credentials are excluded |
| Permission basis | The documented terms/entitlement evidence for that path, plus what written vendor confirmation would still be required | Multi-user permission, not transport, is the unresolved blocker in every paid lane |

Explicitly **not** part of this decision: a broad search for other providers, any shared/platform-funded key, any automatic paid fallback, any plan upgrade or payment method attached on a user's behalf, or any inference/credential test. Each of those would need its own approval.

Notes on the candidate lanes, recorded as evidence limits rather than recommendations:

- **OpenCode in Hermes implies a paid/keyed plan.** The Hermes page lists only pay-as-you-go and Go provider rows, and free-tier chat models 403 from Hermes. Whether a Habi backend serving other users fits OpenCode's "own internal use" and unattended-process clauses is unresolved; the `@opencode/sdk`/`client` free-tier entitlement is undocumented (historical note, 2026-10-23 supported free provider paths §4–§5).
- **CommandCode GOAT** has observed personal REST transport but no multi-user permission and no Hermes runtime evidence; written vendor/Enterprise approval is the stated prerequisite ([subscription note §5, §9](./2026-10-21-subscription-provider-options.md)).
- **ChatGPT/OpenAI**: one shared subscription is not permitted; the plausible multi-user shapes are a separately billed API key under the Services Agreement, or an approved per-user SIWC integration. Habi is not an approved SIWC app ([subscription note §11](./2026-10-21-subscription-provider-options.md)).
- **Cloudflare Workers AI** stays parked by current direction. The 2026-10-23 amendment, the native-REST result, and the GLM candidate note remain historical evidence; reviving that lane needs both a context-compatible model and Hermes interop evidence.

## 9. Open questions that block production use

1. Which of the three chosen providers should be validated first, and through which supported per-user access path? Documentation research can continue without credentials; live testing requires separate authorization.
2. For that provider, what documented terms or written confirmation permit a Habi backend to serve multiple users, each on their own account?
3. What are the chosen model's context/output limits, tool/vision/streaming behavior, and request/concurrency/quota figures? Distinguish documented, measured, unsupported, and unknown; do not invent a requirement to measure every value or silently accept material unknowns.
4. What is the observed exhaustion error shape, and where is "no automatic paid charge / no fallback / no upgrade" enforced and logged?
5. Can Hermes be configured with a pinned free or user-owned model for every auxiliary task, with tool restriction and credential isolation proved (not inferred)?
6. Which Hermes version/commit and interface are pinned for H-004, and does the chosen provider clear Hermes' 64K context floor?
7. Where is the authoritative per-user credential custody, rotation, revocation, and cross-user isolation design recorded, and is it implemented before any user credential is accepted?
8. Does any credential-appearance question (deliverable 4) require an actual scan, and under what authorization and scope?
9. How will the H-004 adapter surface the **observed HTTP 200 + `finish_reason: "error"`** API-server shape (and the HTTP 202-then-`failed` run shape) to Habi callers without inventing success, and which classification avoids relying on vendor error copy? Only stub-fabricated fixtures exist so far; a real CommandCode exhaustion shape remains unobserved.

## 10. Approvals: granted, not granted

| Item | State |
|---|---|
| Local documentation of this decision note | **Granted** by the current session's "finish h-003" instruction |
| Publishing and linking this decision and evidence | **Authorized**; issue reconciliation follows publication |
| H-003 acceptance, criterion waiver, or issue closure | **Not requested, not granted** |
| Replacement provider decision | **Open — owner decision required** (§8) |
| Any new provider/inference/credential test | **Not granted** — the 2026-10-28 live and Beam probes were separately authorized and are recorded in the [personal CommandCode note](./2026-10-28-personal-commandcode-hermes.md) |
| Credential-store, history, or log scan | **Not granted; not performed** |
| Install, Hermes run, or vendor contact | **Not granted here**; the temporary runtime install and Hermes runs were separately authorized and observed; no vendor contact was made |
| H-004/H-005/H-006 start | **Not unblocked** |

## 11. Limits of this note

- Only the seven issue criteria and four deliverables are mapped; no new acceptance criterion is added and none is reclassified as passed.
- The 2026-10-28 retrieval covers the OpenCode Hermes harness page. The OpenCode models page, terms, and Cloudflare pages were **not** re-retrieved today; older facts keep their original dates and may have changed. The §2 conclusion does not depend on the free-model listing.
- Observations are provider- and date-specific. A 403 for one external client shape, and a vendor statement about Hermes, do not establish behavior for other clients, plans, or dates.
- "No-go" here means the original free-Zen Hermes objective is not feasible on current evidence. It is not a judgment on paid plans, on other providers, or on Habi's product direction.
- No new inference, credential access, install, scan, GitHub write, or vendor contact was performed for this note. This is research, not legal advice.
- Writing scope was limited to this file and the two 2026-10-28 CommandCode notes; pre-existing working-tree changes (`README.md`, `package.json`, the subscription note, the object/context design, and the other untracked research notes) were left untouched and are not part of this publishable unit.
- The decision and its supporting evidence are **observed and recorded**; **remote issue reconciliation is pending**. No gate is accepted, no board or issue state is changed, and no vendor output is inferred beyond what the dated observations record.

## 12. Sources

| Source | Date / use |
|---|---|
| [Issue #3](https://github.com/daryllmagsombol/habi-bot/issues/3) | Original outcome, seven acceptance criteria, four deliverables; comments 6313597072, 6314011642, 6314056025, 6314361364, 6314818354, 6318533369 |
| [OpenCode Hermes harness](https://opencode.ai/v2/docs/console/harnesses/hermes) | Retrieved 2026-10-28; free-tier models require OpenCode and return 403 from Hermes; only pay-as-you-go/Go keys listed |
| [Provider and Hermes feasibility](./2026-10-21-provider-and-hermes-feasibility.md) | 2026-10-21 probe, §3.5 matrix, §4 Hermes lifecycle, §8 open questions |
| [Subscription provider options](./2026-10-21-subscription-provider-options.md) | GOAT personal API probe, multi-user terms, ChatGPT/SIWC limits |
| [Personal CommandCode with pinned Hermes](./2026-10-28-personal-commandcode-hermes.md) | Stub, live, Beam, and API-server observations dated 2026-10-28 |
| [CommandCode per-user BYO assessment](./2026-10-28-commandcode-byo-assessment.md) | Terms reading, retention/pricing, unsent vendor question |
| Historical notes cited by name only | 2026-10-23 supported free provider paths; 2026-10-23 H-003 provider scope amendment; 2026-10-23 Hermes–Cloudflare compatibility; 2026-10-23 Cloudflare Workers AI evaluation plan; 2026-10-28 Cloudflare GLM candidate. These are untracked local research, **not part of this publishable unit**, and are not linked relatively |
