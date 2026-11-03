/**
 * Session cookie serialization for the H-017 contract slice.
 *
 * Design §2.1: `__Host-habi_session`, HttpOnly, SameSite=Lax, Path=/, no
 * Domain, Secure outside local development. The `__Host-` prefix requires
 * Secure, so a non-production server uses the unprefixed dev name; that
 * divergence is documented and is the only difference between environments.
 */
import type { Request } from 'express';

export const SESSION_COOKIE_PRODUCTION = '__Host-habi_session';
/** Dev/test-only divergence: `__Host-` cannot be set over plain HTTP. */
export const SESSION_COOKIE_LOCAL = 'habi_session';

export function isProductionEnvironment(): boolean {
  return process.env.NODE_ENV === 'production';
}

export function sessionCookieName(production = isProductionEnvironment()): string {
  return production ? SESSION_COOKIE_PRODUCTION : SESSION_COOKIE_LOCAL;
}

/**
 * The cookie lifetime mirrors the server-side absolute expiry only; it is
 * never a durable forever-cookie. `Max-Age` is recomputed on rotation because
 * rotation does not extend the absolute expiry.
 */
export function serializeSessionCookie(
  sessionId: string,
  maxAgeSeconds: number,
  production = isProductionEnvironment(),
): string {
  const attributes = [
    `${sessionCookieName(production)}=${sessionId}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ];

  if (production) {
    attributes.push('Secure');
  }

  return attributes.join('; ');
}

export function clearSessionCookie(production = isProductionEnvironment()): string {
  const attributes = [
    `${sessionCookieName(production)}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];

  if (production) {
    attributes.push('Secure');
  }

  return attributes.join('; ');
}

/**
 * Minimal `Cookie` header reader. No cookie-parser dependency is added; only
 * the single session cookie is needed and values are base64url tokens.
 */
export function readSessionCookie(
  cookieHeader: string | undefined,
  name = sessionCookieName(),
): string | undefined {
  if (typeof cookieHeader !== 'string' || cookieHeader.length === 0) {
    return undefined;
  }

  for (const pair of cookieHeader.split(';')) {
    const separator = pair.indexOf('=');

    if (separator === -1) {
      continue;
    }

    if (pair.slice(0, separator).trim() === name) {
      return pair.slice(separator + 1).trim();
    }
  }

  return undefined;
}

export function readRequestSessionCookie(request: Request): string | undefined {
  return readSessionCookie(request.headers.cookie);
}
