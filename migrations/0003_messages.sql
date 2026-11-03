-- H-002 §9 and §13: ordered, idempotent messages inside a conversation.

CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL,
  -- Repeated owner column so the access predicate never depends on a join-only
  -- guess or on JSONB. The composite FK proves it matches the conversation.
  owner_user_id uuid NOT NULL,
  role text NOT NULL
    CHECK (role IN ('user', 'assistant')),
  content text NOT NULL
    CHECK (length(content) > 0),
  -- Client-supplied idempotency key; unique per conversation when present.
  client_message_id text,
  -- Server-assigned monotonic order, unique per conversation.
  seq bigint NOT NULL
    CHECK (seq > 0),
  run_id uuid,
  status text NOT NULL DEFAULT 'final'
    CHECK (status IN ('pending', 'final', 'failed', 'deleted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  finalized_at timestamptz,
  deleted_at timestamptz,
  CONSTRAINT messages_conversation_owner_fk
    FOREIGN KEY (conversation_id, owner_user_id)
    REFERENCES conversations (id, owner_user_id),
  -- A producing Run must belong to the same conversation and owner.
  CONSTRAINT messages_run_scope_fk
    FOREIGN KEY (run_id, conversation_id, owner_user_id)
    REFERENCES runs (id, conversation_id, owner_user_id),
  CONSTRAINT messages_deleted_at_matches_status
    CHECK ((status = 'deleted') = (deleted_at IS NOT NULL)),
  -- A final message is authoritative and must record when it was finalized.
  -- Deleted rows may keep their previous finalized_at.
  CONSTRAINT messages_finalized_at_required
    CHECK (status <> 'final' OR finalized_at IS NOT NULL)
);

ALTER TABLE messages
  ADD CONSTRAINT messages_conversation_seq_key
  UNIQUE (conversation_id, seq);

-- NULLS DISTINCT is PostgreSQL's default, so assistant rows without a client
-- key do not collide. Retrying the same client key is rejected as a duplicate.
ALTER TABLE messages
  ADD CONSTRAINT messages_conversation_client_id_key
  UNIQUE (conversation_id, client_message_id);

-- At most one non-deleted assistant result per Run (H-002 §9.1).
CREATE UNIQUE INDEX messages_run_assistant_result_key
  ON messages (run_id)
  WHERE run_id IS NOT NULL
    AND role = 'assistant'
    AND deleted_at IS NULL;

-- The unique (conversation_id, seq) constraint already provides the ordered
-- btree used by cursor scans, so no duplicate index is created here.
CREATE INDEX messages_conversation_created_idx
  ON messages (conversation_id, created_at);
CREATE INDEX messages_owner_conversation_idx
  ON messages (owner_user_id, conversation_id);
