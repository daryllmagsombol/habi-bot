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
 *   GET    /api/account          the owner's identity profile (lightweight)
 *   GET    /api/account/export   stream the owner's complete export
 *   GET    /api/account/audit    the owner's export/deletion audit trail
 *   DELETE /api/account          delete the owner's account and owned rows
 *
 * The profile read returns only the identity fields the account page shows —
 * user id, email, status, timestamps, and verification time. It is not an
 * export: there is no owned-data content or count, no credential material, no
 * session or CSRF field, and no SSO identity. Ownership comes from the session
 * record; query, path, and body identity fields are never read.
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
 * Before that transaction it writes the durable cancel intent for every
 * non-terminal Run the account owns and waits a bounded, configurable time
 * (`HABI_ACCOUNT_RUN_CANCEL_WAIT_MS`, default 3000 ms) for a present worker to
 * terminalize them. The response reports `runReconciliation`: Runs still
 * non-terminal when the bound expired are listed in `unreconciledRuns` rather
 * than reported as stopped. This process has no adapter, so an adapter call a
 * worker already has in flight is not stopped here; the row is removed, and the
 * harness session remains the worker's responsibility.
 * A repeat is idempotent at the storage boundary and reports the first
 * deletion instant; the HTTP retry itself is `401` because the caller's
 * session was already revoked.
 *
 * Export and deletion are audited. The export's row records the section counts
 * as reported; the deletion's per-surface removal counts and reconciliation
 * outcome are written in the deletion transaction. Audit rows are account data
 * and are removed by deletion, except the deletion record itself: it is written
 * with a NULL owner so it survives, and a NULL owner can never match the
 * owner-scoped read used by `GET /api/account/audit`.
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
  Query,
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
import { normalizeLimit } from '../persistence/pagination.js';
import type {
  AccountAuditPage,
  AccountDeletionResponse,
} from '../account/index.js';
import { AccountRuntime } from '../account/account-runtime.js';
import { ApiErrorFilter } from './api-errors.js';

/**
 * The confirmation is the only field a deletion body may carry. A wrong type,
 * a blank value, or a missing body is passed through as `undefined` so the
 * service can audit the refusal and answer with the same `invalid_input`.
 */
function readConfirmationValue(body: unknown): unknown {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return undefined;
  }

  return (body as Record<string, unknown>).confirm;
}

function exportFilename(at: Date): string {
  return `habi-account-export-${at.toISOString().replaceAll(/[:.]/g, '-')}.json`;
}

const UNSIGNED_INTEGER = /^\d+$/;

/** Audit pages key on the identity sequence; anything else is `invalid_cursor`. */
function readAuditCursor(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string' || !UNSIGNED_INTEGER.test(value)) {
    throw new PersistenceValidationError('invalid_cursor');
  }

  return value;
}

function readAuditLimit(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string' || !UNSIGNED_INTEGER.test(value)) {
    throw new PersistenceValidationError('invalid_input');
  }

  const limit = Number(value);

  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new PersistenceValidationError('invalid_input');
  }

  return normalizeLimit(limit);
}

/**
 * The account page identity, and nothing else. Character-for-character the
 * shape the web client renders: no recovery email, no credential or session
 * material, no SSO identity, and no owned-data counts.
 */
export interface AccountProfile {
  userId: string;
  /** Null only for an identity created without an email (SSO-only path). */
  email: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  emailVerifiedAt: string | null;
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
   * One lightweight owner-scoped profile read. It reuses the export profile
   * query (the same active-identity predicate) but returns only the identity
   * fields above; nothing is streamed and no export section is assembled.
   */
  @Get()
  async getAccount(
    @Req() request: SessionRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ account: AccountProfile }> {
    const { userId } = requireSession(request);
    const profile = await this.runtime.getService().assertExportable(userId);

    response.setHeader('cache-control', 'no-store');

    return {
      account: {
        userId: profile.userId,
        email: profile.email,
        status: profile.status,
        createdAt: profile.createdAt,
        updatedAt: profile.updatedAt,
        emailVerifiedAt: profile.emailVerifiedAt,
      },
    };
  }

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

  /**
   * One owner-scoped page of the audit trail, newest first. The envelope is
   * `{ entries, nextCursor }`; entries contain counts and identifiers only.
   * The owner is the session actor, and a NULL-owner deletion record can never
   * match this predicate.
   */
  @Get('audit')
  async listAudit(
    @Req() request: SessionRequest,
    @Res({ passthrough: true }) response: Response,
    @Query('cursor') cursor: unknown,
    @Query('limit') limit: unknown,
  ): Promise<AccountAuditPage> {
    const { userId } = requireSession(request);
    const page = await this.runtime
      .getService()
      .listAudit(userId, readAuditCursor(cursor), readAuditLimit(limit));

    response.setHeader('cache-control', 'no-store');

    return page;
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
    const confirmation = readConfirmationValue(body);
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
