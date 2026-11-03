/**
 * Session cookie authentication for the H-017 contract slice.
 *
 * Validates the opaque cookie on every request and resolves the user id from
 * the server-side record only. Client-supplied identity headers are never
 * read. Every failure (missing, unknown, expired, revoked, rotated reuse)
 * returns the same `401 unauthenticated` body, as required by design §6.
 */
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { readRequestSessionCookie } from './session-cookie.js';
import { requestNow } from './session-request.js';
import type { SessionRequest } from './session-request.js';
import { SessionService, SESSION_FAILURE } from './session.service.js';

@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(@Inject(SessionService) private readonly sessions: SessionService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<SessionRequest>();
    const sessionId = readRequestSessionCookie(request);
    const result =
      sessionId === undefined
        ? SESSION_FAILURE
        : this.sessions.validate(sessionId, requestNow(request));

    if (!result.ok) {
      throw new UnauthorizedException({ error: { code: 'unauthenticated' } });
    }

    request.sessionSpike = { userId: result.userId, record: result.record };
    return true;
  }
}
