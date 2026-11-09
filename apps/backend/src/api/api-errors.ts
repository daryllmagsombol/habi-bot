/**
 * HTTP mapping for the P1 composition surface.
 *
 * Errors keep the repository's existing envelope (`{ error: { code } }`) and its
 * vocabulary. Ownership failures are always the same non-enumerating
 * `404 not_found`, whether the id is unknown, belongs to another user, or is
 * malformed. Validation codes and same-owner conflicts are distinct only after
 * ownership has been resolved by the repository query itself.
 *
 * Two codes are new to this composition layer and describe the transport, not
 * product policy:
 *
 *   - `api_unavailable` (503): the flag is on but no database or attachment
 *     storage root is configured.
 *   - `unsupported_media_type` (415): the attachment exists and is owned by the
 *     caller, but its content type is not one this text route serves. Ownership
 *     was proven first, so this cannot enumerate another user's uploads.
 *
 * Owner-visible lifecycle failures from the artifact, attachment, and skill
 * services already carry their own code. They are mapped here rather than
 * leaking a Nest 500 without the shared envelope.
 *
 * A dispatched cancellation is not an error: the API records a durable intent
 * and returns the Run's current state (see `ApiService.cancelRun`).
 */
import { Catch } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { ArtifactIntegrityError } from '../artifacts/errors.js';
import {
  AttachmentIntegrityError,
  AttachmentRejectedError,
} from '../attachments/errors.js';
import {
  PersistenceError,
  type PersistenceErrorCode,
} from '../persistence/errors.js';
import {
  SkillNameConflictError,
  SkillUnavailableError,
  SkillVersionConflictError,
} from '../skills/errors.js';

export type ApiErrorCode = 'api_unavailable' | 'unsupported_media_type';

const STATUS_BY_API_CODE: Readonly<Record<ApiErrorCode, number>> = {
  api_unavailable: 503,
  unsupported_media_type: 415,
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

const STATUS_BY_DOMAIN_CODE: Readonly<Record<string, number>> = {
  skill_unavailable: 409,
  skill_name_conflict: 409,
  skill_version_conflict: 409,
  attachment_rejected: 409,
  artifact_integrity: 500,
  attachment_integrity: 500,
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
@Catch(
  PersistenceError,
  ApiError,
  SkillUnavailableError,
  SkillNameConflictError,
  SkillVersionConflictError,
  AttachmentRejectedError,
  ArtifactIntegrityError,
  AttachmentIntegrityError,
)
export class ApiErrorFilter implements ExceptionFilter {
  catch(
    error:
      | PersistenceError
      | ApiError
      | SkillUnavailableError
      | SkillNameConflictError
      | SkillVersionConflictError
      | AttachmentRejectedError
      | ArtifactIntegrityError
      | AttachmentIntegrityError,
    host: ArgumentsHost,
  ): void {
    const response = host.switchToHttp().getResponse<Response>();
    const status = this.statusOf(error);

    response.status(status).json({ error: { code: error.code } });
  }

  private statusOf(
    error:
      | PersistenceError
      | ApiError
      | SkillUnavailableError
      | SkillNameConflictError
      | SkillVersionConflictError
      | AttachmentRejectedError
      | ArtifactIntegrityError
      | AttachmentIntegrityError,
  ): number {
    if (error instanceof ApiError) {
      return error.status;
    }

    if (error instanceof PersistenceError) {
      return statusForPersistenceCode(error.code);
    }

    return STATUS_BY_DOMAIN_CODE[error.code] ?? 500;
  }
}
