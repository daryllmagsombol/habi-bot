-- H-017 (#17): durable login sessions.
--
-- The P1 stack authenticated requests from an in-process session store, so a
-- restart dropped every session and a backup restore could only verify
-- ownership at the data/service layer (runbook residual risk #1). This table
-- is the durable record behind the same `SessionService` contract: cookie
-- names and flags, idle and absolute expiry, rotation lineage, revocation and
-- the `401 unauthenticated` / `403 csrf_invalid` failure shapes are unchanged.
--
-- What a row may contain:
--
--   * `verifier_hash` is SHA-256 hex of the opaque 256-bit session secret. The
--     raw secret is never written here, so a database dump cannot be replayed
--     as a cookie. The row is looked up by that hash, never by the secret.
--   * `csrf_hash` is SHA-256 hex of the synchronizer CSRF token. The token
--     itself is client-held (design §3) and is verified by hashing what the
--     client presents and comparing in constant time, so it is not recoverable
--     from this table either.
--   * `user_agent_hash` and `ip_hash` are salted HMACs used as coarse device
--     descriptors; the raw User-Agent and address are never stored, and no
--     authorization decision reads them.
--   * `revoked_at` / `revoked_reason` are the single revocation fact. Expiry is
--     not a reason to delete a row immediately: a retired verifier is kept for
--     `SESSION_RETIRED_RETENTION_MS` (design §9 D7, 24 hours) so replay of a
--     rotated secret can still be detected, then it is purged by the bounded
--     sweep. Nothing authenticates because a row exists past its window: the
--     service evaluates `idle_expires_at` and `absolute_expires_at` on every
--     validation.
--
-- Ownership:
--
--   * `owner_user_id` is the one user the session serves, with a foreign key so
--     a hard-deleted account cannot leave a live session behind. Account
--     deletion (0017) revokes before tombstoning; users are tombstoned rather
--     than hard deleted today, so the cascade is the belt to that brace.
--   * `session_family_id` groups rotations so reuse of a retired secret can
--     revoke the whole family.
--   * `rotated_from_id` is nullable lineage. `ON DELETE SET NULL` because a
--     swept ancestor must never block sweeping a retired descendant, and reuse
--     detection only needs the live chain.
--
-- Indexes exist for the three access paths that will actually run: the verifier
-- lookup (the unique constraint), the owner-scoped read and owner-wide
-- revocation, and the expiry sweep.

CREATE TABLE auth_sessions (
  -- Supplied by the application so a node can mint a record and write it
  -- without a round trip to read a generated key.
  id uuid PRIMARY KEY,
  session_family_id uuid NOT NULL,
  -- SHA-256 hex of the opaque session secret. Never the secret.
  verifier_hash text NOT NULL,
  owner_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  idle_expires_at timestamptz NOT NULL,
  -- Fixed at creation and inherited by rotations; never extended.
  absolute_expires_at timestamptz NOT NULL,
  rotated_from_id uuid,
  revoked_at timestamptz,
  revoked_reason text,
  -- SHA-256 hex of the per-session CSRF token. Never the token.
  csrf_hash text NOT NULL,
  user_agent_hash text,
  ip_hash text,
  CONSTRAINT auth_sessions_owner_fk
    FOREIGN KEY (owner_user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT auth_sessions_rotated_from_fk
    FOREIGN KEY (rotated_from_id) REFERENCES auth_sessions (id) ON DELETE SET NULL,
  CONSTRAINT auth_sessions_verifier_key
    UNIQUE (verifier_hash),
  CONSTRAINT auth_sessions_verifier_hash_check
    CHECK (verifier_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT auth_sessions_csrf_hash_check
    CHECK (csrf_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT auth_sessions_observer_hash_check
    CHECK (
      (user_agent_hash IS NULL OR user_agent_hash ~ '^[0-9a-f]{64}$')
      AND (ip_hash IS NULL OR ip_hash ~ '^[0-9a-f]{64}$')
    ),
  -- Revocation is one fact: a timestamp and its reason are set together.
  CONSTRAINT auth_sessions_revocation_check
    CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL)),
  CONSTRAINT auth_sessions_revoked_reason_check
    CHECK (
      revoked_reason IS NULL
      OR revoked_reason IN (
        'logout',
        'logout_all',
        'rotated',
        'idle_expired',
        'absolute_expired',
        'reuse_detected',
        'family_revoked'
      )
    ),
  -- The windows are monotone, so a row cannot record having been seen before
  -- it existed, an idle window longer than the absolute one, or an idle
  -- deadline before the last use.
  CONSTRAINT auth_sessions_window_check
    CHECK (
      created_at <= last_seen_at
      AND last_seen_at <= idle_expires_at
      AND idle_expires_at <= absolute_expires_at
    )
);

-- Owner-scoped reads (`listForUser`) and owner-wide revocation (`logout-all`).
CREATE INDEX auth_sessions_owner_idx
  ON auth_sessions (owner_user_id, created_at);

-- Family revocation, including reuse detection after a rotated secret replays.
CREATE INDEX auth_sessions_family_idx
  ON auth_sessions (session_family_id);

-- The expiry sweep's hard bound: a row past its absolute expiry can be dropped
-- once the retired-verifier retention window has also passed.
CREATE INDEX auth_sessions_absolute_expiry_idx
  ON auth_sessions (absolute_expires_at);

-- The other half of the sweep: rows retired long enough ago to stop being
-- useful for reuse detection. Partial, because live rows are never selected.
CREATE INDEX auth_sessions_revoked_idx
  ON auth_sessions (revoked_at)
  WHERE revoked_at IS NOT NULL;
