-- H-022 (#22): durable Run lifecycle on top of the 0002 linkage stub.
--
-- 0002 created the Run id/owner/conversation linkage and a provisional status
-- check. This migration extends that table in place; it does not replace the
-- `(id, conversation_id, owner_user_id)` key or the composite ownership FK used
-- by messages. Existing rows are backfilled before any NOT NULL or consistency
-- constraint is enforced.
--
-- Status note: 0002 defined `retry_wait` and `timed_out`, and H-002 §7.1-7.2
-- keep them in the state machine. They remain legal so this forward migration
-- does not reject pre-existing rows or delete an accepted state. The run
-- controller in this slice writes queued/running/completed/failed/cancelled and
-- the new terminal `execution_uncertain`; it writes neither retry_wait nor
-- timed_out.
--
-- Idempotency note: H-002 §7.3 describes `(conversation_id, idempotency_key)`.
-- The controller contract for #22 requires `(owner_user_id, idempotency_key)`.
-- The owner-level key is strictly stronger (a conversation belongs to exactly
-- one owner), so a duplicate submission can never start a second Run, even if
-- it names a different conversation. The per-conversation property therefore
-- holds transitively.

ALTER TABLE runs
  ADD COLUMN idempotency_key text;
ALTER TABLE runs
  ADD COLUMN request_fingerprint text;
ALTER TABLE runs
  ADD COLUMN dispatch_state text NOT NULL DEFAULT 'not_dispatched';
ALTER TABLE runs
  ADD COLUMN harness_run_id text;
ALTER TABLE runs
  ADD COLUMN harness_session_id text;
ALTER TABLE runs
  ADD COLUMN error_code text;
ALTER TABLE runs
  ADD COLUMN usage_status text NOT NULL DEFAULT 'unknown';
ALTER TABLE runs
  ADD COLUMN usage_gross_prompt_tokens bigint;
ALTER TABLE runs
  ADD COLUMN usage_gross_completion_tokens bigint;
ALTER TABLE runs
  ADD COLUMN usage_cached_prompt_tokens bigint;
ALTER TABLE runs
  ADD COLUMN usage_reasoning_tokens bigint;
ALTER TABLE runs
  ADD COLUMN usage_total_tokens bigint;
ALTER TABLE runs
  ADD COLUMN usage_cost_status text NOT NULL DEFAULT 'unknown';
ALTER TABLE runs
  ADD COLUMN usage_raw jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE runs
  ADD COLUMN started_at timestamptz;
ALTER TABLE runs
  ADD COLUMN finished_at timestamptz;
ALTER TABLE runs
  ADD COLUMN last_event_seq bigint NOT NULL DEFAULT 0;

-- Backfill. A legacy row predates caller keys, so it receives an id-derived
-- synthetic key that can never collide with a caller-supplied one. There is no
-- trustworthy historical fingerprint: a later request with the same synthetic
-- key is a conflict rather than a silent reuse.
UPDATE runs
   SET idempotency_key = 'legacy:' || id::text
 WHERE idempotency_key IS NULL;
UPDATE runs
   SET request_fingerprint = 'legacy:' || id::text
 WHERE request_fingerprint IS NULL;

-- Anything that left `queued` may already have reached a provider; claiming
-- `not_dispatched` would be a guess. `unknown` is the conservative backfill.
UPDATE runs
   SET dispatch_state = 'unknown'
 WHERE status <> 'queued';

-- Terminal rows must keep a stable finish time for idempotent cancel/recovery.
UPDATE runs
   SET started_at = updated_at
 WHERE started_at IS NULL
   AND status IN ('running', 'completed', 'failed', 'cancelled', 'timed_out');
UPDATE runs
   SET finished_at = updated_at
 WHERE finished_at IS NULL
   AND status IN ('completed', 'failed', 'cancelled', 'timed_out');

ALTER TABLE runs
  ALTER COLUMN idempotency_key SET NOT NULL;
ALTER TABLE runs
  ALTER COLUMN request_fingerprint SET NOT NULL;

-- Direct inserts that predate this controller (and the H-019 test fixture) omit
-- the caller key. A per-row synthetic default keeps the column required for
-- every insert without rejecting those rows; the controller always supplies a
-- real caller key and never relies on this default.
ALTER TABLE runs
  ALTER COLUMN idempotency_key
  SET DEFAULT ('legacy:' || gen_random_uuid()::text);
ALTER TABLE runs
  ALTER COLUMN request_fingerprint
  SET DEFAULT ('legacy:' || gen_random_uuid()::text);

-- Replace the provisional 0002 status check with a superset. The new terminal
-- outcome is the only addition; every value 0002 accepted is still accepted.
ALTER TABLE runs
  DROP CONSTRAINT IF EXISTS runs_status_check;
ALTER TABLE runs
  ADD CONSTRAINT runs_status_check
  CHECK (status IN (
    'queued',
    'running',
    'retry_wait',
    'completed',
    'failed',
    'cancelled',
    'timed_out',
    'execution_uncertain'
  ));

ALTER TABLE runs
  ADD CONSTRAINT runs_dispatch_state_check
  CHECK (dispatch_state IN ('not_dispatched', 'dispatched', 'unknown'));

ALTER TABLE runs
  ADD CONSTRAINT runs_idempotency_key_length
  CHECK (char_length(btrim(idempotency_key)) BETWEEN 1 AND 200);

ALTER TABLE runs
  ADD CONSTRAINT runs_request_fingerprint_nonempty
  CHECK (length(request_fingerprint) > 0);

ALTER TABLE runs
  ADD CONSTRAINT runs_error_code_length
  CHECK (error_code IS NULL OR char_length(btrim(error_code)) BETWEEN 1 AND 120);

ALTER TABLE runs
  ADD CONSTRAINT runs_harness_run_id_length
  CHECK (harness_run_id IS NULL OR char_length(harness_run_id) BETWEEN 1 AND 512);

ALTER TABLE runs
  ADD CONSTRAINT runs_harness_session_id_length
  CHECK (
    harness_session_id IS NULL
    OR char_length(harness_session_id) BETWEEN 1 AND 512
  );

ALTER TABLE runs
  ADD CONSTRAINT runs_usage_status_check
  CHECK (usage_status IN ('known', 'partial', 'unknown'));

ALTER TABLE runs
  ADD CONSTRAINT runs_usage_cost_status_check
  CHECK (usage_cost_status IN ('known', 'unknown'));

ALTER TABLE runs
  ADD CONSTRAINT runs_usage_tokens_nonnegative
  CHECK (
    (usage_gross_prompt_tokens IS NULL OR usage_gross_prompt_tokens >= 0)
    AND (usage_gross_completion_tokens IS NULL
      OR usage_gross_completion_tokens >= 0)
    AND (usage_cached_prompt_tokens IS NULL
      OR usage_cached_prompt_tokens >= 0)
    AND (usage_reasoning_tokens IS NULL OR usage_reasoning_tokens >= 0)
    AND (usage_total_tokens IS NULL OR usage_total_tokens >= 0)
  );

ALTER TABLE runs
  ADD CONSTRAINT runs_last_event_seq_nonnegative
  CHECK (last_event_seq >= 0);

-- Terminal states are exactly the states with a recorded finish time. Reached
-- through one atomic transition in RunService so a cancelled/completed row is
-- never rewritten by a late worker.
ALTER TABLE runs
  ADD CONSTRAINT runs_finished_at_matches_terminal
  CHECK (
    (status IN (
      'completed',
      'failed',
      'cancelled',
      'timed_out',
      'execution_uncertain'
    )) = (finished_at IS NOT NULL)
  );

-- Enqueue dedupe. This is the constraint the insert uses for ON CONFLICT DO
-- NOTHING; it prevents duplicate Run rows even across concurrent submitters.
ALTER TABLE runs
  ADD CONSTRAINT runs_owner_idempotency_key
  UNIQUE (owner_user_id, idempotency_key);

-- 0002's `runs_owner_status_idx (owner_user_id, status)` already serves the
-- owner/status read path this controller uses. The indexes below cover the two
-- remaining controller scans without duplicating it.
CREATE INDEX runs_status_updated_idx
  ON runs (status, updated_at, id);
CREATE INDEX runs_owner_created_id_idx
  ON runs (owner_user_id, created_at DESC, id DESC);
