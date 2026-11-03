-- H-026 (#26): conversation-scoped, owner-scoped private attachments.
--
-- An Attachment is untrusted uploaded content. This migration stores only
-- metadata; bytes live outside the database in a private storage root with no
-- public URL. Ownership is repeated on the row and proven by composite foreign
-- keys, so a read predicate never depends on a join-only guess:
--
--   owner_user_id + conversation_id -> conversations (id, owner_user_id)
--   owner_user_id + conversation_id + message_id -> messages (same row scope)
--
-- `storage_key` is server-generated and unique. It encodes only server ids:
--   owner/<owner-uuid>/conversation/<conversation-uuid>/<attachment-uuid>
-- The original filename is metadata and is never a path component.
--
-- Lifecycle:
--   pending  -> bytes written, metadata recorded, not yet published
--   stored   -> verified and downloadable by the owner
--   rejected -> refused by policy/validation; never downloadable
--   deleted  -> tombstone; the stored object is removed with the row state
--
-- `rejected` is the observable state for a refusal that had to leave a record
-- (for example a future malware scanner). No scanner runs in this slice.

-- A3 of 0003 gives messages only a single-column primary key. The composite
-- uniqueness below is additive: it lets an attachment prove that its optional
-- message belongs to the same conversation and owner, without a trigger and
-- without changing any existing message behavior.
ALTER TABLE messages
  ADD CONSTRAINT messages_id_conversation_owner_key
  UNIQUE (id, conversation_id, owner_user_id);

CREATE TABLE attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  -- Optional parent message. Null for a conversation-level upload.
  message_id uuid,
  -- Client-supplied display name. Metadata only; never used to build a path.
  original_filename text NOT NULL,
  content_type text NOT NULL,
  byte_size bigint NOT NULL,
  -- Lowercase hex digest of the stored bytes. Verified on every read.
  sha256 text NOT NULL,
  -- Server-generated object key. Unique across every owner.
  storage_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'stored', 'rejected', 'deleted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  stored_at timestamptz,
  deleted_at timestamptz,
  CONSTRAINT attachments_conversation_owner_fk
    FOREIGN KEY (conversation_id, owner_user_id)
    REFERENCES conversations (id, owner_user_id),
  -- A named message must be in this attachment's conversation and owner.
  CONSTRAINT attachments_message_scope_fk
    FOREIGN KEY (message_id, conversation_id, owner_user_id)
    REFERENCES messages (id, conversation_id, owner_user_id),
  CONSTRAINT attachments_storage_key_key UNIQUE (storage_key),
  -- The key shape is fixed by the server. Any other value is a programming
  -- error, not client data.
  CONSTRAINT attachments_storage_key_shape
    CHECK (storage_key ~
      '^owner/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/conversation/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  CONSTRAINT attachments_sha256_shape
    CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  -- 10 MiB per-file ceiling, matching MAX_ATTACHMENT_BYTES in the service.
  CONSTRAINT attachments_byte_size_range
    CHECK (byte_size >= 0 AND byte_size <= 10485760),
  -- PostgreSQL text cannot store NUL, so the server itself rejects it; the
  -- remaining checks keep the filename a display name rather than a path.
  CONSTRAINT attachments_filename_metadata_only
    CHECK (
      length(btrim(original_filename)) > 0
      AND length(original_filename) <= 255
      AND strpos(original_filename, '/') = 0
      AND strpos(original_filename, '\') = 0
      AND original_filename <> '.'
      AND original_filename <> '..'
    ),
  CONSTRAINT attachments_content_type_nonempty
    CHECK (length(btrim(content_type)) > 0 AND length(content_type) <= 255),
  CONSTRAINT attachments_deleted_at_matches_status
    CHECK ((status = 'deleted') = (deleted_at IS NOT NULL)),
  -- A published attachment must record when it was published. Pending,
  -- rejected, and tombstoned rows may leave it null.
  CONSTRAINT attachments_stored_at_required
    CHECK (status <> 'stored' OR stored_at IS NOT NULL)
);

-- Owner-scoped conversation listing: newest first with a stable id tiebreak.
-- Tombstoned rows never list, so the partial predicate keeps the index small.
CREATE INDEX attachments_owner_conversation_created_idx
  ON attachments (owner_user_id, conversation_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;

-- Resolving an attachment by id always binds the owner and conversation.
CREATE INDEX attachments_conversation_idx
  ON attachments (conversation_id);

-- Supports the pending-upload retention sweep that a later lane will add.
CREATE INDEX attachments_pending_created_idx
  ON attachments (created_at)
  WHERE status = 'pending';

-- Message-scoped attachment lookup for the extraction lane (#27); no
-- extraction or citation behavior is implemented here.
CREATE INDEX attachments_message_idx
  ON attachments (message_id)
  WHERE message_id IS NOT NULL;
