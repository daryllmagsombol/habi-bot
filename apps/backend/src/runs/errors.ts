/**
 * Run-controller failures. Ownership and validation failures reuse the
 * persistence vocabulary so every boundary keeps one non-enumerating
 * `not_found` and one `invalid_input`. Only the idempotency conflict is new.
 */

/** Same `(owner, idempotency_key)` reused with a different request body. */
export class RunIdempotencyConflictError extends Error {
  readonly code = 'idempotency_conflict' as const;

  constructor() {
    super('idempotency_conflict');
    this.name = 'RunIdempotencyConflictError';
  }
}
