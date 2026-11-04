/**
 * HTTP mapping for the P1 composition surface.
 *
 * Errors keep the repository's existing envelope (`{ error: { code } }`) and its
 * vocabulary. Ownership failures are always the same non-enumerating
 * `404 not_found`, whether the id is unknown, belongs to another user, or is
 * malformed. Validation codes and same-owner conflicts are distinct only after
 * ownership has been resolved by the repository query itself.
 *
 * Two codes are new to this composition layer and describe transport wiring,
 * not product policy:
 *
 *   - `api_unavailable` (503): the flag is on but no database is configured.
 *   - `cancel_unavailable` (409): the Run may already have executed, and no
 *     harness adapter is wired to stop it safely. The Run is never relabelled
 *     cancelled locally in that case.
 */
import { Catch } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import {
  PersistenceError,
  type PersistenceErrorCode,
} from '../persistence/errors.js';

export type ApiErrorCode = 'api_unavailable' | 'cancel_unavailable';

const STATUS_BY_API_CODE: Readonly<Record<ApiErrorCode, number>> = {
  api_unavailable: 503,
  cancel_unavailable: 409,
};

const STATUS_BY_PERSISTENCE_CODE: Readonly<Record<PersistenceErrorCode, number>> = {
  not_found: 404,
  invalid_input: 400,
  invalid_cursor: 400,
  invalid_run_reference: 400,
  bot_unavailable: 409,
  conversation_archived: 409,
  message_idempotency_conflict: 409,
  message_tombstoned: 409,
  run_result_exists: 409,
  message_sequence_conflict: 409,
};

export interface ApiErrorBody {
  error: { code: string };
}

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;

  constructor(code: ApiErrorCode) {
    super(code);
    this.name = 'ApiError';
    this.code = code;
    this.status = STATUS_BY_API_CODE[code];
  }
}

export function statusForPersistenceCode(code: PersistenceErrorCode): number {
  return STATUS_BY_PERSISTENCE_CODE[code];
}

/**
 * Converts the two domain error families into the shared HTTP envelope.
 * Nest's own `HttpException`s (401/403 from the session guards, 400 from the
 * body parser) are deliberately not caught and keep their existing semantics.
 */
@Catch(PersistenceError, ApiError)
export class ApiErrorFilter implements ExceptionFilter {
  catch(error: PersistenceError | ApiError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const status =
      error instanceof ApiError
        ? error.status
        : statusForPersistenceCode(error.code);

    response.status(status).json({ error: { code: error.code } });
  }
}
