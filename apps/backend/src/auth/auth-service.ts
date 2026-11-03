/**
 * H-014 identity service: invite-gated signup, uniform login, logout, and
 * enumeration-safe recovery.
 *
 * Scope and boundaries:
 *
 * - Passwords are scrypt hashes from `password.ts`; this module never stores or
 *   logs the raw value.
 * - Signup consumes an email-bound invite atomically in the repository. The
 *   invite token is hashed before it reaches storage.
 * - Login verifies against a locally derived dummy verifier when no credential
 *   exists, so the failure path performs the same expensive work as a wrong
 *   password.
 * - Logout goes through `AuthSessionPort`; the H-017 core is not imported here.
 * - Recovery always resolves the same way and never returns the token. Email
 *   delivery is not implemented; only the hashed token row is recorded.
 * - Rate limiting is the in-process POC limiter, not the final #23 design.
 *
 * `email_verified_at` is intentionally untouched by this slice: email
 * verification is not part of the first H-014 slice, and the invite is the only
 * registration gate implemented. That gap is documented in the slice report,
 * not hidden behind a synthetic verified timestamp.
 */
import { AuthError } from './auth-errors.js';
import type { AuthSessionObserver, AuthSessionPort } from './auth-session-port.js';
import type {
  AuthAccount,
  AuthIdentity,
  AuthRepositoryPort,
  AuthSessionResult,
} from './auth-types.js';
import { canonicalizeEmail } from './email.js';
import {
  dummyPasswordVerifier,
  hashPassword,
  validatePassword,
  verifyPassword,
} from './password.js';
import {
  AUTH_RATE_LIMITS,
  FixedWindowRateLimiter,
  rateLimitKey,
} from './rate-limit.js';
import type { RateLimitRule } from './rate-limit.js';
import { hashToken, mintToken } from './tokens.js';
import type { RegistrationMode } from './auth-config.js';

/** H-008 §4.4 reset token lifetime; a provisional value for this POC. */
export const RECOVERY_TOKEN_TTL_MS = 30 * 60 * 1000;

/** Bound on a submitted invite token before hashing; real tokens are 43 chars. */
const MAX_INVITE_TOKEN_LENGTH = 512;

export interface AuthServiceOptions {
  readonly repository: AuthRepositoryPort;
  readonly sessions: AuthSessionPort;
  readonly now?: () => number;
  readonly limiter?: FixedWindowRateLimiter;
  readonly registrationMode?: RegistrationMode;
  /**
   * Test seam: supplies a fixed verifier instead of the lazily derived dummy
   * hash. Production callers should leave it unset.
   */
  readonly dummyPasswordHash?: string;
}

export interface AuthRequestContext {
  /** Server-observed client identifier (IP). Never a user-supplied id. */
  readonly clientKey: string;
  readonly userAgent?: string;
  readonly ip?: string;
}

export interface SignupInput extends AuthRequestContext {
  readonly email: string;
  readonly password: string;
  readonly inviteToken: string;
}

export interface LoginInput extends AuthRequestContext {
  readonly email: string;
  readonly password: string;
}

export interface RecoveryRequestInput extends AuthRequestContext {
  readonly email: string;
}

export class AuthService {
  private readonly repository: AuthRepositoryPort;
  private readonly sessions: AuthSessionPort;
  private readonly now: () => number;
  private readonly limiter: FixedWindowRateLimiter;
  private readonly registrationMode: RegistrationMode;
  private readonly dummyPasswordHash: string | undefined;

  constructor(options: AuthServiceOptions) {
    this.repository = options.repository;
    this.sessions = options.sessions;
    this.now = options.now ?? Date.now;
    this.limiter = options.limiter ?? new FixedWindowRateLimiter(this.now);
    this.registrationMode = options.registrationMode ?? 'invite';
    this.dummyPasswordHash = options.dummyPasswordHash;
  }

  async signup(input: SignupInput): Promise<AuthSessionResult> {
    const email = canonicalizeEmail(input.email);

    if (email === undefined) {
      throw new AuthError('invalid_request');
    }

    if (this.registrationMode === 'closed') {
      throw new AuthError('registration_closed');
    }

    if (validatePassword(input.password, email) !== 'ok') {
      throw new AuthError('password_policy');
    }

    if (
      typeof input.inviteToken !== 'string' ||
      input.inviteToken.length === 0 ||
      input.inviteToken.length > MAX_INVITE_TOKEN_LENGTH
    ) {
      throw new AuthError('signup_unavailable');
    }

    const at = this.now();
    this.enforceLimitPair(
      'signup',
      email,
      AUTH_RATE_LIMITS.signupEmail,
      input.clientKey,
      AUTH_RATE_LIMITS.signupClient,
      at,
    );

    const passwordHash = await hashPassword(input.password);
    const account = await this.repository.createAccountWithInvite({
      email,
      passwordHash,
      inviteTokenHash: hashToken(input.inviteToken),
      at: new Date(at),
    });

    return this.issueSession(account, input, at);
  }

