/**
 * Run event errors.
 *
 * Ownership failures use `PersistenceNotFoundError` from persistence/errors.ts,
 * so a foreign Run, an unknown Run, and a cursor bound to another Run are the
 * same non-enumerating not-found. The error below is only for a Run the caller
 * already owns but whose event stream is already closed.
 */

export const RUN_EVENT_STREAM_CLOSED_CODE = 'run_event_stream_closed';

/**
 * A terminal event already exists. No further event may be appended, and the
 * rejected append allocated no sequence.
 */
export class RunEventStreamClosedError extends Error {
  readonly code = RUN_EVENT_STREAM_CLOSED_CODE;

  constructor() {
    super(RUN_EVENT_STREAM_CLOSED_CODE);
    this.name = 'RunEventStreamClosedError';
  }
}
