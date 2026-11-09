/**
 * HTTP mapping for the P1 composition surface.
 *
 * Errors keep the repository's existing envelope (`{ error: { code } }`) and its
 * vocabulary. Ownership failures are always the same non-enumerating
 * `404 not_found`, whether the id is unknown, belongs to another user, or is
 * malformed. Validation codes and same-owner conflicts are distinct only after
 * ownership has been resolved by the repository query itself.
 *
 * Codes added by the composition layer describe transport/wiring, not product
 * policy:
 *
 *   - `api_unavailable` (503): the flag is on but no database is configured.
 *   - `account_storage_unavailable` (503): an account deletion has attachment
 *     rows but this process has no private attachment-storage root, so it
 *     cannot honestly remove the bytes. Nothing has been deleted at that point.
 *
 * A dispatched cancellation is not an error: the API records a durable intent
 * and returns the Run's current state (see `ApiService.cancelRun`).
 */
import { Catch } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { AccountStorageUnavailableError } from '../account/account-errors.js';
import {
  PersistenceError,
  type PersistenceErrorCode,
} from '../persistence/errors.js';

export type ApiErrorCode = 'api_unavailable' | 'account_storage_unavailable';

const STATUS_BY_API_CODE: Readonly<Record<ApiErrorCode, number>> = {
  api_unavailable: 503,
  account_storage_unavailable: 503,
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
 * Converts the domain error families into the shared HTTP envelope.
 * Nest's own `HttpException`s (401/403 from the session guards, 400 from the
 * body parser) are deliberately not caught and keep their existing semantics.
 */
@Catch(PersistenceError, ApiError, AccountStorageUnavailableError)
export class ApiErrorFilter implements ExceptionFilter {
  catch(
    error: PersistenceError | ApiError | AccountStorageUnavailableError,
    host: ArgumentsHost,
  ): void {
    const response = host.switchToHttp().getResponse<Response>();
    const status =
      error instanceof AccountStorageUnavailableError
        ? STATUS_BY_API_CODE.account_storage_unavailable
        : error instanceof ApiError
          ? error.status
          : statusForPersistenceCode(error.code);

    response.status(status).json({ error: { code: error.code } });
  }
}