  async login(input: LoginInput): Promise<AuthSessionResult> {
    const at = this.now();
    const email = canonicalizeEmail(input.email);
    const emailKey = email ?? `invalid:${hashToken(input.email)}`;

    this.enforceLimitPair(
      'login',
      emailKey,
      AUTH_RATE_LIMITS.loginEmail,
      input.clientKey,
      AUTH_RATE_LIMITS.loginClient,
      at,
    );

    const credential =
      email === undefined
        ? undefined
        : await this.repository.findActiveCredentialByEmail(email);

    // Always spend one scrypt verification, even with no row, so the response
    // time does not distinguish an unknown address from a wrong password.
    const verifier =
      credential?.passwordHash ?? this.dummyPasswordHash ?? (await dummyPasswordVerifier());
    const matches = await verifyPassword(input.password, verifier);

    if (credential === undefined || !matches) {
      throw new AuthError('invalid_credentials');
    }

    return this.issueSession(credential, input, at);
  }

  /**
   * Revokes the presented session. A missing or already-revoked session is not
   * an error: logout is idempotent and the controller clears the cookie either
   * way.
   */
  logout(sessionSecret: string): void {
    this.sessions.revoke(sessionSecret, this.now());
  }

  /**
   * Records a single-use recovery token for an active account with a password.
   * The response is the same for known and unknown addresses, and the raw token
   * is discarded because no mailer exists in this slice.
   */
  async requestRecovery(input: RecoveryRequestInput): Promise<void> {
    const at = this.now();
    const email = canonicalizeEmail(input.email);
    const emailKey = email ?? `invalid:${hashToken(input.email)}`;

    this.enforceLimitPair(
      'recovery',
      emailKey,
      AUTH_RATE_LIMITS.recoveryEmail,
      input.clientKey,
      AUTH_RATE_LIMITS.recoveryClient,
      at,
    );

    if (email === undefined) {
      return;
    }

    const credential = await this.repository.findActiveCredentialByEmail(email);

    if (credential === undefined) {
      return;
    }

    const rawToken = mintToken();

    await this.repository.createRecoveryToken({
      userId: credential.userId,
      tokenHash: hashToken(rawToken),
      at: new Date(at),
      expiresAt: new Date(at + RECOVERY_TOKEN_TTL_MS),
    });
  }

  async getIdentity(userId: string): Promise<AuthIdentity> {
    const identity = await this.repository.findActiveIdentityById(userId);

    if (identity === undefined) {
      throw new AuthError('unauthenticated');
    }

    return identity;
  }

  private issueSession(
    account: AuthAccount,
    context: AuthRequestContext,
    at: number,
  ): AuthSessionResult {
    const observer: AuthSessionObserver = {
      ...(context.userAgent === undefined ? {} : { userAgent: context.userAgent }),
      ...(context.ip === undefined ? {} : { ip: context.ip }),
    };
    const issued = this.sessions.issue(account.userId, observer, at);

    return {
      user: { userId: account.userId, email: account.email },
      sessionSecret: issued.sessionSecret,
      csrfToken: issued.csrfToken,
      maxAgeSeconds: issued.maxAgeSeconds,
    };
  }

  /**
   * Consumes the email and client buckets before deciding, so a blocked attempt
   * still counts against both. The caller only sees the uniform 429.
   */
  private enforceLimitPair(
    scope: string,
    emailKey: string,
    emailRule: RateLimitRule,
    clientKey: string,
    clientRule: RateLimitRule,
    at: number,
  ): void {
    const emailDecision = this.limiter.consume(
      rateLimitKey(`${scope}:email`, emailKey),
      emailRule,
      at,
    );
    const clientDecision = this.limiter.consume(
      rateLimitKey(`${scope}:client`, clientKey),
      clientRule,
      at,
    );
    const retryAfter = Math.max(
      emailDecision.allowed ? 0 : emailDecision.retryAfterSeconds,
      clientDecision.allowed ? 0 : clientDecision.retryAfterSeconds,
    );

    if (retryAfter > 0) {
      throw new AuthError('rate_limited', { retryAfterSeconds: retryAfter });
    }
  }
}
