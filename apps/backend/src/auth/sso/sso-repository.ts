/**
 * PostgreSQL storage for the SSO slice.
 *
 * Design rules enforced here rather than in the service:
 *
 * - State consumption, identity resolution, invite redemption, and account
 *   creation share one transaction. A lost race therefore rolls back fully: no
 *   consumed invite without an account, no identity without a user, no session
 *   for a failed activation.
 * - `(provider, subject)` is unique. A second account can never claim an
 *   identity, and a revoked identity keeps its binding so it cannot be re-bound
 *   to a different user later.
 * - A new identity may only be attached to an existing account when the
 *   provider's verified email equals that account's canonical email. A new
 *   account may only be created through the invite gate. There is no
 *   email-based merge path.
 * - Unlink is owner-scoped and refuses to remove the last working auth method.
 *
 * Only this module touches `sso_*` tables. No token, code, or verifier is stored
 * in `sso_identities`; the short-lived verifier lives only in the pending row and
 * is deleted with it.
 */
import type { Pool, PoolClient } from 'pg';
import { withTransaction } from '../../persistence/database.js';
import { isUniqueViolation } from '../../persistence/errors.js';
import { SsoError } from './sso-errors.js';
import type {
  CompleteSsoLinkInput,
  CompleteSsoLoginInput,
  CompleteSsoLoginResult,
  CreatePendingAuthorizationInput,
  SsoIdentityRecord,
  SsoLinkedIdentity,
  SsoPendingAuthorization,
  SsoProviderId,
  SsoRepositoryPort,
  SsoPurpose,
  UnlinkIdentityInput,
} from './sso-types.js';

/**
 * `timestamptz`/`timestamp` columns arrive either as `Date` (pg typings) or as
 * text, depending on the query path.
 */
type DbTime = Date | string;

interface PendingRow {
  id: string;
  provider: SsoProviderId;
  purpose: SsoPurpose;
  browser_hash: string;
  code_verifier: string;
  nonce: string;
  redirect_uri: string;
  return_to: string;
  user_id: string | null;
  session_hash: string | null;
  invite_token_hash: string | null;
  consumed_at: DbTime | null;
  expires_at: DbTime;
}

interface IdentityRow {
  id: string;
  user_id: string;
  revoked_at: DbTime | null;
}

interface InviteRow {
  id: string;
  email: string;
  expires_at: DbTime;
  used_at: DbTime | null;
}

interface AccountRow {
  readonly id: string;
  readonly email: string;
}

