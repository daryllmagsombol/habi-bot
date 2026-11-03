/**
 * The auth slice's only view of session issuance.
 *
 * `AuthService` depends on this interface, never on the H-017 session core, so
 * the in-memory core can be swapped for the durable implementation later and
 * service tests can use a fake. `CoreSessionPort` is the single adapter that
 * imports `SessionService`; it lives in its own module and is wired by
 * `AuthRuntime`.
 *
 * The raw session secret travels from the adapter to the controller and then
 * only into the `Set-Cookie` header. It is never returned in a JSON body or
 * logged.
 */

export interface AuthSessionObserver {
  readonly userAgent?: string;
  readonly ip?: string;
}

export interface IssuedAuthSession {
  /** Opaque session secret. Set-Cookie only. */
  readonly sessionSecret: string;
  readonly csrfToken: string;
  readonly maxAgeSeconds: number;
}

export interface AuthSessionPort {
  issue(userId: string, observer: AuthSessionObserver, at: number): IssuedAuthSession;
  revoke(sessionSecret: string, at: number): boolean;
}

export const AUTH_SESSION_PORT = Symbol('HABI_AUTH_SESSION_PORT');
