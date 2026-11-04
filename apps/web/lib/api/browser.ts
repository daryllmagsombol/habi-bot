/**
 * Browser-side calls for the chat surface.
 *
 * Everything goes to the same-origin `/api/**` BFF. The backend origin, the
 * session cookie, and any credential stay server-side; this module only knows
 * relative paths. Writers carry the synchronizer CSRF token the H-017 session
 * layer expects.
 *
 * The token is published by the identity flow as a JS-readable `habi_csrf`
 * cookie or a `<meta name="habi-csrf">` tag. Neither exists in the current
 * identity build (it keeps the login result in local state), so `readCsrfToken`
 * returns undefined when nothing is published and the caller shows an explicit
 * error instead of sending a request that cannot pass `SessionCsrfGuard`.
 */
import type {
  GapDto,
  MessagePageDto,
  PostMessageDto,
  RunDto,
  RunEventDto,
} from './types';

const CSRF_COOKIE = 'habi_csrf';

export class ChatRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(code: string, status: number) {
    super(code);
    this.name = 'ChatRequestError';
    this.status = status;
    this.code = code;
  }
}

const ERROR_COPY: Readonly<Record<string, string>> = {
  unauthenticated: 'Your session has ended. Sign in again to continue.',
  csrf_invalid: 'The session did not accept the CSRF token. Reload the page and try again.',
  not_found: 'That thread or run is no longer available.',
  invalid_input: 'The message could not be sent as written.',
  invalid_cursor: 'The saved position is no longer valid.',
  bot_unavailable: 'This Bot is archived, so a message cannot be sent.',
  conversation_archived: 'This thread is archived, so a message cannot be sent.',
  allowance_exhausted: 'The daily allowance is exhausted. Nothing was sent.',
  usage_unknown: 'Daily usage could not be recorded, so nothing was sent.',
  api_unavailable: 'The chat API is not reachable right now.',
  cancel_unavailable:
    'This run may already have executed, so it cannot be cancelled safely. It was not relabelled.',
  request_failed: 'The request failed. Nothing was changed.',
};

export function chatErrorMessage(error: unknown): string {
  if (error instanceof ChatRequestError) {
    return ERROR_COPY[error.code] ?? `The request failed (${error.code}).`;
  }

  return 'Habi could not reach the chat API. Nothing was changed.';
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

/** `habi_csrf` cookie first, then a meta tag. Never persisted or logged here. */
export function readCsrfToken(): string | undefined {
  if (typeof document === 'undefined') {
    return undefined;
  }

  const meta = document
    .querySelector('meta[name="habi-csrf"]')
    ?.getAttribute('content')
    ?.trim();

  if (meta !== undefined && meta.length > 0) {
    return meta;
  }

  for (const pair of document.cookie.split(';')) {
    const separator = pair.indexOf('=');

    if (separator === -1) {
      continue;
    }

    if (pair.slice(0, separator).trim() === CSRF_COOKIE) {
      const value = pair.slice(separator + 1).trim();

      return value.length === 0 ? undefined : decodeURIComponent(value);
    }
  }

  return undefined;
}

async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => undefined);
}

async function requestJson<T>(
  path: string,
  init: RequestInit,
): Promise<T> {
  let response: Response;

  try {
    response = await fetch(path, {
      ...init,
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    throw new ChatRequestError('api_unavailable', 0);
  }

  const body = await readJson(response);

  if (!response.ok) {
    throw new ChatRequestError(
      readErrorCode(body) ?? 'request_failed',
      response.status,
    );
  }

  if (body === undefined) {
    throw new ChatRequestError('request_failed', response.status);
  }

  return body as T;
}

function writeHeaders(csrfToken: string | undefined): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };

  if (csrfToken !== undefined && csrfToken.length > 0) {
    headers['x-csrf-token'] = csrfToken;
  }

  return headers;
}

export function postMessage(
  threadId: string,
  content: string,
  clientMessageId: string,
  csrfToken: string | undefined,
): Promise<PostMessageDto> {
  return requestJson<PostMessageDto>(
    `/api/threads/${encodeURIComponent(threadId)}/messages`,
    {
      method: 'POST',
      headers: writeHeaders(csrfToken),
      body: JSON.stringify({ content, clientMessageId }),
    },
  );
}