function asTime(value: DbTime): number {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

function signupUnavailable(): SsoError {
  return new SsoError('signup_unavailable');
}

function linkUnavailable(): SsoError {
  return new SsoError('link_unavailable');
}

function stateInvalid(): SsoError {
  return new SsoError('sso_state_invalid');
}

/** Locks and validates the pending record; the caller is already in a transaction. */
async function lockPending(
  client: PoolClient,
  pendingId: string,
  at: Date,
  purpose: SsoPurpose,
): Promise<PendingRow> {
  const result = await client.query<PendingRow>(
    `SELECT id, provider, purpose, browser_hash, code_verifier, nonce, redirect_uri,
            return_to, user_id, session_hash, invite_token_hash, consumed_at, expires_at
       FROM sso_pending_authorizations
      WHERE id = $1
      FOR UPDATE`,
    [pendingId],
  );
  const row = result.rows[0];

  if (
    row?.consumed_at !== null ||
    asTime(row.expires_at) <= at.getTime() ||
    row.purpose !== purpose
  ) {
    throw stateInvalid();
  }

  return row;
}

async function consumePending(
  client: PoolClient,
  pendingId: string,
  at: Date,
): Promise<void> {
  const consumed = await client.query(
    `UPDATE sso_pending_authorizations
        SET consumed_at = $2
      WHERE id = $1
        AND consumed_at IS NULL`,
    [pendingId, at],
  );

  if (consumed.rowCount !== 1) {
    throw stateInvalid();
  }
}

function assertPendingProvider(pending: PendingRow, provider: SsoProviderId): void {
  if (pending.provider !== provider) {
    throw stateInvalid();
  }
}

/**
 * Resolves an already-bound identity. A revoked identity is a deliberate unlink
 * and must not sign in again; a missing or inactive account fails the login.
 * Returns `undefined` when no identity exists yet, so the caller can create one.
 */
async function resolveExistingLoginIdentity(
  client: PoolClient,
  pendingId: string,
  input: CompleteSsoLoginInput,
): Promise<CompleteSsoLoginResult | undefined> {
  const identityResult = await client.query<IdentityRow>(
    `SELECT id, user_id, revoked_at
       FROM sso_identities
      WHERE provider = $1 AND subject = $2
      FOR UPDATE`,
    [input.provider, input.subject],
  );
  const existing = identityResult.rows[0];

  if (existing === undefined) {
    return undefined;
  }

  if (existing.revoked_at !== null) {
    throw new SsoError('sso_failed');
  }

  const account = await lockActiveAccountForLogin(client, existing.user_id);

  await client.query(
    'UPDATE sso_identities SET last_login_at = $2 WHERE id = $1',
    [existing.id, input.at],
  );
  await consumePending(client, pendingId, input.at);

  return { userId: account.id, email: account.email, created: false };
}

async function lockActiveAccountForLogin(
  client: PoolClient,
  userId: string,
): Promise<AccountRow> {
  const result = await client.query<AccountRow>(
    `SELECT id, email
       FROM users
      WHERE id = $1
        AND status = 'active'
        AND deleted_at IS NULL
        AND email IS NOT NULL
      FOR UPDATE`,
    [userId],
  );
  const account = result.rows[0];

  if (account === undefined) {
    throw new SsoError('sso_failed');
  }

  return account;
}

/**
 * A new account may only be created from a verified address and a valid,
 * email-bound invite. An unverified provider address is refused before any
 * account lookup, so the response cannot reveal one. The invite row is locked
 * for the rest of the transaction.
 */
async function lockRedeemableInvite(
  client: PoolClient,
  input: CompleteSsoLoginInput,
  pending: PendingRow,
): Promise<InviteRow> {
  if (input.email === undefined) {
    throw new SsoError('sso_email_unverified');
  }

  const collision = await client.query(
    `SELECT id FROM users WHERE email = $1 AND status = 'active' LIMIT 1`,
    [input.email],
  );

  if (collision.rowCount !== 0) {
    throw signupUnavailable();
  }

  if (pending.invite_token_hash === null) {
    throw signupUnavailable();
  }

  const inviteResult = await client.query<InviteRow>(
    `SELECT id, email, expires_at, used_at
       FROM invites
      WHERE token_hash = $1
      FOR UPDATE`,
    [pending.invite_token_hash],
  );
  const invite = inviteResult.rows[0];

  if (
    invite?.used_at !== null ||
    asTime(invite.expires_at) <= input.at.getTime() ||
    invite.email !== input.email
  ) {
    throw signupUnavailable();
  }

  return invite;
}

/** Inserts the account and its identity; either unique collision is refused. */
async function createInvitedAccount(
  client: PoolClient,
  input: CompleteSsoLoginInput,
  email: string,
): Promise<AccountRow> {
  let account: AccountRow;

  try {
    const inserted = await client.query<AccountRow>(
      `INSERT INTO users (email, email_verified_at)
       VALUES ($1, $2)
       RETURNING id, email`,
      [email, input.at],
    );
    const row = inserted.rows[0];

    if (row === undefined) {
      throw signupUnavailable();
    }

    account = row;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw signupUnavailable();
    }

    throw error;
  }

  try {
    await client.query(
      `INSERT INTO sso_identities (
         user_id, provider, subject, email, email_trusted, last_login_at
       ) VALUES ($1, $2, $3, $4, true, $5)`,
      [account.id, input.provider, input.subject, email, input.at],
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw signupUnavailable();
    }

    throw error;
  }

  return account;
}

