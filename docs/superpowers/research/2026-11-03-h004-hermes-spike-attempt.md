# H-004 — Hermes lifecycle evidence (2026-11-03)

- **Status:** Bounded spike executed against the owner-pinned harness. Create, idempotent replay, ordered events, terminal failure, steer acceptance, cancel-while-running, usage reporting, terminal-state visibility after restart, and in-flight loss after SIGKILL are **observed**. Steering's effect on output and cancellation billing are **not** proven. H-004 remains **open** (sequence diagrams and the P1-path decision note are still outstanding).
- **Phase:** P0 — Feasibility (H-004).
- **Authority:** Owner pinned `NousResearch/hermes-agent` **v0.22.2 at `d923a5eb487a17c0a68801bba9ef0f56c81040a8`** with the **local API-server interface** on 2026-11-03, authorized the isolated install and bounded synthetic calls, and supplied a CommandCode Provider key with inference access.

## 1. Environment

| Item | Value |
|---|---|
| Harness | `hermes-agent` at the pinned commit |
| Install | `uv venv --python 3.14` + `uv pip install -e .` + `.[messaging]` (aiohttp is required by the API server). `uv tool install` of the git package is refused by design. |
| Python | 3.14.7 |
| Config | Isolated `HERMES_HOME`; provider `commandcode`; model `reflection/beam:free`; `agent.api_max_retries: 0`; `agent.auto_recovery_cycles: 0`; API server on `127.0.0.1:8651` with a generated gateway key; `platform_toolsets.api_server: []` |
| Prompts | Synthetic only (`Reply with exactly: OK`, number-counting) |
| Process | `hermes gateway run`; `/health` 200; stopped and verified gone after the probe |

## 2. First attempt — credential rejection (superseded)

The pre-existing CLI credential authenticated `/provider/v1/models` (200) but failed `chat/completions` with **401 `Invalid 'Authorization' header or token`**; the run surfaced as `failed` with `last_event: run.failed`. The owner then supplied a Provider API key; `/models` and one `chat/completions` preflight returned 200.

## 3. Observed lifecycle

### 3.1 Create, idempotent replay, completion, events

| Step | Result |
|---|---|
| `POST /v1/runs`, key `h004-…-1`, input `Reply with exactly: OK` | **202**, `run_925c131c…`, `status: started`, `replayed: false` |
| Same key repeated | **202**, **same `run_id`**, `Idempotency-Replayed: true`, `replayed: true` — no second run |
| `GET /v1/runs/{id}` | `completed`, `last_event: run.completed`, `output: "OK"` |
| Usage | `input_tokens 741`, `output_tokens 22`, `total_tokens 763`, `cache_read_tokens 256`, `cache_write_tokens 0` |
| `GET /v1/runs/{id}/events` (SSE) | 3 events, ordered: `message.delta` seq 0, `reasoning.available` seq 1, `run.completed` seq 2 (terminal last) |

`741 + 22 = 763`; `cache_read_tokens` is reported alongside and is **not** added again — consistent with the cached subset being inside the prompt total.

### 3.2 Steering while running

| Step | Result |
|---|---|
| Create run B | **202**, `run_22e8f515…` |
| `POST /v1/runs/{id}/steer` with synthetic text | **200**, `{"accepted": true}` |
| `POST /v1/runs/{id}/stop` ~1 s later | **200**, run had already `completed`; response carried `pending_steer` text |

Steering is **accepted** while running, but the run finished before the steer took effect, so its effect on output is **not** proven.

### 3.3 Cancel while running

| Step | Result |
|---|---|
| Create run C | **202**, `run_22495bb9…` (long number-generation prompt) |
| Steer | **200**, accepted |
| `POST /v1/runs/{id}/stop` | **200**, `status: "stopping"` |
| Poll to terminal | `cancelled`, `last_event: run.cancelled`, `output: null`, **`usage: null`** |

Cancellation reaches a terminal state and reports **no usage** — which Habi must treat as `unknown`, not zero. Whether the provider billed less is **not** established.

### 3.4 Restart visibility

The gateway was stopped and restarted, then both runs were queried again:

| Run | After restart |
|---|---|
| `run_925c131c…` | **200**, `completed`, same usage object |
| `run_22495bb9…` | **200**, `cancelled`, `usage: null` |

Terminal state **and** usage survive a harness restart. A replayed idempotency key from an earlier process also returned the original run, showing the durable `(scope, key)` store persists.

### 3.5 In-flight restart (SIGKILL)

| Step | Result |
|---|---|
| Create a long-generation run | **202**, `run_0cdd9a17…` |
| `GET /v1/runs/{id}` after 3 s | `running` |
| `SIGKILL` the gateway process | — |
| Restart, `/health` 200 | — |
| `GET /v1/runs/{id}` | **404**, `code: "run_not_found"` |
| `GET /v1/runs/{id}/events` | **404** |

**An in-flight run is lost across an unclean restart.** Only terminal runs (completed/cancelled) were retrievable. Habi must therefore reconcile such runs as `lost` / `execution_uncertain` from its own persistence and must not auto-retry potentially paid work. This is the strongest constraint observed.

## 4. What is established vs not

**Established:** create returns 202 with a run ID; duplicate keys replay one run; events are ordered with the terminal event last; failures surface as terminal `failed`; steering is accepted while running; stop yields `stopping → cancelled`; terminal state and usage remain visible after restart while an in-flight run is lost (404); usage fields are `input_tokens`/`output_tokens`/`total_tokens` plus cached counters.

**Not established:** steering's effect on the final output; whether cancel reduces provider billing; behaviour under concurrent runs; tool advertisement under `platform_toolsets.api_server: []`; multi-user isolation (H-005); no-tool enforcement (H-006); ZDR behaviour on this model.

**Not claimed:** production readiness, spending guarantees, or any P0 gate.

## 5. Next steps

1. Capture a steering effect: longer generation, steer early, compare output.
2. Add sequence diagrams and the "Hermes remains the P1 path" decision note to close H-004.
3. H-005/H-006 stay blocked on a running multi-user deployment.

Evidence files: `habi-h004/evidence/h004-probe.json`, `h004-cancel.json`, `h004-recovery.json`, `gateway2.log`–`gateway5.log`, and the probe scripts. Secrets were never printed; the gateway is stopped.
