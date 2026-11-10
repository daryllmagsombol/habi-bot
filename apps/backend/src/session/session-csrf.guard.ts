/**
 * Synchronizer-token CSRF guard for the H-017 contract slice (design §3).
 *
 * The token is bound to the validated session record, never derived from the
 * session secret, and never stored in a readable cookie. It must arrive in
 * `X-CSRF-Token` on state-changing routes. A missing or mismatched token and a
 * missing/mismatched Origin/Referer all return the same `403 csrf_invalid`
 * body without account or session detail. Double-submit cookies are not used.
 *
 * The presented token is compared with the record's stored SHA-256 hash in
 * constant time, so the raw token may live only with the client and a restarted
 * process can still verify it.
 *
 * SessionAuthGuard must have run first; this guard only reads its attachment.
 */
import { ForbiddenException, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { isSameOrigin, requireSession } from './session-request.js';
import type { SessionRequest } from './session-request.js';
import { csrfTokenMatches } from './session.service.js';

const CSRF_HEADER = 'x-csrf-token';

function readCsrfHeader(request: SessionRequest): string | undefined {
  const value = request.headers[CSRF_HEADER];

  return typeof value === 'string' ? value : undefined;
}

@Injectable()
export class SessionCsrfGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<SessionRequest>();
    const session = requireSession(request);

    if (!csrfTokenMatches(session.record.csrfToken, readCsrfHeader(request))) {
      throw new ForbiddenException({ error: { code: 'csrf_invalid' } });
    }

    if (!isSameOrigin(request)) {
      throw new ForbiddenException({ error: { code: 'csrf_invalid' } });
    }

    return true;
  }
}
