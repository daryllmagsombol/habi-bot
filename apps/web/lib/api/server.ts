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
  ArtifactDetailEnvelopeDto,
  ArtifactListDto,
  ArtifactVersionListDto,
  AttachmentListDto,
  BotDetailDto,
  BotListDto,
  BotThreadPageDto,
  MemoryListDto,
  MessagePageDto,
  SkillListDto,
} from './types';

export type ApiFailureReason =
  | 'unconfigured'
  | 'invalid_config'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'unavailable'
  | 'unsupported'
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

  if (status === 415) {
    return 'unsupported';
  }

  if (status >= 500) {
    return 'unavailable';
  }

  return 'error';
}

function withQuery(
  path: string,
  params: Readonly<Record<string, string | number | undefined>>,
): string {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
    if (typeof value === 'string' || typeof value === 'number') {
      search.set(key, String(value));
    }
  }

  const query = search.toString();

  return query.length === 0 ? path : `${path}?${query}`;
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
  options: {
    readonly limit?: number;
    readonly before?: string;
    readonly after?: string;
  } = {},
): Promise<ApiResult<MessagePageDto>> {
  return apiGet<MessagePageDto>(
    withQuery(`/threads/${encodeURIComponent(threadId)}/messages`, {
      limit: options.limit,
      before: options.before,
      after: options.after,
    }),
    cookie,
  );
}

export function fetchAttachments(
  threadId: string,
  cookie: string | undefined,
): Promise<ApiResult<AttachmentListDto>> {
  return apiGet<AttachmentListDto>(
    `/threads/${encodeURIComponent(threadId)}/attachments`,
    cookie,
  );
}

export interface AttachmentContentResult {
  readonly text: string;
  readonly contentType: string;
}

/**
 * Raw attachment text. `503 api_unavailable` means the server has no
 * `HABI_ATTACHMENT_STORAGE_ROOT`; `415` means the bytes are not a text type.
 * Neither is ever replaced with sample content.
 */
export async function fetchAttachmentContent(
  attachmentId: string,
  cookie: string | undefined,
): Promise<ApiResult<AttachmentContentResult>> {
  const config = readApiConfig();

  if (config.kind === 'unset') {
    return failure('unconfigured', 0);
  }

  if (config.kind === 'invalid') {
    return failure('invalid_config', 0);
  }

  const requestHeaders: Record<string, string> = {
    accept: 'text/plain, text/markdown;q=0.9, application/json;q=0.8',
  };

  if (cookie !== undefined) {
    requestHeaders.cookie = cookie;
  }

  let response: Response;

  try {
    response = await fetch(
      `${config.origin}/api/attachments/${encodeURIComponent(attachmentId)}/content`,
      {
        method: 'GET',
        headers: requestHeaders,
        cache: 'no-store',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
  } catch {
    return failure('unavailable', 0);
  }

  if (!response.ok) {
    const body: unknown = await response.json().catch(() => undefined);

    return failure(reasonForStatus(response.status), response.status, readErrorCode(body));
  }

  return {
    ok: true,
    data: {
      text: await response.text(),
      contentType: response.headers.get('content-type') ?? 'text/plain',
    },
  };
}

export function fetchMemories(
  botId: string,
  cookie: string | undefined,
  options: { readonly limit?: number; readonly cursor?: string } = {},
): Promise<ApiResult<MemoryListDto>> {
  return apiGet<MemoryListDto>(
    withQuery(`/bots/${encodeURIComponent(botId)}/memories`, options),
    cookie,
  );
}

export function fetchSkills(
  cookie: string | undefined,
  options: {
    readonly botId?: string;
    readonly status?: string;
    readonly limit?: number;
    readonly cursor?: string;
  } = {},
): Promise<ApiResult<SkillListDto>> {
  return apiGet<SkillListDto>(withQuery('/skills', options), cookie);
}

export function fetchArtifacts(
  cookie: string | undefined,
  options: {
    readonly conversationId?: string;
    readonly limit?: number;
    readonly cursor?: string;
  } = {},
): Promise<ApiResult<ArtifactListDto>> {
  return apiGet<ArtifactListDto>(withQuery('/artifacts', options), cookie);
}

export function fetchArtifact(
  artifactId: string,
  cookie: string | undefined,
  version?: number,
): Promise<ApiResult<ArtifactDetailEnvelopeDto>> {
  return apiGet<ArtifactDetailEnvelopeDto>(
    withQuery(`/artifacts/${encodeURIComponent(artifactId)}`, { version }),
    cookie,
  );
}

export function fetchArtifactVersions(
  artifactId: string,
  cookie: string | undefined,
): Promise<ApiResult<ArtifactVersionListDto>> {
  return apiGet<ArtifactVersionListDto>(
    `/artifacts/${encodeURIComponent(artifactId)}/versions`,
    cookie,
  );
}
