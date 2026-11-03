-- H-027 (#27): derived, owner-scoped text extraction for attachments.
--
-- An attachment is untrusted uploaded content. Extraction produces derived
-- text, so every chunk repeats the source attachment's owner and conversation
-- and proves that scope with a composite foreign key. A read predicate never
-- depends on a join-only guess, and one user's extracted text is never reachable
-- through another user's id.
--
-- Offsets are half-open UTF-16 code-unit indices into the normalized text that
-- the service derived from the attachment bytes. They are not byte offsets and
-- are only meaningful together with the attachment's verified content hash.
-- `chunk_index` is the ordering authority; `created_at` is display metadata and
-- is not used for ordering.
--
-- Derived rows are deleted, not archived:
--   - a hard delete of the attachment cascades to its chunks;
--   - a tombstone (the only delete path exposed by H-026) removes the chunks in
--     the same statement, so extracted text cannot outlive the source row.
-- Re-extraction replaces all chunks for one attachment inside a transaction, so
-- a repeat is idempotent and never leaves a mixed set.

-- A3 of 0003 patterns the composite key used below. This additive constraint
-- lets a chunk prove it belongs to the exact attachment in the same owner and
-- conversation without a trigger or a change to attachment behavior.
ALTER TABLE attachments
  ADD CONSTRAINT attachments_id_conversation_owner_key
  UNIQUE (id, conversation_id, owner_user_id);

CREATE TABLE document_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attachment_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  -- Zero-based position in the deterministic chunk sequence.
  chunk_index integer NOT NULL,
  -- Exact slice of the normalized document text. Unicode length, not bytes.
  text text NOT NULL,
  -- Half-open [start_offset, end_offset) in the normalized UTF-16 text.
  start_offset integer NOT NULL,
  end_offset integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT document_chunks_attachment_scope_fk
    FOREIGN KEY (attachment_id, conversation_id, owner_user_id)
    REFERENCES attachments (id, conversation_id, owner_user_id)
    ON DELETE CASCADE,
  -- One position per attachment. This is also the re-extraction idempotency
  -- authority: a duplicate insert fails instead of mixing two extractions.
  CONSTRAINT document_chunks_attachment_chunk_key
    UNIQUE (attachment_id, chunk_index),
  CONSTRAINT document_chunks_chunk_index_nonnegative
    CHECK (chunk_index >= 0),
  CONSTRAINT document_chunks_text_length
    CHECK (char_length(text) BETWEEN 1 AND 1200),
  CONSTRAINT document_chunks_offset_range
    CHECK (start_offset >= 0 AND end_offset > start_offset),
  -- A chunk cannot claim a span smaller than one character. The service also
  -- requires end_offset - start_offset to equal the UTF-16 length of `text`;
  -- PostgreSQL counts code points, so the database only guards the basic shape.
  CONSTRAINT document_chunks_offset_span_positive
    CHECK (end_offset - start_offset >= 1)
);

-- Owner-scoped chunk replay for one attachment, in order.
CREATE INDEX document_chunks_owner_attachment_idx
  ON document_chunks (owner_user_id, attachment_id, chunk_index);

-- Owner-scoped chunk search within one conversation. The text predicate is a
-- bounded scan over this scope; no trigram extension or external index is
-- required by this lane.
CREATE INDEX document_chunks_owner_conversation_idx
  ON document_chunks (owner_user_id, conversation_id, attachment_id, chunk_index);

-- Tombstone cleanup. H-026 exposes soft delete only, so the cascade above does
-- not fire until a later purge hard-deletes the attachment. Removing chunks in
-- the same update keeps derived text from surviving the source tombstone.
CREATE FUNCTION document_chunks_delete_on_attachment_tombstone()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM document_chunks WHERE attachment_id = NEW.id;
  RETURN NULL;
END;
$$;

CREATE TRIGGER attachments_tombstone_document_chunks
  AFTER UPDATE OF status ON attachments
  FOR EACH ROW
  WHEN (NEW.status = 'deleted' AND OLD.status <> 'deleted')
  EXECUTE FUNCTION document_chunks_delete_on_attachment_tombstone();
