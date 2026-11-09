/**
 * The signed-in viewer, read server-side for the account page.
 *
 * The page needs the account email to render the deletion confirmation and to
 * tell a signed-out visitor from a signed-in one. `GET /auth/me` is the
 * existing identity read on the same API origin; only the session cookie is
 * relayed, and the origin stays on this side of the BFF.
 *
 * A 401 is "sign in"; a missing or disabled identity surface is an explicit
 * unavailable state, never a made-up account.
 */
import { readApiConfig } from '../../lib/api/config';
import { callerCookieHeader } from '../../lib/api/server';

export interface AccountViewer {
  readonly userId: string;
  readonly email: string;
}

export type AccountViewerResult =
  | { readonly ok: true; readonly viewer: AccountViewer }
  | {
      readonly ok: false;
      readonly reason: 'unconfigured' | 'invalid_config' | 'unauthorized' | 'unavailable';
    };

const SESSION_COOKIE = /^(?:__Host-)?habi_session=/;
const REQUEST_TIMEOUT_MS = 8_000;

function sessionCookies(header: string | undefined): string | undefined {
  if (header === undefined || header.length === 0) {
    return undefined;
  }

  const pairs = header
    .split(';')
    .map((pair) => pair.trim())
    .filter((pair) => SESSION_COOKIE.test(pair));

  return pairs.length === 0 ? undefined : pairs.join('; ');
}

function isViewerBody(value: unknown): value is { user: AccountViewer } {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const user = (value as { user?: unknown }).user;

  return (
    typeof user === 'object' &&
    user !== null &&
    typeof (user as { userId?: unknown }).userId === 'string' &&
    typeof (user as { email?: unknown }).email === 'string'
  );
}

export async function fetchAccountViewer(): Promise<AccountViewerResult> {
  const config = readApiConfig();

  if (config.kind === 'unset') {
    return { ok: false, reason: 'unconfigured' };
  }

  if (config.kind === 'invalid') {
    return { ok: false, reason: 'invalid_config' };
  }

  const cookie = sessionCookies(await callerCookieHeader());

  if (cookie === undefined) {
    return { ok: false, reason: 'unauthorized' };
  }

  let response: Response;

  try {
    response = await fetch(`${config.origin}/auth/me`, {
      method: 'GET',
      headers: { accept: 'application/json', cookie },
      cache: 'no-store',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: 'unavailable' };
  }

  if (response.status === 401) {
    return { ok: false, reason: 'unauthorized' };
  }

  const body: unknown = await response.json().catch(() => undefined);

  if (!response.ok || !isViewerBody(body)) {
    return { ok: false, reason: 'unavailable' };
  }

  return { ok: true, viewer: { userId: body.user.userId, email: body.user.email } };
}
