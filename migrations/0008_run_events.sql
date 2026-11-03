-- H-020 (#20): durable, ordered Run events for replay after reconnect.
--
-- A RunEvent is append-only. Ordering is the server-assigned `seq`, allocated
-- per Run from 1 and unique with `run_id`; `created_at` is display metadata and
-- is never an ordering key. The row repeats `owner_user_id` and
-- `conversation_id` and proves them against the parent Run with a composite
-- foreign key, so a replay predicate never depends on a join-only guess or on
-- JSONB.
--
-- Immutability: an UPDATE is rejected by trigger. A DELETE is rejected unless
-- it is a cascade from the parent Run, which is the only retention/purge path
-- in this slice. No product code exposes update or delete.
--
-- `payload` is a JSON object. It must not contain secrets or full prompts; the
-- service bounds its size and the event vocabulary is documented in
-- apps/backend/src/events/types.ts.

CREATE TABLE run_events (
  -- Client idempotency key for a retried append, or a server-generated id.
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  -- Server-assigned monotonic order; unique per Run.
  seq bigint NOT NULL,
  type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- A RunEvent can only belong to the Run in the same owner/conversation scope.
  -- Cascades with the Run; the immutability trigger permits that cascade only.
  CONSTRAINT run_events_run_scope_fk
    FOREIGN KEY (run_id, conversation_id, owner_user_id)
    REFERENCES runs (id, conversation_id, owner_user_id)
    ON DELETE CASCADE,
  CONSTRAINT run_events_seq_positive
    CHECK (seq >= 1),
  CONSTRAINT run_events_type_shape
    CHECK (
      char_length(type) BETWEEN 1 AND 120
      AND type ~ '^[A-Za-z][A-Za-z0-9._:-]*$'
    ),
  CONSTRAINT run_events_payload_object
    CHECK (jsonb_typeof(payload) = 'object'),
  -- The append idempotency and ordering authority. A duplicate sequence or a
  -- concurrent allocator can never create two events at the same position.
  CONSTRAINT run_events_run_seq_key
    UNIQUE (run_id, seq)
);

-- Owner-scoped replay across a conversation: newest keyset scans and the
-- enforced ownership predicate share this index.
CREATE INDEX run_events_owner_conversation_seq_idx
  ON run_events (owner_user_id, conversation_id, run_id, seq);

-- Terminal detection for one Run. Partial so it stays small relative to deltas.
CREATE INDEX run_events_terminal_idx
  ON run_events (run_id, seq)
  WHERE type IN ('run.completed', 'run.failed', 'run.cancelled');

-- Append-only guard. `pg_trigger_depth() = 1` is a direct UPDATE/DELETE;
-- a cascade from `runs` fires this row trigger inside the foreign-key trigger
-- at depth 2. A direct retention delete must therefore go through the Run row.
CREATE FUNCTION run_events_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'run_events are immutable'
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER run_events_immutable
  BEFORE UPDATE OR DELETE ON run_events
  FOR EACH ROW
  EXECUTE FUNCTION run_events_reject_mutation();
