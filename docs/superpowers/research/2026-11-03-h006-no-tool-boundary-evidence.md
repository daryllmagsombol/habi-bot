# H-006 — No-tool boundary evidence (2026-11-03)

- **Status:** Harness-boundary half proven; application-boundary half cannot be tested because no product runtime, Bot Markdown, uploads, queue, or callback surface exists. H-006 remains open.
- **Phase:** P0 — Feasibility (H-006).
- **Authority:** H-001 and H-004 are accepted. The harness is pinned to `NousResearch/hermes-agent` v0.22.2 at `d923a5eb487a17c0a68801bba9ef0f56c81040a8` with the API-server interface.

## 1. Question

With `platform_toolsets.api_server: []`, does the pinned harness actually send a `tools` array upstream? The H-004 startup log reported "21 tool schema(s) materialized", which was recorded as a warning sign rather than a result.

## 2. Method

A local OpenAI-compatible stub provider (`stub_provider.py`) listened on `127.0.0.1:8899`, recorded every inbound request (headers with `authorization` redacted, plus the JSON body) to `stub-captures.jsonl`, and returned either an SSE stream or a plain completion. Hermes was pointed at it with `COMMANDCODE_BASE_URL=http://127.0.0.1:8899/v1`, a dummy key, and an isolated `HERMES_HOME`. Each condition restarted the gateway so the config was re-read; one synthetic run was created through the Hermes API server and driven to terminal.

No external provider was called. No product code exists or was changed.

## 3. Control matrix

| Condition | Model | `platform_toolsets.api_server` | Run result | Chat requests | Requests with `tools` | Tool count |
|---|---|---|---:|---:|---:|---:|
| A | `deepseek/deepseek-v4-flash` (tool-capable) | `[]` | completed | 2 | **0** | — |
| B | `deepseek/deepseek-v4-flash` | default (key absent) | completed | 2 | **1** | **19** |
| C | `deepseek/deepseek-v4-flash`, injection prompt | `[]` | completed | 2 | **0** | — |

Each run produced two chat requests: the main streaming request and one non-streaming auxiliary request (title generation). In condition B only the main request carried tools; the auxiliary request never did.

## 4. Findings

1. **The empty API-server toolset suppresses tool advertisement.** With a tool-capable model and `[]`, neither the main nor the auxiliary request contained a `tools` key. The "21 tool schemas materialized" line was not the API-server request surface.
2. **The apparatus can detect tools.** Removing the empty toolset advertised **19 tools** in the main request, so condition A's zero is a real suppression, not a blind spot.
3. **A prompt-injection payload cannot reach a tool that is not advertised.** Condition C sent an explicit instruction to use the shell and browser tools; the upstream request still contained no `tools`, and the run completed with a text reply.
4. **No output-cap field is transmitted** in any condition (`max_tokens`, `max_completion_tokens`, `max_output_tokens` all absent), consistent with the earlier finding.

## 5. What this does and does not prove

**Proven at the harness boundary:** the pinned configuration advertises no tools upstream for the API-server platform, even to a tool-capable model, and injection text in the user message does not change that.

**Not proven:**
- Server-side enforcement inside Habi's own application layer — it does not exist.
- Bot Markdown, uploaded filenames, extracted document text, queue payloads, callback parameters, or file-path traversal.
- A fail-closed user-facing error and audit event for a blocked tool attempt.
- Behaviour against a real provider rather than a stub (a provider could still return a tool call for an unadvertised tool; Habi must reject it server-side rather than assume the model complies).
- The `waiting_for_approval` path, MCP servers, and plugin tools.

## 6. Consequences

- The harness configuration is a **usable first layer** for #21, not the policy itself. Habi must still reject unknown tool calls server-side and log them.
- H-006 cannot close until a deployed shape exists to test the application boundary; the remaining criteria become #21/#22 obligations.
- No policy is claimed to be enforced by the model's compliance.

Evidence: `habi-h006/stub_provider.py`, `stub-captures.jsonl` (20 requests), `tool-matrix.json`, `probe_tools.py`, `probe_matrix.py`, `probe_injection.py`, gateway logs. Stub and gateway are stopped.
