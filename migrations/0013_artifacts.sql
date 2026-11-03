-- H-028 (#28): versioned, owner-scoped generated artifacts.
--
-- An Artifact is system-generated output (Markdown, plain text, or JSON text).
-- Attachments are user-supplied and live outside the database; artifacts store
-- their text content here, bounded to 1 MiB, so no client or model value ever
-- becomes a filesystem path. Content is always data: it is stored as `text`,
-- never parsed as HTML, executed, or used to resolve a path or capability.
--
-- Ownership is repeated on the row and proven by composite foreign keys, so a
-- read predicate never depends on a join-only guess:
--
--   owner_user_id                    -> users (id)
--   owner_user_id + conversation_id  -> conversations (id, owner_user_id)
--   owner_user_id + conversation_id +
--     run_id                         -> runs (id, conversation_id,
--                                         owner_user_id)
--   owner_user_id + artifact_id      -> artifacts (id, owner_user_id)
--                                        (artifact_versions)
--
-- `conversation_id` and `run_id` are nullable: an artifact may be user-level,
-- conversation-level, or produced by a run. A run reference requires a
-- conversation because the composite key proves all three coordinates agree.
--
-- Lifecycle (`status`):
--   draft   -> visible, editable; also the state of an incomplete generation
--   final   -> visible, stable; later edits still append versions
--   deleted -> tombstone; no read/update/restore path resolves it
--
-- Failed or partial writes are never persisted: create, update, and restore run
-- in one transaction, so a failure rolls the whole append back. There is no
-- separate `failed` row state in this slice; richer generation state belongs to
-- the run controller (#22).
--
-- Versions are append-only. The service never updates or deletes a version row;
-- `artifact_versions_immutable` additionally rejects both at the database level.
-- `artifacts.current_version` is kept pointing at an existing version by a
-- deferred composite foreign key, so the latest pointer cannot dangle.
--
-- Format scope is text only. PDF, Word, spreadsheets, and slides are explicitly
-- deferred; `kind` is a bounded set that a later migration extends, and an
-- unknown value is refused rather than silently accepted as text.

CREATE TABLE artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL,
  -- Optional conversation scope. NULL for a user-level artifact.
  conversation_id uuid,
  -- Optional producing run. Requires `conversation_id` (checked below).
  run_id uuid,
  -- Bounded, extensible output format. Rich document formats are not enabled.
  kind text NOT NULL
    CHECK (kind IN ('markdown', 'text', 'json')),
  -- Display title. Metadata only; never a path, filename, or capability.
  title text NOT NULL,
  -- Latest appended version. Starts at 1 and only advances.
  current_version integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'final', 'deleted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT artifacts_owner_fk
    FOREIGN KEY (owner_user_id) REFERENCES users (id),
  CONSTRAINT artifacts_conversation_owner_fk
    FOREIGN KEY (conversation_id, owner_user_id)
    REFERENCES conversations (id, owner_user_id),
  -- A named run must belong to the same conversation and owner. MATCH SIMPLE
  -- skips the check while `run_id` is NULL.
  CONSTRAINT artifacts_run_scope_fk
    FOREIGN KEY (run_id, conversation_id, owner_user_id)
    REFERENCES runs (id, conversation_id, owner_user_id),
  -- Lets artifact_versions prove it belongs to the same owner as the artifact.
  CONSTRAINT artifacts_id_owner_key UNIQUE (id, owner_user_id),
  CONSTRAINT artifacts_title_length
    CHECK (char_length(title) BETWEEN 1 AND 200 AND btrim(title) <> ''),
  CONSTRAINT artifacts_current_version_range
    CHECK (current_version >= 1),
  CONSTRAINT artifacts_deleted_at_matches_status
    CHECK ((status = 'deleted') = (deleted_at IS NOT NULL)),
  CONSTRAINT artifacts_run_requires_conversation
    CHECK (run_id IS NULL OR conversation_id IS NOT NULL)
);

-- Owner-scoped artifact listing: newest first with a stable id tiebreak.
-- Tombstoned rows never list, so the partial predicate keeps the index small.
CREATE INDEX artifacts_owner_updated_idx
  ON artifacts (owner_user_id, updated_at DESC, id DESC)
  WHERE deleted_at IS NULL;

-- Owner- and conversation-scoped listing, the primary access path.
CREATE INDEX artifacts_owner_conversation_updated_idx
  ON artifacts (owner_user_id, conversation_id, updated_at DESC, id DESC)
  WHERE deleted_at IS NULL AND conversation_id IS NOT NULL;

-- Resolving artifacts produced by one run (and any later run-scoped cleanup).
CREATE INDEX artifacts_run_idx
  ON artifacts (run_id)
  WHERE run_id IS NOT NULL;

CREATE TABLE artifact_versions (
  artifact_id uuid NOT NULL,
  -- Repeated owner column so every version predicate binds the owner directly.
  owner_user_id uuid NOT NULL,
  version integer NOT NULL,
  -- Exact generated text. This is authoritative content, not a display copy.
  content text NOT NULL,
  -- Lowercase SHA-256 of the UTF-8 content bytes. Re-verified on every read.
  content_sha256 text NOT NULL,
  -- UTF-8 byte length of `content`; `octet_length` agrees in the check below.
  byte_size integer NOT NULL,
  -- Actor that appended the version. In this slice that is always the owner.
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- The composite key is the uniqueness authority for (artifact_id, version):
  -- appending a duplicate version fails instead of rewriting history.
  CONSTRAINT artifact_versions_pkey PRIMARY KEY (artifact_id, version),
  CONSTRAINT artifact_versions_artifact_owner_fk
    FOREIGN KEY (artifact_id, owner_user_id)
    REFERENCES artifacts (id, owner_user_id),
  CONSTRAINT artifact_versions_created_by_fk
    FOREIGN KEY (created_by) REFERENCES users (id),
  CONSTRAINT artifact_versions_version_range
    CHECK (version >= 1),
  -- 1 MiB ceiling, matching MAX_ARTIFACT_CONTENT_BYTES in the service.
  CONSTRAINT artifact_versions_content_size
    CHECK (
      octet_length(content) <= 1048576
      AND byte_size = octet_length(content)
    ),
  CONSTRAINT artifact_versions_byte_size_range
    CHECK (byte_size >= 0 AND byte_size <= 1048576),
  CONSTRAINT artifact_versions_sha256_shape
    CHECK (content_sha256 ~ '^[0-9a-f]{64}$')
);

-- The latest pointer must resolve to a real version of the same artifact. It is
-- deferred because create inserts the artifact row before its first version in
-- one transaction.
ALTER TABLE artifacts
  ADD CONSTRAINT artifacts_current_version_fk
  FOREIGN KEY (id, current_version)
  REFERENCES artifact_versions (artifact_id, version)
  DEFERRABLE INITIALLY DEFERRED;

-- Rejects any rewrite or removal of a recorded version. A future retention or
-- purge lane must drop or replace this trigger explicitly; this slice only
-- tombstones the artifact row and keeps its history.
CREATE FUNCTION artifact_versions_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'artifact versions are immutable'
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER artifact_versions_immutable
  BEFORE UPDATE OR DELETE ON artifact_versions
  FOR EACH ROW
  EXECUTE FUNCTION artifact_versions_reject_mutation();

-- `current_version` may only advance; the service never rewinds the pointer,
-- and a stale pointer must not be reintroduced by a future writer.
CREATE FUNCTION artifacts_reject_version_regression()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.current_version < OLD.current_version THEN
    RAISE EXCEPTION 'artifact current_version cannot regress'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER artifacts_version_monotonic
  BEFORE UPDATE ON artifacts
  FOR EACH ROW
  EXECUTE FUNCTION artifacts_reject_version_regression();
