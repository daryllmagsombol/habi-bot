/**
 * Shared data shapes for the H-014 identity slice.
 *
 * These are storage-neutral: `AuthService` depends on `AuthRepositoryPort`,
 * which `AuthRepository` satisfies with PostgreSQL. Service tests can supply a
 * fake port without a database.
 */

export interface AuthAccount {
  readonly userId: string;
  readonly email: string;
}

export interface AuthCredential {
  readonly userId: string;
  readonly email: string;
  readonly passwordHash: string;
}

export interface AuthIdentity {
  readonly userId: string;
  readonly email: string;
}

export interface CreateAccountWithInviteInput {
  readonly email: string;
  readonly passwordHash: string;
  readonly inviteTokenHash: string;
  readonly at: Date;
}

export interface CreateRecoveryTokenInput {
  readonly userId: string;
  readonly tokenHash: string;
  readonly at: Date;
  readonly expiresAt: Date;
}

export interface AuthRepositoryPort {
  /**
   * Atomically locks the invite, creates the active user, and consumes the
   * invite. Any invalid or lost-race condition raises the generic
   * `signup_unavailable` error; nothing is partially written.
   */
  createAccountWithInvite(input: CreateAccountWithInviteInput): Promise<AuthAccount>;
  findActiveCredentialByEmail(email: string): Promise<AuthCredential | undefined>;
  findActiveIdentityById(userId: string): Promise<AuthIdentity | undefined>;
  /**
   * Invalidates any outstanding token for the user and inserts the new hash in
   * one transaction, so at most one usable token exists.
   */
  createRecoveryToken(input: CreateRecoveryTokenInput): Promise<void>;
}

export interface AuthSessionResult {
  readonly user: AuthAccount;
  /** Raw session secret. The controller puts this in Set-Cookie only. */
  readonly sessionSecret: string;
  readonly csrfToken: string;
  readonly maxAgeSeconds: number;
}
