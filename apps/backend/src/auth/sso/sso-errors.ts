/**
 * Closed client-visible failure set for the SSO slice.
 *
 * Deliberately narrow, mirroring `../auth-errors.ts`:
 *
 * - `sso_state_invalid` covers an unknown, expired, consumed, or
 *   browser-mismatched state, and a provider mismatch. The caller learns
 *   nothing about which check failed.
 * - `signup_unavailable` is the same non-enumerating code the H-014 password
 *   signup uses, for a missing/expired/mismatched invite, an email collision, or
 *   a lost insert race. An SSO signup therefore cannot be used to discover
 *   whether an account or invite exists.
 * - `link_unavailable` is only reachable from an authenticated linking request;
 *   it never says whether the provider identity belongs to another user.
 * - `sso_failed` is the uniform provider-exchange/identity-validation failure.
 *   Provider error descriptions, codes, and tokens never reach the client.
 *
 * No code carries account, invite, or provider detail.
 */

export type SsoErrorCode =
  | 'invalid_request'
  | 'sso_state_invalid'
  | 'sso_failed'
  | 'sso_email_unverified'
  | 'signup_unavailable'
  | 'link_unavailable'
  | 'unlink_blocked'
  | 'registration_closed'
  | 'rate_limited'
  | 'unauthenticated'
  | 'csrf_invalid'
  | 'not_found';

const STATUS_BY_CODE: Readonly<Record<SsoErrorCode, number>> = {
  invalid_request: 400,
  sso_state_invalid: 400,
  sso_failed: 401,
  sso_email_unverified: 403,
  signup_unavailable: 409,
  link_unavailable: 409,
  unlink_blocked: 409,
  registration_closed: 403,
  rate_limited: 429,
  unauthenticated: 401,
  csrf_invalid: 403,
  not_found: 404,
};

export interface SsoErrorOptions {
  readonly retryAfterSeconds?: number;
}

export class SsoError extends Error {
  readonly code: SsoErrorCode;
  readonly status: number;
  readonly retryAfterSeconds: number | undefined;

  constructor(code: SsoErrorCode, options: SsoErrorOptions = {}) {
    super(code);
    this.name = 'SsoError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export function ssoErrorBody(code: SsoErrorCode): { error: { code: SsoErrorCode } } {
  return { error: { code } };
}
