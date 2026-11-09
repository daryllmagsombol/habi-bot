-- H-032 (#32): account deletion path for immutable history tables.
--
-- 0013 and 0014 deliberately made artifact and skill version history
-- append-only, and both migrations name a future retention/purge lane (this
-- issue) as the owner of an explicit removal path. Account deletion is that
-- lane: the owner has asked to erase the account, so keeping immutable copies
-- of their generated artifacts or skill bodies would contradict the deletion
-- itself. Tombstoning is not sufficient here because `artifact_versions` and
-- `skill_versions` have no lifecycle column and are never reachable through a
-- tombstoned parent (the parent row is removed by the same account purge).
--
-- The guard is not a general-purpose escape hatch:
--
--   * it is transaction-local (`set_config(..., true)`), so it cannot leak to a
--     later statement or connection;
--   * it must be set deliberately by the account-deletion transaction, and no
--     product path sets it;
--   * it only permits DELETE. UPDATE remains forbidden, so version history is
--     still immutable for every writer.
--
-- `run_events` already permits a DELETE that is the foreign-key cascade from
-- its parent Run (trigger depth > 1), so the account purge removes those by
-- deleting the Run row; no change is needed there.
--
-- No table or column is added: deletion reuses the existing tombstone columns
-- on `users` and hard-deletes owned rows. A retention/tombstone column for an
-- account is therefore not needed for this slice.
--
-- 0013 indexed artifact listing by owner but not version history. Both export
-- and deletion read `artifact_versions` by owner and advance by
-- `(artifact_id, version)`, so add the matching owner-first index rather than
-- scanning every account's versions.
CREATE INDEX artifact_versions_owner_idx
  ON artifact_versions (owner_user_id, artifact_id, version);

CREATE OR REPLACE FUNCTION artifact_versions_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('habi.account_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'artifact versions are immutable'
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE OR REPLACE FUNCTION skill_versions_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('habi.account_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'skill_versions are immutable'
    USING ERRCODE = 'restrict_violation';
END;
$$;
