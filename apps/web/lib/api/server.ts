/**
 * Server-side reads against the P1 chat API.
 *
 * Only server components call this module: `next/headers` is the cookie source,
 * so the browser never sees the API origin and the session cookie stays on the
 * web origin. Writers (send, cancel, stream) go through the same-origin BFF in
 * `app/api/**`, which forwards them with the caller's cookie and CSRF token.
 *
 * Every failure is a typed result, never an exception the page has to guess
 * about. A configured-but-unreachable API is `unavailable`; it is never treated
 * as "no data" and never falls back to the sample preview.
 */
import { headers } from 'next/headers';
import { readApiConfig } from './config';
import type {
  BotDetailDto,
  BotListDto,
  BotThreadPageDto,
  MessagePageDto,
} from './types';

export type ApiFailureReason =
  | 'unconfigured'
  | 'invalid_config'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'unavailable'
  | 'error';

export interface ApiFailure {
  readonly ok: false;
  readonly reason: ApiFailureReason;
  /** HTTP status, or 0 when no response was received. */
  readonly status: number;
  /** The closed error code from `{ error: { code } }`, when present. */
  readonly code?: string;
}

export type ApiResult<T> = { readonly ok: true; readonly data: T } | ApiFailure;

const REQUEST_TIMEOUT_MS = 8_000;

function failure(
  reason: ApiFailureReason,
  status: number,
  code?: string,
): ApiFailure {
  return code === undefined ? { ok: false, reason, status } : { ok: false, reason, status, code };
}

function readErrorCode(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }

  const error = (value as { error?: unknown }).error;

  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  const code = (error as { code?: unknown }).code;

  return typeof code === 'string' ? code : undefined;
}

function reasonForStatus(status: number): ApiFailureReason {
  if (status === 401) {
    return 'unauthorized';
  }

  if (status === 403) {
    return 'forbidden';
  }

  if (status === 404) {
    return 'not_found';
  }

  if (status >= 500) {
    return 'unavailable';
  }

  return 'error';
}

/**
 * Reads the caller's cookie header from the incoming request. Server components
 * render inside a request context, so the session cookie is available here even
 * though this module never touches the browser.
 */
export async function callerCookieHeader(): Promise<string | undefined> {
  const incoming = await headers();
  const cookie = incoming.get('cookie');

  return cookie === null || cookie.length === 0 ? undefined : cookie;
}

async function apiGet<T>(path: string, cookie: string | undefined): Promise<ApiResult<T>> {
  const config = readApiConfig();

  if (config.kind === 'unset') {
    return failure('unconfigured', 0);
  }

  if (config.kind === 'invalid') {
    return failure('invalid_config', 0);
  }

  const requestHeaders: Record<string, string> = { accept: 'application/json' };

  if (cookie !== undefined) {
    requestHeaders.cookie = cookie;
  }

  let response: Response;

  try {
    response = await fetch(`${config.origin}/api${path}`, {
      method: 'GET',
      headers: requestHeaders,
      cache: 'no-store',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return failure('unavailable', 0);
  }

  const body: unknown = await response.json().catch(() => undefined);

  if (!response.ok) {
    return failure(reasonForStatus(response.status), response.status, readErrorCode(body));
  }

  if (body === undefined) {
    return failure('error', response.status);
  }

  return { ok: true, data: body as T };
}

export function fetchBots(cookie: string | undefined): Promise<ApiResult<BotListDto>> {
  return apiGet<BotListDto>('/bots', cookie);
}

export function fetchBot(
  botId: string,
  cookie: string | undefined,
): Promise<ApiResult<BotDetailDto>> {
  return apiGet<BotDetailDto>(`/bots/${encodeURIComponent(botId)}`, cookie);
}

export function fetchThreads(
  botId: string,
  cookie: string | undefined,
): Promise<ApiResult<BotThreadPageDto>> {
  return apiGet<BotThreadPageDto>(`/bots/${encodeURIComponent(botId)}/threads`, cookie);
}

export function fetchMessages(
  threadId: string,
  cookie: string | undefined,
): Promise<ApiResult<MessagePageDto>> {
  return apiGet<MessagePageDto>(
    `/threads/${encodeURIComponent(threadId)}/messages`,
    cookie,
  );
}
