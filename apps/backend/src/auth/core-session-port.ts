/**
 * Adapter from the H-017 in-memory session core to `AuthSessionPort`.
 *
 * This is the only auth-slice module that imports `SessionService`; no other
 * auth module needs to know the core exists. `issue` always mints a brand-new
 * session family, which is the H-017 fixation rule: a client-supplied session
 * identifier is never adopted at login.
 */
import type { SessionService } from '../session/session.service.js';
import type { AuthSessionObserver, AuthSessionPort, IssuedAuthSession } from './auth-session-port.js';

export class CoreSessionPort implements AuthSessionPort {
  constructor(private readonly sessions: SessionService) {}

  issue(userId: string, observer: AuthSessionObserver, at: number): IssuedAuthSession {
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

  revoke(sessionSecret: string, at: number): boolean {
    return this.sessions.revoke(sessionSecret, at);
  }
}