async function consumeInvite(
  client: PoolClient,
  inviteId: string,
  at: Date,
): Promise<void> {
  const consumed = await client.query(
    'UPDATE invites SET used_at = $2 WHERE id = $1 AND used_at IS NULL',
    [inviteId, at],
  );

  if (consumed.rowCount !== 1) {
    throw signupUnavailable();
  }
}

/**
 * The verified provider email must be this account's canonical email. This is
 * what stops an authenticated attacker from attaching their own provider
 * identity to someone else's account.
 */
function assertLinkableToAccount(
  account: { readonly email: string | null },
  email: string,
): void {
  if (account.email === null || account.email !== email) {
    throw linkUnavailable();
  }
}

function assertIdentityOwnedByUser(identity: IdentityRow, userId: string): void {
  if (identity.user_id !== userId) {
    throw linkUnavailable();
  }
}

async function insertLinkedIdentity(
  client: PoolClient,
  input: CompleteSsoLinkInput,
): Promise<void> {
  try {
    await client.query(
      `INSERT INTO sso_identities (
         user_id, provider, subject, email, email_trusted, last_login_at
       ) VALUES ($1, $2, $3, $4, true, $5)`,
      [input.userId, input.provider, input.subject, input.email, input.at],
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw linkUnavailable();
    }

    throw error;
  }
}

async function relinkIdentity(
  client: PoolClient,
  identityId: string,
  input: CompleteSsoLinkInput,
): Promise<void> {
  await client.query(
    `UPDATE sso_identities
        SET email = $2,
            email_trusted = true,
            revoked_at = NULL,
            last_login_at = $3
      WHERE id = $1`,
    [identityId, input.email, input.at],
  );
}

export class SsoRepository implements SsoRepositoryPort {
  constructor(private readonly pool: Pool) {}

  async createPending(input: CreatePendingAuthorizationInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO sso_pending_authorizations (
         state_hash, browser_hash, provider, purpose, code_verifier, nonce,
         redirect_uri, return_to, user_id, session_hash, invite_token_hash,
         created_at, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        input.stateHash,
        input.browserHash,
        input.provider,
        input.purpose,
        input.codeVerifier,
        input.nonce,
        input.redirectUri,
        input.returnTo,
        input.userId ?? null,
        input.sessionHash ?? null,
        input.inviteTokenHash ?? null,
        input.at,
        input.expiresAt,
      ],
    );
  }

  async findPending(
    stateHash: string,
    provider: SsoProviderId,
    at: Date,
  ): Promise<SsoPendingAuthorization | undefined> {
    const result = await this.pool.query<PendingRow>(
      `SELECT id, provider, purpose, browser_hash, code_verifier, nonce, redirect_uri,
              return_to, user_id, session_hash, invite_token_hash, expires_at
         FROM sso_pending_authorizations
        WHERE state_hash = $1
          AND provider = $2
          AND consumed_at IS NULL
          AND expires_at > $3
        LIMIT 1`,
      [stateHash, provider, at],
    );
    const row = result.rows[0];

    if (row === undefined) {
      return undefined;
    }

    return {
      id: row.id,
      provider: row.provider,
      purpose: row.purpose,
      browserHash: row.browser_hash,
      codeVerifier: row.code_verifier,
      nonce: row.nonce,
      redirectUri: row.redirect_uri,
      returnTo: row.return_to,
      userId: row.user_id,
      sessionHash: row.session_hash,
      inviteTokenHash: row.invite_token_hash,
      expiresAt: asTime(row.expires_at),
    };
  }

  async completeLogin(input: CompleteSsoLoginInput): Promise<CompleteSsoLoginResult> {
    return withTransaction(this.pool, async (client) => {
      const pending = await lockPending(client, input.pendingId, input.at, 'login');

      assertPendingProvider(pending, input.provider);

      const existing = await resolveExistingLoginIdentity(
        client,
        input.pendingId,
        input,
      );

      if (existing !== undefined) {
        return existing;
      }

      // Closed registration refuses a new account but not an existing identity,
      // which was already resolved above.
      if (!input.allowRegistration) {
        throw new SsoError('registration_closed');
      }

      const invite = await lockRedeemableInvite(client, input, pending);
      const account = await createInvitedAccount(client, input, invite.email);

      await consumeInvite(client, invite.id, input.at);
      await consumePending(client, input.pendingId, input.at);

      return { userId: account.id, email: account.email, created: true };
    });
  }

  async completeLink(input: CompleteSsoLinkInput): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const pending = await lockPending(client, input.pendingId, input.at, 'link');

      assertPendingProvider(pending, input.provider);

      const userResult = await client.query<{ id: string; email: string | null }>(
        `SELECT id, email
           FROM users
          WHERE id = $1
            AND status = 'active'
            AND deleted_at IS NULL
          FOR UPDATE`,
        [input.userId],
      );
      const user = userResult.rows[0];

      if (user === undefined) {
        throw linkUnavailable();
      }

      assertLinkableToAccount(user, input.email);

      const identityResult = await client.query<IdentityRow>(
        `SELECT id, user_id, revoked_at
           FROM sso_identities
          WHERE provider = $1 AND subject = $2
          FOR UPDATE`,
        [input.provider, input.subject],
      );
      const identity = identityResult.rows[0];

      if (identity === undefined) {
        await insertLinkedIdentity(client, input);
      } else {
        assertIdentityOwnedByUser(identity, input.userId);
        await relinkIdentity(client, identity.id, input);
      }

      await consumePending(client, input.pendingId, input.at);
    });
  }

  async findIdentity(
    provider: SsoProviderId,
    subject: string,
  ): Promise<SsoIdentityRecord | undefined> {
    const result = await this.pool.query<IdentityRow>(
      `SELECT id, user_id, revoked_at
         FROM sso_identities
        WHERE provider = $1 AND subject = $2
        LIMIT 1`,
      [provider, subject],
    );
    const row = result.rows[0];

    if (row === undefined) {
      return undefined;
    }

    return {
      userId: row.user_id,
      revokedAt: row.revoked_at === null ? null : asTime(row.revoked_at),
    };
  }

  async listIdentities(userId: string): Promise<SsoLinkedIdentity[]> {
    const result = await this.pool.query<{
      provider: SsoProviderId;
      email: string | null;
      email_trusted: boolean;
      created_at: DbTime;
      last_login_at: DbTime | null;
    }>(
      `SELECT provider, email, email_trusted, created_at, last_login_at
         FROM sso_identities
        WHERE user_id = $1
          AND revoked_at IS NULL
        ORDER BY created_at ASC, id ASC`,
      [userId],
    );

    return result.rows.map((row) => ({
      provider: row.provider,
      email: row.email,
      emailTrusted: row.email_trusted,
      linkedAt: new Date(asTime(row.created_at)).toISOString(),
      lastLoginAt:
        row.last_login_at === null
          ? null
          : new Date(asTime(row.last_login_at)).toISOString(),
    }));
  }

  async unlinkIdentity(input: UnlinkIdentityInput): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const userResult = await client.query<{ password_hash: string | null }>(
        `SELECT password_hash
           FROM users
          WHERE id = $1
            AND status = 'active'
            AND deleted_at IS NULL
          FOR UPDATE`,
        [input.userId],
      );
      const user = userResult.rows[0];

      if (user === undefined) {
        throw linkUnavailable();
      }

      const revoked = await client.query(
        `UPDATE sso_identities
            SET revoked_at = $3
          WHERE user_id = $1
            AND provider = $2
            AND revoked_at IS NULL`,
        [input.userId, input.provider, input.at],
      );

      if (revoked.rowCount === 0) {
        throw linkUnavailable();
      }

      const remaining = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count
           FROM sso_identities
          WHERE user_id = $1
            AND revoked_at IS NULL`,
        [input.userId],
      );

      // H-008 D6: never remove the last working auth method. The rollback in
      // `withTransaction` restores the revoked row when this throws.
      if (user.password_hash === null && (remaining.rows[0]?.count ?? 0) === 0) {
        throw new SsoError('unlink_blocked');
      }
    });
  }
}
