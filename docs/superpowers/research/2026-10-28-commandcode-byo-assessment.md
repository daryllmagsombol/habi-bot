# CommandCode per-user BYO assessment — H-003

- **Status:** Documentation-only and **observed**; **pending remote issue reconciliation**. CommandCode is the first of the owner's chosen providers to assess, not an accepted H-003 provider. Publication of this three-file documentation unit is authorized; issue #3 and the board are unchanged and H-003 stays open. No new inference, credential access, installation, vendor contact, or issue write was performed.
- **Checked:** 2026-10-28. This note supplements the [provider decision](./2026-10-28-h003-provider-decision.md) and [earlier personal GOAT transport evidence](./2026-10-21-subscription-provider-options.md).
- **Current direction:** a **single-user POC assumption** on the owner's own CommandCode key, with OpenCode and ChatGPT still intended and Cloudflare parked; the original free-Zen objective is a recorded no-go. The hosted per-user shape assessed below is **not** approved direction — it records the unresolved multi-user permission question. No multi-user permission is established, and nothing here accepts H-003.

## Terms and proposed use

The shape assessed here — a hosted application where each user authorizes their own CommandCode account and key, used only for that user's requests; no shared subscription, pooled key, or automatic paid fallback — is **not** current approved direction. It is recorded because it defines the permission question that must be answered before any multi-user use; today's direction remains the owner-only single-user POC.

The [CommandCode terms](https://commandcode.ai/terms) grant a **personal, non-sublicensable, non-transferable** license for the account holder's internal business or personal purposes. They restrict use for **time sharing, service bureau purposes, or the benefit of a third party**. These passages were independently checked on 2026-10-28. They do not explicitly address a user authorizing a hosted third-party application to hold and use their own key. Whether the proposed BYO design falls within the restrictions is **unresolved**; neither permission nor prohibition is established by this note.

The [Provider API documentation](https://commandcode.ai/docs/provider) describes OpenAI- and Anthropic-compatible access; [headless documentation](https://commandcode.ai/docs/headless) describes API keys in non-interactive environments. These support the general technical mechanism, not permission for Habi's specific hosted multi-user arrangement. Team plans and pooled seats must not be presumed to cover external users or override Habi's no-pooling rule.

## Evidence and risks

- The earlier GOAT probes returned HTTP 200 for personal API transport. They were not Hermes runs, did not prove multi-user permission, and did not prove zero data retention or actual billing.
- The pinned [Hermes CommandCode provider](https://github.com/NousResearch/hermes-agent/blob/d923a5eb487a17c0a68801bba9ef0f56c81040a8/plugins/model-providers/commandcode/__init__.py) declares the provider API endpoint and key environment variable. Per-user credential isolation and runtime behavior remain unproven; avoid assuming environment-based setup is safe for concurrent tenants.
- [Privacy policy](https://commandcode.ai/privacy) documents up to 30 days' default retention, with different terms for some free/promotional models. [Zero-data-retention documentation](https://commandcode.ai/docs/resources/zdr) describes a fail-closed option where available. The later personal Hermes probe transmitted the ZDR header using an explicit configuration; provider enforcement and retention were not independently verified. The earlier GOAT streaming probe omitted it.
- [Pricing and limits](https://commandcode.ai/docs/resources/pricing-limits) describes on-demand credits and spending outside subscription windows. Do not assume exhaustion prevents charges: Habi must surface user-authorized spending and avoid silent fallback or upgrades. Actual exhaustion response is not evidenced.
- Error handling is a separate gap: in the isolated Hermes API-server lane, **fabricated** upstream failures surfaced as HTTP 200 with `finish_reason: "error"`, not as a non-2xx status. Those were stubs, not CommandCode responses, but the shape is what H-004's adapter contract must handle (see the [personal note](./2026-10-28-personal-commandcode-hermes.md)).

## Draft question for CommandCode — not sent

> For a hosted application in which each user has their own CommandCode account and explicitly authorizes us to store their own scoped API key server-side, may we send Provider API requests solely for that user's own content and usage? No user consumes another user's subscription or credits, and we do not resell access. Does this arrangement comply with the personal-license and time-sharing/service-bureau restrictions? If not, is there an agreement that permits this specific per-user BYO arrangement? Please also clarify applicable retention, zero-data-retention controls, and what happens when the user's included credits are exhausted.

No vendor contact is authorized by this note. A reply, if sought by the owner, should be retained verbatim with date, plan, and relevant account details redacted. Further Hermes interop and safe error-handling evidence remain separate from permission; H-003 stays open.
