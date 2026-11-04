/**
 * Pre-auth browser-binding cookie for SSO flows (H-008 §5.1).
 *
 * `state` alone is not proof that the callback arrived in the browser that
 * started the flow. This cookie is a second, independent handle: its value is
 * minted per flow, stored only as a SHA-256 hash in the pending record, and
 * compared in constant time at the callback.
 *
 * Flags match the session cookie contract:
 *   HttpOnly, SameSite=Lax, Path=/, Secure outside local development, no Domain.
 *
 * `SameSite=Lax` is required rather than `Strict`: the provider redirects back
 * with a top-level cross-site GET, and a `Strict` cookie would not be sent, which
 * would make the binding fail closed for every real login. A cross-site POST
 * (the `form_post` response mode, H-008 §5.3) does not carry this cookie and is
 * therefore not an accepted callback shape — the callback route is GET only.
 */
import { isProductionEnvironment } from '../../session/session-cookie.js';

export const SSO_BINDING_COOKIE_PRODUCTION = '__Host-habi_sso';
/** Dev/test-only divergence: `__Host-` cannot be set over plain HTTP. */
export const SSO_BINDING_COOKIE_LOCAL = 'habi_sso';

export function ssoBindingCookieName(production = isProductionEnvironment()): string {
  return production ? SSO_BINDING_COOKIE_PRODUCTION : SSO_BINDING_COOKIE_LOCAL;
}

export function serializeSsoBindingCookie(
  secret: string,
  maxAgeSeconds: number,
  production = isProductionEnvironment(),
): string {
  const attributes = [
    `${ssoBindingCookieName(production)}=${secret}`,
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

export function clearSsoBindingCookie(production = isProductionEnvironment()): string {
  const attributes = [
    `${ssoBindingCookieName(production)}=`,
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

/** Reads only the binding cookie; the session cookie helper is separate. */
export function readSsoBindingCookie(
  cookieHeader: string | undefined,
  name = ssoBindingCookieName(),
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
