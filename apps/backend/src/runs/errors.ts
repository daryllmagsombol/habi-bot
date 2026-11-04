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

/**
 * The persisted Run cannot produce a provider request: its conversation is
 * missing/not owned, or no context message exists at the Run's trigger bound.
 * This is a permanent input failure, so dispatch terminalizes it without ever
 * calling the adapter.
 */
export class RunContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunContextError';
  }
}
