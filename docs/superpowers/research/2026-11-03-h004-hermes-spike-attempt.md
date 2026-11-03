# H-004 — Hermes spike attempt (2026-11-03)

- **Status:** Partial execution record. The harness was installed and its run API was exercised, but **no successful model run was captured** because the available CommandCode credential was rejected for inference. H-004 remains **open**; rows 2–11 of the adapter contract's evidence table are still uncaptured.
- **Phase:** P0 — Feasibility (H-004).
- **Authority:** Owner pinned `NousResearch/hermes-agent` **v0.22.2 at `d923a5eb487a17c0a68801bba9ef0f56c81040a8`** with the **local API-server interface** on 2026-11-03, and authorized an isolated install plus bounded synthetic lifecycle calls.

## 1. Environment

| Item | Value |
|---|---|
| Harness | `hermes-agent` at the pinned commit (git checkout, 361 MB) |
| Install method | `uv venv --python 3.14` + `uv pip install -e .` (editable). A `uv tool install` of the git package is **refused by design**: the build backend errors with "Building wheels or sdists for hermes-agent is not supported." |
| Python | 3.14.7 (uv-managed) |
| Extra dependency | `.[messaging]` added for `aiohttp==3.14.3`; without it the API server cannot start (`check_api_server_requirements` requires `AIOHTTP_AVAILABLE`) |
| Config | Isolated `HERMES_HOME`, synthetic single-use config: provider `commandcode`, model `reflection/beam:free`, `agent.api_max_retries: 0`, `agent.auto_recovery_cycles: 0`, `platforms.api_server` enabled on `127.0.0.1:8651` with a generated 32-char gateway key, `platform_toolsets.api_server: []` |
| Process | `hermes gateway run -v`; `/health` returned 200; gateway stopped and verified gone after the probe |

No repository file, credential, or production service was changed. The provider credential was read from the existing local `~/.commandcode/auth.json` and never printed.

## 2. Lifecycle observations (real, not stubbed)

| Step | Result |
|---|---|
| `POST /v1/runs` with `Idempotency-Key: h004-probe-1`, input `Reply with exactly: OK` | **HTTP 202**, `{"run_id":"run_31c3…","status":"started","replayed":false}` |
| Same request repeated with the same key | **HTTP 202**, **same `run_id`**, `Idempotency-Replayed: true`, `replayed: true` — no second run created |
| `GET /v1/runs/{id}` | `status: "failed"`, `last_event: "run.failed"`, `error: "HTTP 401: Invalid 'Authorization' header or token."` |
| `GET /v1/runs/{id}/events` (SSE) | One event: `run.failed` with `seq: 0`, same error, `completed: false` |
| `POST /v1/runs/{id}/steer` on the terminal run | **HTTP 409**, `code: "run_not_accepting_steer"` |
| `POST /v1/runs/{id}/stop` on the terminal run | **HTTP 200**, returns the already-`failed` record; no `cancelled` transition is fabricated |

These are genuine observations of the pinned harness, but they cover the **failure path only**: create, idempotent replay, terminal failure surfacing, event replay, and control-request rejection. A successful stream, successful steering, cancellation while running, and restart recovery remain unobserved.

## 3. Credential finding (blocker)

The local CommandCode credentials are not accepted for inference:

| Credential | `GET /provider/v1/models` | `POST /provider/v1/chat/completions` |
|---|---|---|
| `auth.json` → `apiKey` (93 chars, `user_5…`) | HTTP 200 | **HTTP 401** `Invalid 'Authorization' header or token` |
| `auth.json` → `command-code.key` (92 chars, `user_B…`) | HTTP 200 | **HTTP 401** (same) |

Direct `curl` reproduces the 401 outside Hermes, and the Hermes CLI (`hermes -z … --provider commandcode`) reports the same rejection. The model listing endpoint accepts the token, so the key is not wholly invalid — it lacks inference credential scope or has expired. `/models` and `chat/completions` were exercised with a normal `curl` user agent; `python-urllib` is blocked by Cloudflare (403 code 1010) and is not a key signal.

**Consequence:** a successful H-004 lifecycle run requires a CommandCode **Provider API key** with inference permission. That is a credential only the owner can supply.

## 4. What this does and does not establish

- **Established:** the pinned harness installs and serves its API; the run create/replay/idempotency path works; failures surface as `failed` with an SSE terminal event; terminal runs reject steering and do not pretend to cancel.
- **Not established:** successful model execution, event ordering across a live stream, cancel-while-running, restart recovery, per-run usage fields, or any cost behavior.
- **Not claimed:** multi-user isolation, no-tool enforcement (the adapter contract still requires it; this probe did not verify advertised tools), ZDR behavior, or a P0 gate.

## 5. Next step

Supply a CommandCode Provider API key with inference access (environment variable or a one-time file outside the repository), then rerun the bounded probe to capture rows 2–11. No automatic retry or paid fallback is planned for the 401 path; the failure is treated as `auth_rejected`, pre-dispatch.

Evidence is retained under the temporary workspace `habi-h004/` (`probe_runs.py`, `evidence/h004-probe.json`, gateway log). The gateway process is stopped.
