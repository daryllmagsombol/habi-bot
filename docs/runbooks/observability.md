# Run observability runbook (H-013 / issue #13, run slice)

This runbook traces one failed Run from the user action to its terminal state
using the H-013 run observability slice. All telemetry here is logging and
in-process counters only: there is no alert destination, no retention number,
and no log stack in this slice.

## Correlation model

Every run transition log carries up to three handles:

| Handle | Source | Always present? |
| --- | --- | --- |
| `runId` | The Habi Run id; also the `correlationId` on the adapter request | Yes |
| `conversationId` | The owning conversation, when the caller already holds it | When available at the call site |
| `requestId` | The inbound `x-request-id`, via `AsyncLocalStorage` | Only when the transition runs inside an HTTP request |

Worker-only transitions (recovery sweeps, idle cancel sweeps, stream
finalization) have no request context and must not fabricate a `requestId`.
There is no queue job id in this slice: a Run has no job id, so none is
logged and none is invented.

## What is logged

Transition events (all `info`):

- `run.enqueued` — one reservation counted; `deduplicated: false`.
- `run.reserved` — the fresh `queued` / `not_dispatched` reservation.
- `run.duplicate` — the same key and fingerprint returned the stored Run;
  `deduplicated: true`. A conflicting body throws before any event.
- `run.dispatch_accepted` — the single atomic claim won and the adapter
  accepted the dispatch.
- `run.dispatch_skipped` — the Run never reached the provider, with one
  `reason`: `deduplicated`, `terminal`, `claimed_elsewhere`,
  `cancel_requested`, `invalid_context`, or `other_skip`.
- `provider.call` — one provider outcome: `outcome` (`success`/`failure`),
  the normalized `errorCode`, `dispatchState`, `retried` (always `false` in
  this slice for ambiguous work — nothing is retried), and usage numbers
  only (`usageStatus`, prompt/completion/total token counts).
- `run.observed_terminal` — the stored terminal row: `status`,
  `dispatchState`, and `errorCode` when set.

Counters (`RunMetrics`, same in-process constraints as the request counters —
no HTTP route, no persistence, no exporter; everything resets on restart):

- `habi_runs_enqueued_total`, `habi_runs_dispatch_accepted_total`,
  `habi_runs_dispatch_skipped_total{reason}`,
  `habi_runs_terminal_total{status}`,
- `habi_provider_calls_total{outcome,error_code}`,
  `habi_provider_calls_retried_total` (expected to stay `0`),
- `habi_queue_depth`, `habi_queue_oldest_age_ms` (gauges, set by the owning
  worker loop from a bounded read), `habi_queue_failures_total`,
  `habi_worker_in_flight` (claim saturation).

## What is NOT logged

- Prompts, message bodies, payloads, uploads, raw usage records.
- Cookies, headers, bodies, tokens, the Hermes gateway key.
- Email addresses and filenames: whole-key redaction (`email`,
  `user_email`, `emailAddress`; `fileName`, `file_name`, `file_path`), plus
  inline `user@example.com` scrubbing in error messages.
- Queue job ids, alert targets, retention windows, log-stack endpoints.

## How to trace one failed run

1. Take the `runId` from the client response (`POST /api/threads/:id/messages`
   returns `runId`) or from the `x-request-id` echo on the response.
2. Grep stdout for the run: every line is one JSON object.
   ```sh
   node -e "const fs=require('fs');for(const l of fs.readFileSync(0,'utf8').split('\n')){if(!l.trim())continue;const r=JSON.parse(l);if(r.runId==='<runId>')console.log(l);}"
   ```
3. Read the transitions in order: `run.enqueued` (or `run.duplicate`), then
   either `run.dispatch_accepted` or `run.dispatch_skipped{reason}`, then one
   `provider.call`, then exactly one `run.observed_terminal`.
4. Match `provider.call.errorCode` + `dispatchState` against the terminal row:
   `not_dispatched` failures (e.g. `provider_exhausted`) release the allowance
   hold; `unknown` failures (e.g. `transport_ambiguous`, `timeout`) are honest
   `execution_uncertain`, never retried.
5. Check the queue gauges when the Run never dispatched: a growing
   `habi_queue_depth` with an old `habi_queue_oldest_age_ms` and a saturated
   `habi_worker_in_flight` means claims are stuck, not that the provider
   failed.

## Sample (redacted) trace

A provider-exhausted Run fails once, releases the hold, and is never retried:

```json
{"level":"info","service":"api","event":"run.enqueued","requestId":"req-abc_123","runId":"11111111-1111-1111-1111-111111111111","conversationId":"22222222-2222-2222-2222-222222222222","deduplicated":false}
{"level":"info","service":"api","event":"run.reserved","requestId":"req-abc_123","runId":"11111111-1111-1111-1111-111111111111","conversationId":"22222222-2222-2222-2222-222222222222","dispatchState":"not_dispatched","status":"queued"}
{"level":"info","service":"worker","event":"run.dispatch_accepted","runId":"11111111-1111-1111-1111-111111111111","conversationId":"22222222-2222-2222-2222-222222222222","dispatchState":"unknown"}
{"level":"info","service":"worker","event":"provider.call","runId":"11111111-1111-1111-1111-111111111111","conversationId":"22222222-2222-2222-2222-222222222222","outcome":"failure","errorCode":"provider_exhausted","dispatchState":"not_dispatched","retried":false,"usageStatus":"unknown","grossPromptTokens":null,"grossCompletionTokens":null,"totalTokens":null}
{"level":"info","service":"worker","event":"run.observed_terminal","runId":"11111111-1111-1111-1111-111111111111","conversationId":"22222222-2222-2222-2222-222222222222","status":"failed","dispatchState":"not_dispatched","errorCode":"provider_exhausted"}
```

Note the `requestId` is present on the API-owned lines and absent on the
worker-owned lines: that is expected, not a gap. The usage fields are all
`null` because unknown usage is never rendered as a zero charge.
