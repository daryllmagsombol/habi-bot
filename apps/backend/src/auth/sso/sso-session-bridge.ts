/**
 * Adapter from the H-017 in-memory session core to `SsoSessionPort`.
 *
 * SSO-issued sessions must be the *same* server-side records the H-014 auth
 * module validates at `GET /auth/me`; a second `SessionService` instance would
 * silently produce sessions that no other auth surface accepts. `AuthModule`
 * keeps its providers private, so this bridge resolves the instance that already
 * exists in the application container instead of constructing a copy.
 *
 * The lookup is explicit and one-time: if the auth module is missing from the
 * graph, the SSO module fails at startup rather than degrading into a separate
 * session universe.
 */
import { Inject, Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { SessionService } from '../../session/session.service.js';
import type { AuthSessionObserver, IssuedAuthSession } from '../auth-session-port.js';
import type { SsoSessionPort } from './sso-types.js';

@Injectable()
export class SsoSessionBridge implements SsoSessionPort {
  private readonly sessions: SessionService;

  constructor(@Inject(ModuleRef) moduleRef: ModuleRef) {
    this.sessions = moduleRef.get(SessionService, { strict: false });
  }

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
