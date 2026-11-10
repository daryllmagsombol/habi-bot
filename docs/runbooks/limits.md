# Daily allowance runbook (H-023 / issue #23)

Status: the per-user daily allowance slice is implemented, tested, and wired
to run admission (`ApiService` reserves before the Run row exists;
reserve-then-dispatch, never check-then-dispatch). There is no HTTP route for
limit management, no UI, no self-serve limit change, no per-user override, no
global budget, and no admin stop switch; those are explicitly out of this
slice
(see [`apps/backend/src/limits/index.ts`](../../apps/backend/src/limits/index.ts)).
Do not describe them as present.

## Configuration

- Allowance: `DAILY_ALLOWANCE_TOKENS = 100_000` per Habi user per Asia/Manila
  day, in units of gross input tokens plus gross output tokens
  ([`apps/backend/src/limits/types.ts`](../../apps/backend/src/limits/types.ts)).
- Window: the Asia/Manila calendar day (UTC+8, no daylight saving). It resets
  at 00:00:00 local, i.e. 16:00:00 UTC the previous calendar date. The day is
  resolved with `Intl.DateTimeFormat`, with no timezone package or PostgreSQL
  extension
  ([`apps/backend/src/limits/time.ts`](../../apps/backend/src/limits/time.ts)).
- Enforcement point: `UsageLimitService.reserve` — one transaction that locks
  the owner's day bucket, checks committed plus outstanding reservations, then
  inserts the reservation
  ([`apps/backend/src/limits/usage-limit-service.ts`](../../apps/backend/src/limits/usage-limit-service.ts)).
  A failed reservation means no dispatch; admission is reserve-then-dispatch,
  never check-then-dispatch.
- Abuse stopgaps (provisional, in-process only): 30 run creations per user per
  minute ([`apps/backend/src/limits/rate-limit.ts`](../../apps/backend/src/limits/rate-limit.ts))
  and the H-014 identity limits
  ([`apps/backend/src/auth/rate-limit.ts`](../../apps/backend/src/auth/rate-limit.ts)).

## Changing the allowance

The constant is owner-approved policy, not per-user tuning: every user shares
the same value, and changing it requires an authorized code change — there is
no admin endpoint, feature flag, or per-user override. The change is auditable
only as a commit. Before editing:

1. Record the owner decision (new value and reason).
2. Edit `DAILY_ALLOWANCE_TOKENS` in
   [`apps/backend/src/limits/types.ts`](../../apps/backend/src/limits/types.ts).
3. Re-run `pnpm --filter @habi/backend test`, `typecheck`, and `lint`.

## What exhaustion looks like

- Refusal: `UsageLimitError` with code `allowance_exhausted` and HTTP status
  429 ([`apps/backend/src/limits/errors.ts`](../../apps/backend/src/limits/errors.ts)).
  The body is `{ error: { code, limit, remaining, retryAfterSeconds } }` and
  carries only the caller's own allowance state.
- Recovery: wait until the next 00:00 Asia/Manila boundary (`retryAfterSeconds`
  points there); unused units do not carry over. Exhaustion is a normal state,
  not a retry hint beyond the daily reset.
- No paid fallback: an exhausted or provider-exhausted Run fails recoverably,
  releases its hold, and is never retried against a second provider
  (`scripts/acceptance/scenarios/provider-exhaustion.mjs`).
- Unknown usage: a bucket with unreconciled `unknown` usage refuses with
  `usage_unknown` (fail closed) until the owner reconciles it with a note; the
  resolution is written to the append-only `usage_limit_audit` table. Zero is
  allowed only as an explicit, audited resolution — never inferred.

## Provisional SSO abuse limits

The SSO surfaces carry provisional in-process limits while numeric policy for
#23 is still open
([`apps/backend/src/auth/sso/sso-config.ts`](../../apps/backend/src/auth/sso/sso-config.ts)):
`startClient` 40 / 15 min, `callbackClient` 80 / 15 min, `linkUser` 20 /
15 min per client or user bucket. They blunt scripted guessing; they are not
the final abuse-control design, and lowering them is an owner decision, not an
incident toggle.

## Not implemented in this slice

- No per-day global budget across users.
- No admin stop switch.
- No distributed rate limiting: the run-creation limiter is one process's
  `Map`, lost on restart and not shared between API replicas (N replicas
  multiply the effective limit).
- No HTTP route, Nest provider, queue, or provider call is wired here; those
  are later layers. The one exception is run admission: `ApiService` calls
  `UsageLimitService.reserve` before inserting the Run row, and releases the
  hold when the Run provably never reached the provider.
