/**
 * Closed set of failures produced by the H-023 limits layer.
 *
 * The codes describe the caller's own allowance state and nothing about another
 * user: a foreign, missing, or malformed reservation id is one
 * `reservation_not_found`, exactly like the persistence layer's `not_found`.
 * Responses are meant to be safe to show: they never name a token balance of
 * anyone else, a provider, or an internal query.
 *
 * `allowance_exhausted` is a normal state, not a retry hint. It is shipped as
 * 429 only so a client has one uniform back-pressure shape with
 * `retryAfterSeconds`; the allowance resets once per Asia/Manila day, whereas
 * the run-creation limiter uses a short fixed window.
 */

export type UsageLimitErrorCode =
  | 'allowance_exhausted'
  | 'usage_unknown'
  | 'invalid_input'
  | 'invalid_usage'
  | 'reservation_not_found'
  | 'reservation_not_reserved'
  | 'run_already_accounted'
  | 'reconcile_not_required'
  | 'reconcile_not_authorized';

const STATUS_BY_CODE: Readonly<Record<UsageLimitErrorCode, number>> = {
  allowance_exhausted: 429,
  usage_unknown: 409,
  invalid_input: 400,
  invalid_usage: 400,
  reservation_not_found: 404,
  reservation_not_reserved: 409,
  run_already_accounted: 409,
  reconcile_not_required: 409,
  reconcile_not_authorized: 403,
};

export interface UsageLimitErrorContext {
  /** Seconds until the allowance day changes; only for `allowance_exhausted`. */
  readonly retryAfterSeconds?: number;
  /** Configured daily allowance, so a client can explain the refusal. */
  readonly limit?: number;
  /** Remaining units at refusal time; never another user's balance. */
  readonly remaining?: number;
}

export class UsageLimitError extends Error {
  readonly code: UsageLimitErrorCode;
  readonly status: number;
  readonly retryAfterSeconds: number | undefined;
  readonly limit: number | undefined;
  readonly remaining: number | undefined;

  constructor(code: UsageLimitErrorCode, context: UsageLimitErrorContext = {}) {
    super(code);
    this.name = 'UsageLimitError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.retryAfterSeconds = context.retryAfterSeconds;
    this.limit = context.limit;
    this.remaining = context.remaining;
  }
}

export interface UsageLimitErrorBody {
  error: {
    code: UsageLimitErrorCode;
    retryAfterSeconds?: number;
    limit?: number;
    remaining?: number;
  };
}

/**
 * Stable response body. Optional fields are omitted rather than sent as null so
 * the same shape can be produced for every refusal.
 */
export function usageLimitErrorBody(error: UsageLimitError): UsageLimitErrorBody {
  return {
    error: {
      code: error.code,
      ...(error.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: error.retryAfterSeconds }),
      ...(error.limit === undefined ? {} : { limit: error.limit }),
      ...(error.remaining === undefined ? {} : { remaining: error.remaining }),
    },
  };
}

/**
 * Uniform metadata for a refused request. It is intentionally identical for
 * every user and every window: no owner id, no bucket key, and no indication of
 * how many other callers are being limited.
 */
export interface RateLimitedMetadata {
  readonly code: 'rate_limited';
  readonly limit: number;
  readonly retryAfterSeconds: number;
}

export class RateLimitError extends Error {
  readonly code = 'rate_limited' as const;
  readonly status = 429 as const;
  readonly metadata: RateLimitedMetadata;

  constructor(metadata: RateLimitedMetadata) {
    super('rate_limited');
    this.name = 'RateLimitError';
    this.metadata = metadata;
  }
}
