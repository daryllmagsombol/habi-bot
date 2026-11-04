-- H-015 (#15): Google, Microsoft, and Facebook sign-in.
--
-- Two tables, both owned by `apps/backend/src/auth/sso`. They implement the
-- H-008 §5 binding/transaction rules and the §7.1/§7.5 identity rules:
--
--   sso_pending_authorizations
--     One short-lived, single-use record per authorization request. `state_hash`
--     is the SHA-256 of the `state` sent to the provider; the raw value is never
--     stored. `browser_hash` is the SHA-256 of the per-flow pre-auth cookie, so a
--     callback must arrive in the browser that started the flow. `code_verifier`
--     and `nonce` stay server-side and are never returned to the browser.
--     `purpose = 'link'` rows carry the initiating user and a hash of the live
--     session secret; a link callback is only valid while that same session is
--     still usable. A login row may carry the hash of the invite token that was
--     submitted at start; the invite itself is validated atomically at
--     activation, never at start, so a bad invite cannot be probed.
--
--   sso_identities
--     Provider-scoped identity anchors. `(provider, subject)` is the identity
--     key, never an email address (H-008 §7.1). The row is unique per provider
--     and subject for the lifetime of the table, including after revocation, so
--     a revoked identity cannot be re-bound to a different account. `user_id` is
--     the owner scope: every read and write in the repository filters on it.
--     `email` is the provider-reported address kept for display/audit; it is
--     canonical (lowercase, trimmed) only so two representations of the same
--     address compare equal. `email_trusted` records whether a per-provider
--     trust predicate accepted that address; it never grants account access.
--
-- Revocation is `revoked_at`, not deletion: the unique identity key must survive
-- an unlink so a later account cannot silently claim the provider identity.
--
-- No provider secret, authorization code, access token, or id token is stored in
-- either table. Verification material is processed in memory only.

CREATE TABLE sso_pending_authorizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- SHA-256 hex of the random `state` value sent to the provider.
  state_hash text NOT NULL,
  -- SHA-256 hex of the pre-auth browser binding cookie.
  browser_hash text NOT NULL,
  provider text NOT NULL,
  purpose text NOT NULL,
  -- PKCE S256 verifier. Server-side only; never sent to the browser.
  code_verifier text NOT NULL,
  -- OIDC nonce echoed in the id_token. Server-side only.
  nonce text NOT NULL,
  -- Exact redirect URI used for the authorization request and the exchange.
  redirect_uri text NOT NULL,
  -- Relative, server-validated post-callback path. External URLs never reach here.
  return_to text NOT NULL DEFAULT '/',
  -- Link flows only: the initiating user and the hashed session secret.
  user_id uuid,
  session_hash text,
  -- Optional invite hash submitted at start; consumed atomically at activation.
  invite_token_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CONSTRAINT sso_pending_provider_valid
    CHECK (provider IN ('google', 'microsoft', 'facebook')),
  CONSTRAINT sso_pending_purpose_valid
    CHECK (purpose IN ('login', 'link')),
  CONSTRAINT sso_pending_state_hash_shape
    CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT sso_pending_browser_hash_shape
    CHECK (browser_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT sso_pending_session_hash_shape
    CHECK (session_hash IS NULL OR session_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT sso_pending_invite_hash_shape
    CHECK (invite_token_hash IS NULL OR invite_token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT sso_pending_verifier_shape
    CHECK (code_verifier ~ '^[A-Za-z0-9_-]{43,128}$'),
  CONSTRAINT sso_pending_nonce_shape
    CHECK (nonce ~ '^[A-Za-z0-9_-]{43,128}$'),
  CONSTRAINT sso_pending_redirect_uri_shape
    CHECK (char_length(redirect_uri) BETWEEN 8 AND 2048 AND redirect_uri LIKE 'http%'),
  CONSTRAINT sso_pending_return_to_shape
    CHECK (
      return_to = '/'
      OR (
        return_to LIKE '/%'
        AND return_to NOT LIKE '//%'
        AND char_length(return_to) <= 512
      )
    ),
  -- A link flow must name its user and session; a login flow must not.
  CONSTRAINT sso_pending_link_binding
    CHECK (
      (purpose = 'link') = (user_id IS NOT NULL)
      AND (purpose = 'link') = (session_hash IS NOT NULL)
    ),
  CONSTRAINT sso_pending_user_fk
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT sso_pending_expiry_after_creation
    CHECK (expires_at > created_at)
);

-- `state` is a lookup key and is single-use; the unique index turns a duplicate
-- state into a storage error rather than a silent second authorization.
ALTER TABLE sso_pending_authorizations
  ADD CONSTRAINT sso_pending_state_hash_key UNIQUE (state_hash);

-- Expiry inspection / future pruning. Callbacks never scan: they look up by hash.
CREATE INDEX sso_pending_expires_idx
  ON sso_pending_authorizations (expires_at);

CREATE TABLE sso_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Owner scope. Every repository statement filters on this column.
  user_id uuid NOT NULL,
  provider text NOT NULL,
  -- Provider-scoped subject: the identity key (H-008 §7.1). Never an email.
  subject text NOT NULL,
  -- Provider-reported address, canonicalized for comparison/display only.
  email text,
  -- True only when the provider trust predicate accepted `email`.
  email_trusted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  revoked_at timestamptz,
  CONSTRAINT sso_identities_user_fk
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT sso_identities_provider_valid
    CHECK (provider IN ('google', 'microsoft', 'facebook')),
  CONSTRAINT sso_identities_subject_length
    CHECK (char_length(subject) BETWEEN 1 AND 255),
  CONSTRAINT sso_identities_email_canonical
    CHECK (
      email IS NULL
      OR (
        email = btrim(email)
        AND email = lower(email)
        AND char_length(email) <= 254
        AND position('@' IN email) > 1
      )
    ),
  -- One account per provider subject, forever. Revocation does not release it.
  CONSTRAINT sso_identities_provider_subject_key UNIQUE (provider, subject),
  -- A trusted address is the only way an identity can be attached to an account.
  CONSTRAINT sso_identities_trusted_email_present
    CHECK (NOT email_trusted OR email IS NOT NULL)
);

-- Owner-scoped identity listing for the "show linked identities" surface.
CREATE INDEX sso_identities_user_idx
  ON sso_identities (user_id)
  WHERE revoked_at IS NULL;

-- Sign-in resolves by the identity key first; the unique constraint above backs it.
CREATE INDEX sso_identities_provider_subject_idx
  ON sso_identities (provider, subject);
