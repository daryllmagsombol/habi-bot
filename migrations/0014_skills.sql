-- H-031 (#31): reusable, owner-scoped Markdown skills.
--
-- A Skill is versioned Markdown guidance. It is data, never a capability:
-- nothing in this schema or the service layer may turn instruction text into a
-- tool grant, an authorization change, an HTML/script execution, or an
-- outbound fetch. The POC allow-list (H-006) stays empty regardless of what a
-- skill body claims.
--
-- Ownership:
--   - `owner_user_id` is repeated on every row and proved by foreign keys.
--   - `bot_id` is nullable. NULL means an owner-level skill that is not attached
--     to any Bot; a non-NULL value must name a Bot owned by the same user.
--   - Attachment is represented on the skill row instead of a separate
--     selection table, so one skill is attached to at most one Bot at a time.
--     `SkillService.attach/detach` is the only writer of that column.
--
-- Lifecycle (issue #31 work checklist):
--   draft    - created, editable, attachable.
--   active   - published for manual selection, editable, attachable.
--   archived - readable read-only history; not editable, not attachable.
--   deleted  - tombstone; readable by no product path, idempotent to repeat.
-- Archive and delete are distinct: `archived_at` is only set while archived,
-- and a tombstone clears it. `deleted_at` matches `status = 'deleted'`.
--
-- Versioning:
--   - `skills` holds the current snapshot and `version` is its version number.
--   - `skill_versions` is the immutable history, one row per version. A create
--     writes version 1 and every update inserts the next version before the
--     current row moves forward, in one transaction. History rows are never
--     updated or deleted by the service, and a trigger rejects both so the
--     guarantee does not depend on caller discipline.
--   - `(skill_id, version)` is unique, so a concurrent update cannot reuse a
--     version number.
--
-- Bounds are validation rules, not product quotas:
--   name        1-80 characters after trim, no C0/C1 controls
--   description 0-500 characters
--   body        0-65,536 bytes of UTF-8 (64 KiB)
--   version     integer >= 1
--
-- A live name is unique per owner (for unattached skills) and per owner + Bot
-- (for attached skills), case-insensitively, among draft and active rows.
-- Archived names are free to reuse; deleted tombstones never block a name.

CREATE TABLE skills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL,
  -- NULL = owner-level library entry; otherwise the one Bot it is attached to.
  bot_id uuid,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  -- Untrusted Markdown guidance. Stored verbatim as text; never executed.
  body_markdown text NOT NULL,
  -- Current version number. The matching snapshot lives in skill_versions.
  version integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'active', 'archived', 'deleted')),
  -- Set only while status = 'archived'.
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Set only while status = 'deleted'.
  deleted_at timestamptz,
  CONSTRAINT skills_owner_fk
    FOREIGN KEY (owner_user_id) REFERENCES users (id),
  -- The Bot a skill is attached to must belong to the same owner. A NULL
  -- bot_id is exempt under the default MATCH SIMPLE behavior, which keeps
  -- owner-level skills attachable later.
  CONSTRAINT skills_bot_owner_fk
    FOREIGN KEY (bot_id, owner_user_id) REFERENCES bots (id, owner_user_id),
  -- Lets skill_versions prove it belongs to the same owner without a join guess.
  CONSTRAINT skills_id_owner_key UNIQUE (id, owner_user_id),
  CONSTRAINT skills_name_length
    CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  CONSTRAINT skills_description_length
    CHECK (char_length(description) <= 500),
  -- 64 KiB measured in bytes, matching the service's UTF-8 byte check.
  CONSTRAINT skills_body_bytes
    CHECK (octet_length(body_markdown) <= 65536),
  CONSTRAINT skills_version_positive CHECK (version >= 1),
  CONSTRAINT skills_archived_at_matches_status
    CHECK ((status = 'archived') = (archived_at IS NOT NULL)),
  CONSTRAINT skills_deleted_at_matches_status
    CHECK ((status = 'deleted') = (deleted_at IS NOT NULL))
);

-- Owner-scoped keyset listing: `(updated_at DESC, id DESC)`.
CREATE INDEX skills_owner_updated_id_idx
  ON skills (owner_user_id, updated_at DESC, id DESC)
  WHERE deleted_at IS NULL;

-- Owner/attachment/status inspection. Also narrows a Bot-scoped list.
CREATE INDEX skills_owner_bot_status_idx
  ON skills (owner_user_id, bot_id, status)
  WHERE deleted_at IS NULL;

-- One live name per owner among unattached skills. Archived/deleted names are
-- released so a user can reuse a name after archiving or deleting.
CREATE UNIQUE INDEX skills_owner_name_live_key
  ON skills (owner_user_id, lower(name))
  WHERE bot_id IS NULL AND status IN ('draft', 'active');

-- One live name per owner + Bot among attached skills.
CREATE UNIQUE INDEX skills_owner_bot_name_live_key
  ON skills (owner_user_id, bot_id, lower(name))
  WHERE bot_id IS NOT NULL AND status IN ('draft', 'active');

-- Immutable version history. Every snapshot repeats owner scope so a version
-- can be read with an owner predicate and no join to `skills`.
CREATE TABLE skill_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  version integer NOT NULL,
  -- Full snapshot: a run that pins (skill_id, version) can identify exactly
  -- what guidance was selected even after the current row moves forward.
  name text NOT NULL,
  description text NOT NULL,
  body_markdown text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT skill_versions_owner_fk
    FOREIGN KEY (owner_user_id) REFERENCES users (id),
  CONSTRAINT skill_versions_skill_owner_fk
    FOREIGN KEY (skill_id, owner_user_id) REFERENCES skills (id, owner_user_id),
  CONSTRAINT skill_versions_skill_version_key UNIQUE (skill_id, version),
  CONSTRAINT skill_versions_version_positive CHECK (version >= 1),
  CONSTRAINT skill_versions_name_length
    CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  CONSTRAINT skill_versions_description_length
    CHECK (char_length(description) <= 500),
  CONSTRAINT skill_versions_body_bytes
    CHECK (octet_length(body_markdown) <= 65536)
);

-- Version history replay, newest first.
CREATE INDEX skill_versions_skill_version_idx
  ON skill_versions (skill_id, version DESC);

CREATE INDEX skill_versions_owner_created_idx
  ON skill_versions (owner_user_id, created_at DESC, id DESC);

-- Reject direct mutation of history, including a delete that a future parent
-- purge might attempt. The parent `skills` row is tombstoned, never hard
-- deleted in this slice, so no cascade exemption is needed. A retention purge
-- (deferred to #32) must use TRUNCATE or drop/recreate the table deliberately.
CREATE FUNCTION skill_versions_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'skill_versions are immutable'
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER skill_versions_immutable
  BEFORE UPDATE OR DELETE ON skill_versions
  FOR EACH ROW
  EXECUTE FUNCTION skill_versions_reject_mutation();
