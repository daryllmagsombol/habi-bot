-- H-014 (#14), first identity slice; H-008 §7.2-§7.6 and H-017 §6.
--
-- 0001 created the tenancy root only. This migration adds the credential and
-- invite columns the invite-gated email/password flow needs. It does not add
-- SSO identities (#15), a registration-transaction table, session persistence
-- (#17), or an email sender. Those remain later slices.
--
-- Canonical email: the slice stores one lowercase, trimmed string in `email`.
-- H-008 §7.2 preserves the local part exactly; lowercasing the whole address is
-- the conservative comparison rule this slice uses, and the application
-- canonicalizer (apps/backend/src/auth/email.ts) is the only writer. The CHECK
-- constraints keep storage honest if a future caller bypasses the service.
--
-- `email` and `password_hash` stay nullable because existing rows and the
-- separate SSO-only path (#15) can legitimately lack a password. An active
-- account is at most one canonical email; a disabled account does not block a
-- later active account from reusing the address.

ALTER TABLE users
  ADD COLUMN email text;
ALTER TABLE users
  ADD COLUMN password_hash text;
ALTER TABLE users
  ADD COLUMN email_verified_at timestamptz;
ALTER TABLE users
  ADD COLUMN recovery_email text;

ALTER TABLE users
  ADD CONSTRAINT users_email_canonical
  CHECK (
    email IS NULL
    OR (
      email = btrim(email)
      AND email = lower(email)
      AND char_length(email) <= 254
      AND position('@' IN email) > 1
    )
  );
ALTER TABLE users
  ADD CONSTRAINT users_recovery_email_canonical
  CHECK (
    recovery_email IS NULL
    OR (
      recovery_email = btrim(recovery_email)
      AND recovery_email = lower(recovery_email)
      AND char_length(recovery_email) <= 254
      AND position('@' IN recovery_email) > 1
    )
  );

-- One active account per canonical email (H-008 §7.2). Partial so a deleted or
-- disabled account keeps its historical row without blocking the address.
CREATE UNIQUE INDEX users_email_active_key
  ON users (email)
  WHERE email IS NOT NULL AND status = 'active';

-- Invites are email-bound and single-use (H-008 §4.5, §7.3). Only the SHA-256
-- token hash is stored; the raw token exists only in the invitation delivery
-- path, which is not implemented in this slice.
--
-- `created_by` is nullable so an operator/bootstrap path can issue the first
-- invite before any account exists. It is not an authorization input.
CREATE TABLE invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  token_hash text NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  CONSTRAINT invites_created_by_fk
    FOREIGN KEY (created_by) REFERENCES users (id),
  CONSTRAINT invites_email_canonical
    CHECK (
      email = btrim(email)
      AND email = lower(email)
      AND char_length(email) <= 254
      AND position('@' IN email) > 1
    ),
  CONSTRAINT invites_token_hash_shape
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT invites_expiry_after_creation
    CHECK (expires_at > created_at)
);

-- A raw token is never reissued; the hash is the lookup key.
ALTER TABLE invites
  ADD CONSTRAINT invites_token_hash_key UNIQUE (token_hash);

-- At most one unused invite per canonical email. Reissuing after use is
-- allowed once the old invite is consumed.
CREATE UNIQUE INDEX invites_email_unused_key
  ON invites (email)
  WHERE used_at IS NULL;

CREATE INDEX invites_created_by_idx ON invites (created_by);

-- Recovery creates a single-use, expiring, hashed token (H-008 §4.4, §7.6).
-- This slice records creation only: no email is sent and no completion route
-- exists yet, so no password can be changed by the raw-token holder.
CREATE TABLE password_reset_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  token_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  CONSTRAINT password_reset_tokens_user_fk
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT password_reset_tokens_token_hash_shape
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT password_reset_tokens_expiry_after_creation
    CHECK (expires_at > created_at)
);

ALTER TABLE password_reset_tokens
  ADD CONSTRAINT password_reset_tokens_token_hash_key UNIQUE (token_hash);

-- The service invalidates an earlier outstanding token before inserting a new
-- one, so this partial index holds at most one usable token per user.
CREATE UNIQUE INDEX password_reset_tokens_user_active_key
  ON password_reset_tokens (user_id)
  WHERE used_at IS NULL;

CREATE INDEX password_reset_tokens_expires_idx
  ON password_reset_tokens (expires_at);
