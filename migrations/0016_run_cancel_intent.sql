-- Durable cancellation intent for a Run that may already be dispatched.
--
-- Why a column and not an event or a status change:
--
--   * `status` must stay truthful. A dispatched Run that a user asked to stop is
--     still `running` until the owning worker confirms the stop; writing
--     `cancelled` from the API would be a false success when the adapter is
--     unreachable.
--   * `error_code`/`dispatch_state` describe execution, not a control request.
--     Reusing either would conflate "the provider failed" with "the user asked".
--   * The user-visible `run_events` stream is the replay contract. Injecting an
--     internal control event into it would change what clients see for a state
--     that is not part of the Run outcome.
--
-- The intent is therefore a nullable request marker on the Run row, written by
-- the API process without an adapter and consumed by whichever worker owns the
-- claim. It survives an API restart because it is committed before the response.
--
-- Bookkeeping columns make the worker's attempt exactly-once and bounded:
--   * `cancel_claimed_at` marks an attempt in flight so two processors (the
--     owning stream's heartbeat and the idle cancel sweep) cannot both call
--     `adapter.cancel` for the same intent;
--   * `cancel_attempts` bounds the retry loop after a recoverable adapter
--     failure;
--   * `cancel_error_code` records the honest last failure so the run is not
--     reported cancelled when the harness was not reached.
--
-- No backfill is needed: every existing row has no cancellation requested.

ALTER TABLE runs
  ADD COLUMN cancel_requested_at timestamptz;
ALTER TABLE runs
  ADD COLUMN cancel_reason text;
ALTER TABLE runs
  ADD COLUMN cancel_claimed_at timestamptz;
ALTER TABLE runs
  ADD COLUMN cancel_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE runs
  ADD COLUMN cancel_error_code text;

ALTER TABLE runs
  ADD CONSTRAINT runs_cancel_reason_check
  CHECK (
    cancel_reason IS NULL
    OR cancel_reason IN ('user', 'deadline', 'shutdown', 'policy')
  );

-- An intent is a timestamp plus the reason that produced it; one without the
-- other cannot be interpreted by the worker.
ALTER TABLE runs
  ADD CONSTRAINT runs_cancel_intent_complete
  CHECK ((cancel_requested_at IS NULL) = (cancel_reason IS NULL));

ALTER TABLE runs
  ADD CONSTRAINT runs_cancel_attempts_nonnegative
  CHECK (cancel_attempts >= 0);

ALTER TABLE runs
  ADD CONSTRAINT runs_cancel_error_code_length
  CHECK (
    cancel_error_code IS NULL
    OR char_length(btrim(cancel_error_code)) BETWEEN 1 AND 120
  );

-- The claim timestamp only exists on an intent that has been attempted.
ALTER TABLE runs
  ADD CONSTRAINT runs_cancel_claim_requires_intent
  CHECK (cancel_claimed_at IS NULL OR cancel_requested_at IS NOT NULL);

-- Outstanding intents are scanned by the idle worker, not by owner reads. A
-- partial index keeps that scan proportional to pending cancellations.
CREATE INDEX runs_cancel_pending_idx
  ON runs (cancel_requested_at, id)
  WHERE cancel_requested_at IS NOT NULL
    AND status IN ('queued', 'running', 'retry_wait');
