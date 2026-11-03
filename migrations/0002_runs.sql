-- H-002 §13: minimal Run linkage for Message.run_id.
--
-- H-019 owns conversations and messages, not the Run lifecycle (#22). This
-- table exists only so messages can reference a producing Run and so the
-- "at most one assistant result per Run" partial unique index has a parent.
-- #22 adds idempotency, lease/fencing, dispatch, usage, and terminal columns by
-- forward migration; none of those fields are invented here.

CREATE TABLE runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN (
      'queued',
      'running',
      'retry_wait',
      'completed',
      'failed',
      'cancelled',
      'timed_out'
    )),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT runs_conversation_owner_fk
    FOREIGN KEY (conversation_id, owner_user_id)
    REFERENCES conversations (id, owner_user_id),
  CONSTRAINT runs_id_scope_key
    UNIQUE (id, conversation_id, owner_user_id)
);

CREATE INDEX runs_conversation_created_idx
  ON runs (conversation_id, created_at);
CREATE INDEX runs_owner_status_idx
  ON runs (owner_user_id, status);
