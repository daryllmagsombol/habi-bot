-- H-024 (#24) and H-002 §3.2: editable Bot profile fields.
--
-- 0001 created only the tenancy link the conversation aggregate needs. This
-- migration extends that table in place; it does not replace the ownership
-- constraints or the `(id, owner_user_id)` key used by conversations.
--
-- A Bot's instructions are untrusted Markdown guidance. They never grant a
-- capability; effective capability is enforced outside this schema (#6/#21).
-- `deleted_at` remains reserved for the separate hard-delete path (Deferred),
-- while D1 removal with conversations archives the Bot.

-- Existing rows predate the profile fields. `Untitled Bot` is the documented
-- default for a legacy/creation-path row that supplied no name; profile-aware
-- callers always pass an explicit name through BotService.
ALTER TABLE bots
  ADD COLUMN name text NOT NULL DEFAULT 'Untitled Bot';
ALTER TABLE bots
  ADD COLUMN description text NOT NULL DEFAULT '';
ALTER TABLE bots
  ADD COLUMN avatar_ref text;
ALTER TABLE bots
  ADD COLUMN instructions_markdown text NOT NULL DEFAULT '';

-- D1: archive is a lifecycle state, not erasure. The timestamp makes the state
-- auditable and lets archive stay idempotent under concurrent requests.
ALTER TABLE bots
  ADD COLUMN archived_at timestamptz;

UPDATE bots
   SET archived_at = updated_at
 WHERE status = 'archived'
   AND archived_at IS NULL;

ALTER TABLE bots
  ADD CONSTRAINT bots_name_length
  CHECK (char_length(btrim(name)) BETWEEN 1 AND 80);

ALTER TABLE bots
  ADD CONSTRAINT bots_description_length
  CHECK (char_length(description) <= 500);

ALTER TABLE bots
  ADD CONSTRAINT bots_avatar_ref_length
  CHECK (avatar_ref IS NULL OR char_length(btrim(avatar_ref)) BETWEEN 1 AND 512);

ALTER TABLE bots
  ADD CONSTRAINT bots_instructions_length
  CHECK (char_length(instructions_markdown) <= 20000);

-- `deleted_at` and archive are distinct: a tombstone is not archived.
ALTER TABLE bots
  ADD CONSTRAINT bots_archived_at_matches_status
  CHECK ((status = 'archived') = (archived_at IS NOT NULL));

-- Owner-scoped listing is keyset paginated on `(updated_at DESC, id DESC)`.
-- The existing `bots_owner_updated_idx` cannot break ties on id; this index
-- supports the complete ordering and skips tombstoned rows.
CREATE INDEX bots_owner_updated_id_idx
  ON bots (owner_user_id, updated_at DESC, id DESC)
  WHERE deleted_at IS NULL;
