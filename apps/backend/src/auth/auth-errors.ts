/**
 * The auth slice's closed set of client-visible failures.
 *
 * Shapes are intentionally narrow. Login always returns `invalid_credentials`
 * for an unknown email, a wrong password, a disabled account, or an account
 * with no password. Signup always returns `signup_unavailable` for a duplicate
 * canonical email, an unknown/expired/used invite, an email-mismatched invite,
 * or a lost insert race. Neither response says whether an account or invite
 * exists.
 *
 * `password_policy`, `invalid_request`, and `registration_closed` describe the
 * submitted request or server mode, never account existence, so they may be
 * distinct for usable form feedback.
 */

export type AuthErrorCode =
  | 'invalid_request'
  | 'invalid_credentials'
  | 'signup_unavailable'
  | 'password_policy'
  | 'registration_closed'
  | 'rate_limited'
  | 'unauthenticated';

const STATUS_BY_CODE: Readonly<Record<AuthErrorCode, number>> = {
  invalid_request: 400,
  invalid_credentials: 401,
  signup_unavailable: 409,
  password_policy: 400,
  registration_closed: 403,
  rate_limited: 429,
  unauthenticated: 401,
};

export interface AuthErrorOptions {
  readonly retryAfterSeconds?: number;
}

export class AuthError extends Error {
  readonly code: AuthErrorCode;
  readonly status: number;
  readonly retryAfterSeconds: number | undefined;

  constructor(code: AuthErrorCode, options: AuthErrorOptions = {}) {
    super(code);
    this.name = 'AuthError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export function authErrorBody(code: AuthErrorCode): { error: { code: AuthErrorCode } } {
  return { error: { code } };
}