export function cancelRun(
  runId: string,
  csrfToken: string | undefined,
): Promise<{ run: RunDto }> {
  return requestJson<{ run: RunDto }>(
    `/api/runs/${encodeURIComponent(runId)}/cancel`,
    { method: 'POST', headers: writeHeaders(csrfToken) },
  );
}

export function readMessages(threadId: string): Promise<MessagePageDto> {
  return requestJson<MessagePageDto>(
    `/api/threads/${encodeURIComponent(threadId)}/messages`,
    { method: 'GET', headers: { accept: 'application/json' } },
  );
}

export interface RunStreamHandlers {
  /** `cursor` is the frame's `id:` value (the resume cursor), when present. */
  onEvent: (event: RunEventDto, cursor: string | undefined) => void;
  /** A missing sequence range; the client must not silently continue. */
  onGap: (gap: GapDto) => void;
}

export type RunStreamEnd = 'ended' | 'error' | 'aborted';
export interface RunStreamHandle {
  abort: () => void;
}

interface ParsedFrame {
  readonly id: string | undefined;
  readonly event: string;
  readonly data: string;
}

function parseFrame(block: string): ParsedFrame | undefined {
  let id: string | undefined;
  let event = 'message';
  const data: string[] = [];

  for (const line of block.split(/\r?\n/)) {
    if (line.length === 0 || line.startsWith(':')) {
      continue;
    }

    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    const raw = separator === -1 ? '' : line.slice(separator + 1);
    const value = raw.startsWith(' ') ? raw.slice(1) : raw;

    if (field === 'id') {
      id = value;
    } else if (field === 'event') {
      event = value;
    } else if (field === 'data') {
      data.push(value);
    }
  }

  if (data.length === 0) {
    return undefined;
  }

  return { id, event, data: data.join('\n') };
}

function readJsonFrame(frame: ParsedFrame): unknown {
  try {
    return JSON.parse(frame.data);
  } catch {
    return undefined;
  }
}

function isEvent(value: unknown): value is RunEventDto {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { runId?: unknown }).runId === 'string' &&
    typeof (value as { seq?: unknown }).seq === 'number' &&
    typeof (value as { type?: unknown }).type === 'string'
  );
}

function isGap(value: unknown): value is GapDto {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { runId?: unknown }).runId === 'string' &&
    typeof (value as { fromSeq?: unknown }).fromSeq === 'number' &&
    typeof (value as { toSeq?: unknown }).toSeq === 'number'
  );
}

/**
 * One connection to `GET /api/runs/:runId/events`.
 *
 * `lastEventId` is the exact `id:` value of the last applied frame, so the
 * server replays strictly after it. The caller owns reconnection (and its
 * backoff), which keeps the retry and terminal states visible in one place.
 */
export function subscribeRun(
  runId: string,
  lastEventId: string | undefined,
  handlers: RunStreamHandlers,
  onEnd: (reason: RunStreamEnd, status?: number) => void,
): RunStreamHandle {
  const controller = new AbortController();
  let aborted = false;

  const headers: Record<string, string> = { accept: 'text/event-stream' };

  if (lastEventId !== undefined && lastEventId.length > 0) {
    headers['last-event-id'] = lastEventId;
  }

  void (async () => {
    try {
      const response = await fetch(
        `/api/runs/${encodeURIComponent(runId)}/events`,
        {
          method: 'GET',
          headers,
          cache: 'no-store',
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        onEnd('error', response.status);
        return;
      }

      const body = response.body;

      if (body === null) {
        onEnd('error');
        return;
      }

      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        let boundary = buffer.indexOf('\n\n');

        while (boundary !== -1) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const frame = parseFrame(block);

          if (frame !== undefined) {
            const parsed = readJsonFrame(frame);

            if (frame.event === 'gap' && isGap(parsed)) {
              handlers.onGap(parsed);
            } else if (isEvent(parsed)) {
              handlers.onEvent(parsed, frame.id);
            }
          }

          boundary = buffer.indexOf('\n\n');
        }
      }

      onEnd(aborted ? 'aborted' : 'ended');
    } catch {
      onEnd(aborted ? 'aborted' : 'error');
    }
  })();

  return {
    abort: () => {
      aborted = true;
      controller.abort();
    },
  };
}
