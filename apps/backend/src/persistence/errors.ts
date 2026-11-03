/**
 * Persistence errors. They are deliberately small and free of ids: callers map
 * `not_found` to the same non-enumerating response used by the H-016 ownership
 * helper, and map conflict/validation codes only after ownership is proven.
 */

export type PersistenceErrorCode =
  | 'not_found'
  | 'invalid_input'
  | 'invalid_cursor'
  | 'invalid_run_reference'
  | 'bot_unavailable'
  | 'conversation_archived'
  | 'message_idempotency_conflict'
  | 'message_tombstoned'
  | 'run_result_exists'
  | 'message_sequence_conflict';

/** Base class so callers can catch one persistence failure type. */
export class PersistenceError extends Error {
  readonly code: PersistenceErrorCode;

  constructor(code: PersistenceErrorCode) {
    super(code);
    this.name = 'PersistenceError';
    this.code = code;
  }
}

/**
 * Cross-owner, nonexistent, and tombstoned-parent access all produce this one
 * error. It carries no resource id, owner, or reason.
 */
export class PersistenceNotFoundError extends PersistenceError {
  constructor() {
    super('not_found');
    this.name = 'PersistenceNotFoundError';
  }
}

/** Same-owner invalid lifecycle or idempotency state. */
export class PersistenceConflictError extends PersistenceError {
  constructor(code: Exclude<PersistenceErrorCode, 'not_found' | 'invalid_input' | 'invalid_cursor'>) {
    super(code);
    this.name = 'PersistenceConflictError';
  }
}

/** Malformed client input discovered after ownership was resolved. */
export class PersistenceValidationError extends PersistenceError {
  constructor(
    code: 'invalid_input' | 'invalid_cursor' | 'invalid_run_reference' = 'invalid_input',
  ) {
    super(code);
    this.name = 'PersistenceValidationError';
  }
}

interface PgErrorLike {
  code?: unknown;
  constraint?: unknown;
}

function asPgError(error: unknown): PgErrorLike | null {
  return typeof error === 'object' && error !== null ? (error as PgErrorLike) : null;
}

/** PostgreSQL class 23505 unique violation. */
export function isUniqueViolation(error: unknown): boolean {
  return asPgError(error)?.code === '23505';
}

/** Constraint name for a unique violation, or null for a different error. */
export function uniqueViolationConstraint(error: unknown): string | null {
  const constraint = asPgError(error)?.constraint;
  return typeof constraint === 'string' ? constraint : null;
}
