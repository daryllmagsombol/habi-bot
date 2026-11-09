/**
 * H-032 (#32) account export and deletion HTTP surface.
 *
 * Composition only: the routes exist only because `P1ApiModule` is imported
 * under `HABI_P1_API=1`, and every route requires a real H-017 session. The
 * actor id comes from the validated session record; no account id is accepted
 * from a path, query, or body. A body can carry only the confirmation value.
 *
 * Route table:
 *
 *   GET    /api/account/export   stream the owner's complete export
 *   DELETE /api/account          delete the owner's account and owned rows
 *
 * Export is a single JSON document assembled from owner-scoped, bounded pages
 * and written as it is read. It includes the profile, Bots and instructions,
 * conversations and messages, Runs and Run events, artifacts and versions,
 * attachment metadata and extracted text, memories and their approvals, skills
 * and versions, usage rows, and search-visible message text. It excludes
 * password hashes, session and CSRF material, SSO verification material,
 * invite/recovery token hashes, attachment storage keys, and internal Run
 * fingerprints.
 *
 * Deletion requires both the synchronizer CSRF token and an explicit body
 * confirmation equal to the account email: `{ "confirm": "<account email>" }`.
 * Missing or wrong confirmation is `400 invalid_input`. It removes rows at
 * every owned surface, removes private attachment bytes, tombstones the
 * identity, clears credential material, and revokes every live session in the
 * process-wide H-017 session store (the only session authority this POC has).
 * A repeat is idempotent at the storage boundary and reports the first
 * deletion instant; the HTTP retry itself is `401` because the caller's
 * session was already revoked.
 *
 * Backup honesty: deletion is immediate for the live database only. A copy of
 * the account's data survives in age-encrypted backups created before the
 * deletion until those archives age out under the 7 daily / 4 weekly / 6
 * monthly GFS retention policy — worst case 184 days. Nothing is purged from an
 * existing archive, and no route claims otherwise. The delete response carries
 * that statement verbatim.
 *
 * Cross-account access is not expressible: there is no target id. A
 * confirmation naming another account's email is a refused confirmation
 * (`400 invalid_input`) that changes nothing, and an extra body id is ignored.
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { clearSessionCookie } from '../session/session-cookie.js';
import { SessionAuthGuard } from '../session/session-auth.guard.js';
import { SessionCsrfGuard } from '../session/session-csrf.guard.js';
import {
  requireSession,
  requestNow,
  type SessionRequest,
} from '../session/session-request.js';
import { SessionService } from '../session/session.service.js';
import { PersistenceValidationError } from '../persistence/errors.js';
import type { AccountDeletionResponse } from '../account/account-service.js';
import { AccountRuntime } from '../account/account-runtime.js';
import { ApiErrorFilter } from './api-errors.js';

function readConfirmation(body: unknown): string {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new PersistenceValidationError('invalid_input');
  }

  const confirm = (body as Record<string, unknown>).confirm;

  if (typeof confirm !== 'string' || confirm.trim().length === 0) {
    throw new PersistenceValidationError('invalid_input');
  }

  return confirm;
}

function exportFilename(at: Date): string {
  return `habi-account-export-${at.toISOString().replace(/[:.]/g, '-')}.json`;
}

@Controller('api/account')
@UseGuards(SessionAuthGuard)
@UseFilters(ApiErrorFilter)
export class ApiAccountController {
  constructor(
    @Inject(AccountRuntime) private readonly runtime: AccountRuntime,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}

  /**
   * Streams one owner-scoped JSON export. Ownership is resolved before any
   * header is written, so a session whose account is gone is a normal error
   * envelope rather than a half-written document. The body is `no-store`.
   */
  @Get('export')
  async exportAccount(
    @Req() request: SessionRequest,
    @Res() response: Response,
  ): Promise<void> {
    const { userId } = requireSession(request);
    const service = this.runtime.getService();

    await service.assertExportable(userId);

    response.status(HttpStatus.OK);
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader(
      'content-disposition',
      `attachment; filename="${exportFilename(new Date())}"`,
    );

    try {
      await pipeline(Readable.from(service.export(userId)), response);
    } catch {
      // Headers are already committed. The snapshot transaction is rolled back
      // by the generator's own finally; end the broken response without adding
      // a second status or leaking a failure detail.
      if (!response.writableEnded) {
        response.destroy();
      }
    }
  }

  @Delete()
  @HttpCode(HttpStatus.OK)
  @UseGuards(SessionCsrfGuard)
  async deleteAccount(
    @Body() body: unknown,
    @Req() request: SessionRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AccountDeletionResponse> {
    const { userId } = requireSession(request);
    const confirmation = readConfirmation(body);
    const result = await this.runtime.getService().deleteAccount(userId, confirmation);
    // The committed deletion is the point of no return: revoke every live
    // session for this account across devices, including the caller's.
    const sessionsRevoked = this.sessions.revokeAllForUser(
      userId,
      requestNow(request),
    );

    response.setHeader('cache-control', 'no-store');
    response.setHeader('set-cookie', clearSessionCookie());

    return { ...result, sessionsRevoked };
  }
}
