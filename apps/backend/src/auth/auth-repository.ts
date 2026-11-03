/**
 * PostgreSQL storage for the H-014 identity slice.
 *
 * Only this module touches auth tables. Scope rules:
 *
 * - Active accounts are read by canonical email; a partial unique index keeps
 *   the result unambiguous. Missing, disabled, and deleted rows all collapse
 *   to `undefined`, so the service returns one uniform login failure.
 * - Signup runs in a transaction: `SELECT ... FOR UPDATE` on the invite, then
 *   the user insert, then the single-use invite update. A duplicate-email
 *   unique violation, an expired/used/mismatched invite, or a lost race rolls
 *   the whole transaction back.
 * - Recovery invalidates the previous outstanding token before inserting the
 *   new hash, keeping one usable token per user.
 *
 * No email is sent, and no raw token is stored or logged.
 */
import type { Pool } from 'pg';
import { withTransaction } from '../persistence/database.js';
import { isUniqueViolation } from '../persistence/errors.js';
import { AuthError } from './auth-errors.js';
import type {
  AuthAccount,
  AuthCredential,
  AuthIdentity,
  AuthRepositoryPort,
  CreateAccountWithInviteInput,
  CreateRecoveryTokenInput,
} from './auth-types.js';

interface InviteRow {
  id: string;
  email: string;
  expires_at: Date | string;
  used_at: Date | string | null;
}

function asTime(value: Date | string): number {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

function signupUnavailable(): AuthError {
  return new AuthError('signup_unavailable');
}

export class AuthRepository implements AuthRepositoryPort {
  constructor(private readonly pool: Pool) {}

  async createAccountWithInvite(input: CreateAccountWithInviteInput): Promise<AuthAccount> {
    return withTransaction(this.pool, async (client) => {
      const inviteResult = await client.query<InviteRow>(
        'SELECT id, email, expires_at, used_at FROM invites WHERE token_hash = $1 FOR UPDATE',
        [input.inviteTokenHash],
      );
      const invite = inviteResult.rows[0];

      if (invite === undefined) {
        throw signupUnavailable();
      }

      if (
        invite.used_at !== null ||
        asTime(invite.expires_at) <= input.at.getTime() ||
        invite.email !== input.email
      ) {
        throw signupUnavailable();
      }

      let user: { id: string; email: string };

      try {
        const userResult = await client.query<{ id: string; email: string }>(
          'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email',
          [input.email, input.passwordHash],
        );
        const inserted = userResult.rows[0];

        if (inserted === undefined) {
          throw signupUnavailable();
        }

        user = inserted;
      } catch (error) {
        // Duplicate canonical email under the partial unique index. The
        // response is the same generic failure as an invalid invite.
        if (isUniqueViolation(error)) {
          throw signupUnavailable();
        }

        throw error;
      }

      const consumed = await client.query(
        'UPDATE invites SET used_at = $2 WHERE id = $1 AND used_at IS NULL',
        [invite.id, input.at],
      );

      if (consumed.rowCount !== 1) {
        throw signupUnavailable();
      }

      return { userId: user.id, email: user.email };
    });
  }

  async findActiveCredentialByEmail(email: string): Promise<AuthCredential | undefined> {
    const result = await this.pool.query<{ id: string; email: string; password_hash: string }>(
      `SELECT id, email, password_hash
         FROM users
        WHERE email = $1
          AND status = 'active'
          AND deleted_at IS NULL
          AND password_hash IS NOT NULL
        LIMIT 1`,
      [email],
    );
    const row = result.rows[0];

    if (row === undefined) {
      return undefined;
    }

    return { userId: row.id, email: row.email, passwordHash: row.password_hash };
  }

  async findActiveIdentityById(userId: string): Promise<AuthIdentity | undefined> {
    const result = await this.pool.query<{ id: string; email: string }>(
      `SELECT id, email
         FROM users
        WHERE id = $1
          AND status = 'active'
          AND deleted_at IS NULL
          AND email IS NOT NULL
        LIMIT 1`,
      [userId],
    );
    const row = result.rows[0];

    if (row === undefined) {
      return undefined;
    }

    return { userId: row.id, email: row.email };
  }

  async createRecoveryToken(input: CreateRecoveryTokenInput): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      // Serialize concurrent recovery requests for one account so the partial
      // unique index cannot turn a race into a server error.
      const locked = await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [
        input.userId,
      ]);

      if (locked.rowCount !== 1) {
        return;
      }

      await client.query(
        'UPDATE password_reset_tokens SET used_at = $2 WHERE user_id = $1 AND used_at IS NULL',
        [input.userId, input.at],
      );
      await client.query(
        `INSERT INTO password_reset_tokens (user_id, token_hash, created_at, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [input.userId, input.tokenHash, input.at, input.expiresAt],
      );
    });
  }
}
