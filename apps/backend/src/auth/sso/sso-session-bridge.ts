/**
 * Adapter from the H-017 in-memory session core to `SsoSessionPort`.
 *
 * SSO-issued sessions must be the *same* server-side records the H-014 auth
 * module validates at `GET /auth/me` and the P1 chat API validates at `/api/*`.
 * `AuthModule` re-exports the shared `SessionCoreModule`, so this bridge injects
 * the one application-wide `SessionService` directly. Injecting it explicitly
 * also makes a missing auth/session module a startup failure rather than a
 * silent second session universe.
 */
import { Inject, Injectable } from '@nestjs/common';
import { SessionService } from '../../session/session.service.js';
import type { AuthSessionObserver, IssuedAuthSession } from '../auth-session-port.js';
import type { SsoSessionPort } from './sso-types.js';

@Injectable()
export class SsoSessionBridge implements SsoSessionPort {
  constructor(@Inject(SessionService) private readonly sessions: SessionService) {}

  issue(
    userId: string,
    observer: AuthSessionObserver,
    at: number,
  ): IssuedAuthSession {
    const issued = this.sessions.create(userId, observer, at);

    return {
      sessionSecret: issued.sessionId,
      csrfToken: issued.csrfToken,
      maxAgeSeconds: Math.max(
        0,
        Math.floor((issued.record.absoluteExpiresAt - at) / 1000),
      ),
    };
  }

  validate(
    sessionSecret: string,
    at: number,
  ): { userId: string; csrfToken: string } | undefined {
    const result = this.sessions.validate(sessionSecret, at);

    if (!result.ok) {
      return undefined;
    }

    return { userId: result.userId, csrfToken: result.record.csrfToken };
  }

  revoke(sessionSecret: string, at: number): boolean {
    return this.sessions.revoke(sessionSecret, at);
  }
}
