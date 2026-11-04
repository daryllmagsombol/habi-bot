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
  consumed_at: Date | string | null;
  expires_at: Date | string;
}

interface IdentityRow {
  id: string;
  user_id: string;
  revoked_at: Date | string | null;
}

interface InviteRow {
  id: string;
  email: string;
  expires_at: Date | string;
  used_at: Date | string | null;
}

function asTime(value: Date | string): number {
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
    row === undefined ||
    row.consumed_at !== null ||
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

      if (pending.provider !== input.provider) {
        throw stateInvalid();
      }

      const identity = await client.query<IdentityRow>(
        `SELECT id, user_id, revoked_at
           FROM sso_identities
          WHERE provider = $1 AND subject = $2
          FOR UPDATE`,
        [input.provider, input.subject],
      );
      const existing = identity.rows[0];

      if (existing !== undefined) {
        // A revoked identity is a deliberate unlink; it must not sign in again.
        if (existing.revoked_at !== null) {
          throw new SsoError('sso_failed');
        }

        const user = await client.query<{ id: string; email: string }>(
          `SELECT id, email
             FROM users
            WHERE id = $1
              AND status = 'active'
              AND deleted_at IS NULL
              AND email IS NOT NULL
            FOR UPDATE`,
          [existing.user_id],
        );
        const account = user.rows[0];

        if (account === undefined) {
          throw new SsoError('sso_failed');
        }

        await client.query(
          'UPDATE sso_identities SET last_login_at = $2 WHERE id = $1',
          [existing.id, input.at],
        );
        await consumePending(client, input.pendingId, input.at);

        return { userId: account.id, email: account.email, created: false };
      }

      // Closed registration refuses a new account but not an existing identity,
      // which was already resolved above.
      if (!input.allowRegistration) {
        throw new SsoError('registration_closed');
      }

      // New identity: an account can only be created from a verified address and
      // a valid, email-bound invite. An unverified provider address is refused
      // before any account lookup, so the response cannot reveal one.
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
        invite === undefined ||
        invite.used_at !== null ||
        asTime(invite.expires_at) <= input.at.getTime() ||
        invite.email !== input.email
      ) {
        throw signupUnavailable();
      }

      let account: { id: string; email: string };

      try {
        const inserted = await client.query<{ id: string; email: string }>(
          `INSERT INTO users (email, email_verified_at)
           VALUES ($1, $2)
           RETURNING id, email`,
          [input.email, input.at],
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
          [account.id, input.provider, input.subject, input.email, input.at],
        );
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw signupUnavailable();
        }

        throw error;
      }

      const consumedInvite = await client.query(
        'UPDATE invites SET used_at = $2 WHERE id = $1 AND used_at IS NULL',
        [invite.id, input.at],
      );

      if (consumedInvite.rowCount !== 1) {
        throw signupUnavailable();
      }

      await consumePending(client, input.pendingId, input.at);

      return { userId: account.id, email: account.email, created: true };
    });
  }

  async completeLink(input: CompleteSsoLinkInput): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const pending = await lockPending(client, input.pendingId, input.at, 'link');

      if (pending.provider !== input.provider) {
        throw stateInvalid();
      }

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

      // The verified provider email must be this account's canonical email. This
      // is what stops an authenticated attacker from attaching their own provider
      // identity to someone else's account.
      if (user.email === null || user.email !== input.email) {
        throw linkUnavailable();
      }

      const identityResult = await client.query<IdentityRow>(
        `SELECT id, user_id, revoked_at
           FROM sso_identities
          WHERE provider = $1 AND subject = $2
          FOR UPDATE`,
        [input.provider, input.subject],
      );
      const identity = identityResult.rows[0];

      if (identity !== undefined) {
        if (identity.user_id !== input.userId) {
          throw linkUnavailable();
        }

        await client.query(
          `UPDATE sso_identities
              SET email = $2,
                  email_trusted = true,
                  revoked_at = NULL,
                  last_login_at = $3
            WHERE id = $1`,
          [identity.id, input.email, input.at],
        );
      } else {
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
      created_at: Date | string;
      last_login_at: Date | string | null;
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
