-- H-030 (#30): explicit memory controls.
--
-- A Memory is a user-accepted fact, never an inferred profile. This migration
-- implements the owner decisions recorded in H-002:
--
--   D2  recall requires BOTH the per-Bot gate (`bot_approved`) and the
--       per-conversation gate (`conversation_approved`). Both default to false,
--       so a newly proposed Memory is never recallable by accident and neither
--       gate alone permits recall.
--   D3  an accepted Memory survives deletion of its source conversation or
--       message. Its provenance is nulled (`conversation_id`,
--       `source_message_id`) and marked `tombstoned`, with an audit row. The
--       owner may then delete the Memory explicitly.
--
-- Approval is represented on the row instead of separate selection tables so
-- the two gates, the explicit acceptance, and the tombstone state are all
-- checked by one row constraint. A memory is never recallable merely because
-- it exists: `status = 'accepted'` additionally requires both gates, and recall
-- is always scoped to one owner, one Bot, and one conversation.
--
-- Ownership is repeated on the row and proven by composite foreign keys, so a
-- read predicate never depends on a join-only guess:
--
--   owner_user_id + bot_id             -> bots (id, owner_user_id)
--   owner_user_id + bot_id +
--     conversation_id                  -> conversations (id, bot_id,
--                                         owner_user_id)
--   owner_user_id + conversation_id +
--     source_message_id                -> messages (id, conversation_id,
--                                         owner_user_id)
--
-- The conversation scope includes `bot_id` so the database rejects a Memory
-- whose Bot disagrees with its source conversation's Bot.
--
-- Provenance is source-only: `conversation_id` is where the fact came from and
-- is also the recall scope while live. Source deletion is a service operation
-- (`MemoryService.onSourceDeleted`) because conversations and messages are
-- soft-deleted in this slice; a hard purge is deferred.
--
-- Deletion is a tombstone (`status = 'deleted'`). The row and its audit trail
-- remain so retention/purge work (#32) can decide the final erasure. No
-- embeddings or derived indexes exist in this slice.
--
-- `memory_audit` is append-only by convention: the service only inserts, and
-- no product path updates or deletes an audit row. There is deliberately no
-- trigger, matching the task boundary for this slice.

-- The conversation scope includes bot_id. This additive uniqueness lets the
-- Memory foreign key prove that its Bot agrees with its source conversation,
-- without changing any existing conversation behavior.
ALTER TABLE conversations
  ADD CONSTRAINT conversations_id_bot_owner_key
  UNIQUE (id, bot_id, owner_user_id);

CREATE TABLE memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL,
  -- Every Memory belongs to exactly one Bot; recall never crosses Bots.
  bot_id uuid NOT NULL,
  -- Source conversation. NULL only after provenance is tombstoned (D3).
  conversation_id uuid,
  -- User-accepted fact text. Untrusted display content: it can never grant a
  -- capability or change Bot policy.
  content text NOT NULL,
  -- Optional source message inside `conversation_id`.
  source_message_id uuid,
  status text NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed', 'accepted', 'deleted')),
  -- D2 gates. A Memory starts with neither approval.
  bot_approved boolean NOT NULL DEFAULT false,
  conversation_approved boolean NOT NULL DEFAULT false,
  provenance_state text NOT NULL DEFAULT 'live'
    CHECK (provenance_state IN ('live', 'tombstoned')),
  -- Set only when the source conversation/message is deleted (D3).
  provenance_tombstoned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT memories_owner_fk
    FOREIGN KEY (owner_user_id) REFERENCES users (id),
  CONSTRAINT memories_bot_owner_fk
    FOREIGN KEY (bot_id, owner_user_id) REFERENCES bots (id, owner_user_id),
  -- A live source conversation must belong to the same owner and Bot. This is
  -- a NO ACTION key on purpose: conversations are soft-deleted, the service
  -- tombstones provenance first, and hard purge is deferred.
  CONSTRAINT memories_conversation_scope_fk
    FOREIGN KEY (conversation_id, bot_id, owner_user_id)
    REFERENCES conversations (id, bot_id, owner_user_id),
  -- A named source message must be in the same conversation and owner.
  CONSTRAINT memories_source_message_fk
    FOREIGN KEY (source_message_id, conversation_id, owner_user_id)
    REFERENCES messages (id, conversation_id, owner_user_id),
  -- Lets memory_audit prove it belongs to the same owner as the Memory.
  CONSTRAINT memories_id_owner_key UNIQUE (id, owner_user_id),
  CONSTRAINT memories_content_length
    CHECK (char_length(btrim(content)) BETWEEN 1 AND 4000),
  CONSTRAINT memories_deleted_at_matches_status
    CHECK ((status = 'deleted') = (deleted_at IS NOT NULL)),
  -- D2: accepted means explicitly accepted while both gates were on. Revoking
  -- either gate demotes the row back to `proposed` in the service, so this
  -- invariant always holds.
  CONSTRAINT memories_accepted_requires_approvals
    CHECK (status <> 'accepted' OR (bot_approved AND conversation_approved)),
  -- An accepted Memory survives source deletion with provenance tombstoned;
  -- while live it must still have a recall scope.
  CONSTRAINT memories_accepted_requires_scope
    CHECK (
      status <> 'accepted'
      OR conversation_id IS NOT NULL
      OR provenance_state = 'tombstoned'
    ),
  -- A conversation gate is meaningless without a conversation, except for the
  -- historical approval retained on a tombstoned row.
  CONSTRAINT memories_conversation_approval_shape
    CHECK (
      NOT conversation_approved
      OR conversation_id IS NOT NULL
      OR provenance_state = 'tombstoned'
    ),
  -- Live provenance keeps the source; tombstoned provenance nulls both source
  -- identifiers and records when it happened.
  CONSTRAINT memories_provenance_shape
    CHECK (
      (
        provenance_state = 'live'
        AND conversation_id IS NOT NULL
        AND provenance_tombstoned_at IS NULL
      )
      OR (
        provenance_state = 'tombstoned'
        AND conversation_id IS NULL
        AND source_message_id IS NULL
        AND provenance_tombstoned_at IS NOT NULL
      )
    )
);

-- Owner-scoped inspection, newest first with a stable id tiebreak.
CREATE INDEX memories_owner_created_idx
  ON memories (owner_user_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;

-- Per-Bot inspection and the recall predicate share this index.
CREATE INDEX memories_owner_bot_status_idx
  ON memories (owner_user_id, bot_id, status)
  WHERE deleted_at IS NULL;

-- Per-conversation inspection and recall. Tombstoned rows have no conversation.
CREATE INDEX memories_owner_conversation_idx
  ON memories (owner_user_id, conversation_id)
  WHERE conversation_id IS NOT NULL;

-- Source-deletion lookup for messages.
CREATE INDEX memories_source_message_idx
  ON memories (source_message_id)
  WHERE source_message_id IS NOT NULL;

-- Append-only record of every Memory decision. `note` is a short machine
-- note, never Memory content. Source-deletion notes retain the deleted source
-- identifiers because the Memory row intentionally nulls them.
CREATE TABLE memory_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL,
  memory_id uuid NOT NULL,
  action text NOT NULL
    CHECK (
      action IN (
        'propose',
        'approve_bot',
        'revoke_bot',
        'approve_conversation',
        'revoke_conversation',
        'accept',
        'delete',
        'source_delete'
      )
    ),
  actor_user_id uuid NOT NULL,
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memory_audit_owner_fk
    FOREIGN KEY (owner_user_id) REFERENCES users (id),
  CONSTRAINT memory_audit_actor_fk
    FOREIGN KEY (actor_user_id) REFERENCES users (id),
  CONSTRAINT memory_audit_memory_owner_fk
    FOREIGN KEY (memory_id, owner_user_id)
    REFERENCES memories (id, owner_user_id),
  CONSTRAINT memory_audit_note_length
    CHECK (char_length(note) <= 500)
);

CREATE INDEX memory_audit_owner_created_idx
  ON memory_audit (owner_user_id, created_at DESC, id DESC);

CREATE INDEX memory_audit_memory_created_idx
  ON memory_audit (memory_id, created_at);
