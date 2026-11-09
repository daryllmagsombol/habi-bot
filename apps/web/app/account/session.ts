/**
 * The signed-in account profile, read server-side for the account page.
 *
 * The page needs the account email to render the deletion confirmation and to
 * tell a signed-out visitor from a signed-in one. It reads `GET /api/account`
 * — the lightweight identity projection — instead of reaching the separate
 * auth service, so the account page has one API dependency and never asks for
 * export content just to show an email.
 *
 * Only the session cookie is relayed, and the origin stays on this side of the
 * BFF. A 401 is "sign in"; a missing or unreachable API surface is an explicit
 * unavailable state, never a made-up account.
 */
import { readApiConfig } from '../../lib/api/config';
import { callerCookieHeader } from '../../lib/api/server';
import type { AccountEnvelopeDto, AccountProfileDto } from '../../lib/api/types';

export type AccountProfileResult =
  | { readonly ok: true; readonly account: AccountProfileDto }
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

function isAccountBody(value: unknown): value is AccountEnvelopeDto {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const account = (value as { account?: unknown }).account;

  return (
    typeof account === 'object' &&
    account !== null &&
    typeof (account as { userId?: unknown }).userId === 'string' &&
    typeof (account as { email?: unknown }).email === 'string'
  );
}

export async function fetchAccountProfile(): Promise<AccountProfileResult> {
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
    response = await fetch(`${config.origin}/api/account`, {
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

  if (!response.ok || !isAccountBody(body)) {
    return { ok: false, reason: 'unavailable' };
  }

  return { ok: true, account: body.account };
}
