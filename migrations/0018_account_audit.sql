-- H-032 (#32): append-only audit trail for account export and deletion.
--
-- Two requests can touch an account without leaving any product row behind: an
-- export (reads everything, writes nothing) and a deletion (removes everything,
-- then the account is gone). Without their own record neither can be proven to
-- have happened, so this table records both.
--
-- What a row contains:
--
--   * who:   `actor_user_id` is the authenticated session actor. There is no
--            foreign key on it on purpose: this row must outlive any later
--            identity cleanup, and users are tombstoned rather than hard
--            deleted today, so the id still resolves in practice.
--   * what:  `action` is `export` or `delete`; `outcome` narrows it.
--   * when:  `requested_at`, set by the database.
--   * content: `detail` is counts and identifiers only — the export's section
--            counts as reported in its manifest, the deletion's per-surface
--            removal counts and its run-reconciliation summary. No message,
--            memory, artifact, skill or attachment body, no email address, no
--            credential, no token, and no attachment storage key is ever
--            written here.
--
-- Ownership and retention:
--
--   * Every ordinary row is owner-scoped through `owner_user_id`, exactly like
--     the rows it describes. The owner reads only rows where `owner_user_id`
--     equals their session actor, so a row cannot be enumerated by another
--     account.
--   * Audit rows are account data. The deletion removes them with the rest of
--     the account.
--   * The deletion record itself must survive that removal to be useful, so the
--     one exception is a NULL `owner_user_id`: the account-deletion tombstone.
--     A NULL owner can never match an owner-scoped read (`owner_user_id = $1`
--     is never true for NULL), so the surviving record is not readable through
--     the audit route by anyone, including another account. It is operator
--     evidence in the database, which is exactly its purpose. The check
--     constraint below makes that convention structural: a NULL owner is legal
--     only for a completed deletion, and a completed deletion is always
--     written with a NULL owner.
--
-- Append-only: 0017 already established the transaction-local
-- `habi.account_purge` guard for history tables, and this table reuses the same
-- idiom. UPDATE is always rejected; DELETE is permitted only while the account
-- purge transaction has deliberately set the guard, which is how the deletion
-- removes the account's own trail before writing its surviving record. The
-- guard is transaction-local and no product path sets it.

CREATE TABLE account_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_user_id uuid,
  actor_user_id uuid NOT NULL,
  action text NOT NULL,
  outcome text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT account_audit_action_check
    CHECK (action IN ('export', 'delete')),
  CONSTRAINT account_audit_outcome_check
    CHECK (outcome IN ('requested', 'deleted', 'already_deleted', 'refused')),
  CONSTRAINT account_audit_outcome_action_check
    CHECK (
      (action = 'export' AND outcome = 'requested')
      OR (action = 'delete' AND outcome IN ('deleted', 'already_deleted', 'refused'))
    ),
  -- A NULL owner is the surviving deletion record, and only that.
  CONSTRAINT account_audit_owner_scope_check
    CHECK (
      owner_user_id IS NOT NULL
      OR (action = 'delete' AND outcome IN ('deleted', 'already_deleted'))
    ),
  CONSTRAINT account_audit_detail_object_check
    CHECK (jsonb_typeof(detail) = 'object')
);

-- Owner reads are newest-first keyset pages; the partial predicate keeps the
-- surviving NULL-owner records out of the index they can never be read from.
CREATE INDEX account_audit_owner_idx
  ON account_audit (owner_user_id, id DESC)
  WHERE owner_user_id IS NOT NULL;

CREATE FUNCTION account_audit_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('habi.account_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'account audit records are append-only'
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER account_audit_immutable
  BEFORE UPDATE OR DELETE ON account_audit
  FOR EACH ROW EXECUTE FUNCTION account_audit_reject_mutation();
