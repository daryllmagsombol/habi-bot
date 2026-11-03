# H-003 — CommandCode single-user scope acceptance

- **Status:** Owner-accepted decision record, 2026-11-03. This closes the *scope* question for a single-user POC only. It does **not** establish multi-user permission, provider billing behavior, or a P0 exit gate.
- **Phase:** P0 — Feasibility (H-003).
- **Supersedes:** the original "OpenCode Zen free model" objective, which is a recorded no-go.
- **Authority:** Owner instruction on 2026-11-03 to accept the replacement scope and authorize the provider-evidence path.

## 1. Decision

**GO for a single-user POC using the owner's personal CommandCode key. NO-GO for any multi-user or shared-key use until CommandCode provides written permission under an appropriate plan or agreement.**

The POC path is:

- One user (the owner), one key, personal account.
- Hermes as harness behind a replaceable adapter, with ZDR requested when the selected model supports it.
- No automatic paid fallback; no silent retry after an ambiguous dispatch.
- No platform-funded access for any other person.
- Synthetic content only on any non-ZDR model.

## 2. Evidence base (already recorded)

| # | Evidence | Result |
|---|---|---|
| 1 | Pinned Hermes CLI request to CommandCode `deepseek/deepseek-v4-flash` with `x-cmd-zdr: 1` | HTTP 200, body `OK`; no tools; no observed auxiliary calls |
| 2 | Three synthetic `reflection/beam:free` requests (Hermes non-streaming, Hermes streaming, direct API inert tool declaration) | HTTP 200 each; no tool call issued; ZDR off under the synthetic-only exception |
| 3 | Local Hermes stub battery | One no-tool request per run; ZDR header transmitted; no observed retry/fallback on fabricated 429/422/500 |
| 4 | Local Hermes API-server stub | Bearer authentication enforced; simulated upstream errors surface as HTTP 200 with `finish_reason: "error"` and `hermes.failed: true`; run later reports `failed` |
| 5 | Usage reconciliation | Cached prompt tokens are reported separately from uncached input and included in the total; Hermes figures reconcile with provider figures |
| 6 | Provider terms review | Personal, non-transferable licence; service-bureau and third-party-benefit restrictions unresolved for multi-user |

Sources: [provider decision](./2026-10-28-h003-provider-decision.md), [personal CommandCode with Hermes](./2026-10-28-personal-commandcode-hermes.md), [BYO assessment](./2026-10-28-commandcode-byo-assessment.md).

## 3. Criteria status at acceptance

| Original H-003 criterion | Status |
|---|---|
| Current model ID and endpoint | **Met** for `deepseek/deepseek-v4-flash` (ZDR) and `reflection/beam:free` (non-ZDR) |
| Tool support | **Met for the POC**: no tool call was issued when an inert tool was declared; the POC requires no tools |
| Streaming | **Met**: Hermes streaming returned `OK` |
| Vision | **Not applicable** to the POC scope; untested |
| Rate limits | **Partially met**: documentation reviewed; no limit was exercised |
| Privacy and data handling | **Partially met**: ZDR header honored on the tested model; Beam retains and may train, so it is synthetic-only |
| Exhaustion behavior | **Not met**: deliberately exhausting credits was prohibited and was not done |
| Hermes compatibility | **Met** for the tested paths; error mapping is HTTP 200 with an error finish reason |
| Multi-user suitability | **Not met**: no written permission; shared-key use remains disabled |

The unmet criteria are accepted as residual risk for a single-user POC, not converted into evidence.

## 4. Residual risks accepted by the owner

1. **Exhaustion and billing behavior are unobserved.** Actual exhaustion may produce charges rather than a clean stop. The owner's account settings (included credits only, auto-reload and top-ups off) were owner-reported, not independently verified.
2. **Privacy assurance is partial.** ZDR is requested per request; the provider's retention behavior was not independently audited. Non-ZDR models are restricted to synthetic content.
3. **Model quality and reliability are not benchmarked.** A small number of successful requests is not a quality or availability result.
4. **No multi-user permission exists.** Shared-key use is disabled by policy; no code enforces it yet because no product code exists.
5. **Provider terms may change.** The terms were checked on 2026-10-28 and are not a standing grant.

## 5. Consequences for the board

- **H-004 (Hermes run lifecycle) is unblocked at planning fidelity** because a provider path and a harness path are now accepted for single-user work. H-004 execution still needs a pinned Hermes version and authorized provider calls.
- **H-005 (multi-user isolation) and H-006 (no-tool policy) remain unstarted.** They need a running multi-user deployment; H-005 additionally needs H-004.
- **H-001's no-sharing boundary remains in force.** The platform-funded default and BYO design is a separate proposal; it is not required for this single-user decision.
- **No P0 gate has passed.** H-003's acceptance is a scoped decision, not a P0 exit.

## 6. Non-claims

This record does not claim provider approval for multi-user use, a verified spending cap, verified privacy guarantees, model quality, production readiness, or any runtime capability in the repository. No provider call was made to produce this document.
