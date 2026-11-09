/**
 * Same-origin BFF for the P1 chat surface.
 *
 * The browser only ever calls `/api/**` on the web origin. This module forwards
 * the caller's session cookie and synchronizer CSRF token to the Nest API at
 * `HABI_API_URL` (server configuration, never a request value). The backend
 * origin, the cookie value, and any credential never cross into client code and
 * are never logged.
 *
 * Only the session cookie is relayed; unrelated web-origin cookies stay here.
 * `Origin` is asserted to the API origin because the browser's Origin names the
 * web origin, and `SessionCsrfGuard` compares it with the API host.
 *
 * Errors keep the backend envelope (`{ error: { code } }`) so the client maps
 * one vocabulary. A missing or invalid `HABI_API_URL` is `503 api_unavailable`,
 * which the pages render as an explicit error state — never as sample data.
 */
import { readApiConfig } from '../../lib/api/config';

const SESSION_COOKIE = /^(?:__Host-)?habi_session=/;
/**
 * The artifact transport enforces its own 100 KB content bound downstream. The
 * BFF only needs a ceiling large enough to carry that JSON envelope, so a large
 * write is forwarded and the API's `413`/`invalid_input` answer is relayed
 * instead of being pre-empted here.
 */
const MAX_BODY_BYTES = 256 * 1024;
const JSON_TIMEOUT_MS = 15_000;

const WRITE_METHODS = new Set(['POST', 'PATCH', 'DELETE']);

export function proxyError(code: string, status: number): Response {
  return Response.json(
    { error: { code } },
    { status, headers: { 'cache-control': 'no-store' } },
  );
}

/** Rejects empty, dot, and separator-bearing ids before they build a path. */
export function safeSegment(value: string | undefined): string | undefined {
  if (
    value === undefined ||
    value.length === 0 ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\')
  ) {
    return undefined;
  }

  return encodeURIComponent(value);
}

function sessionCookies(header: string | null): string | undefined {
  if (header === null || header.length === 0) {
    return undefined;
  }

  const pairs = header
    .split(';')
    .map((pair) => pair.trim())
    .filter((pair) => SESSION_COOKIE.test(pair));

  return pairs.length === 0 ? undefined : pairs.join('; ');
}

function upstreamHeaders(
  request: Request,
  origin: string,
  accept: string,
): Record<string, string> {
  const headers: Record<string, string> = { origin, accept };
  const cookie = sessionCookies(request.headers.get('cookie'));
  const csrf = request.headers.get('x-csrf-token');
  const userAgent = request.headers.get('user-agent');

  if (cookie !== undefined) {
    headers.cookie = cookie;
  }

  if (csrf !== null) {
    headers['x-csrf-token'] = csrf;
  }

  if (userAgent !== null) {
    headers['user-agent'] = userAgent;
  }

  return headers;
}

function relayJson(upstream: Response): Promise<Response> {
  return (async () => {
    const headers = new Headers({ 'cache-control': 'no-store' });
    const contentType = upstream.headers.get('content-type');
    const retryAfter = upstream.headers.get('retry-after');
    const csrfToken = upstream.headers.get('x-csrf-token');

    if (contentType !== null) {
      headers.set('content-type', contentType);
    }

    if (retryAfter !== null) {
      headers.set('retry-after', retryAfter);
    }

    if (csrfToken !== null) {
      headers.set('x-csrf-token', csrfToken);
    }

    return new Response(await upstream.text(), {
      status: upstream.status,
      headers,
    });
  })();
}

/**
 * Forwards one JSON request. `path` starts with `/` and may carry a query
 * string; the method comes from the incoming request.
 */
export async function forwardJson(request: Request, path: string): Promise<Response> {
  const config = readApiConfig();

  if (config.kind !== 'configured') {
    return proxyError('api_unavailable', 503);
  }

  const method = request.method.toUpperCase();
  const write = WRITE_METHODS.has(method);
  const headers = upstreamHeaders(request, config.origin, 'application/json');
  let body: string | undefined;

  if (write) {
    const contentType = request.headers.get('content-type');

    if (contentType !== null) {
      headers['content-type'] = contentType;
    }

    body = await request.text();

    if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
      return proxyError('invalid_input', 413);
    }
  }

  let upstream: Response;

  try {
    upstream = await fetch(`${config.origin}/api${path}`, {
      method: write ? method : 'GET',
      headers,
      ...(body === undefined ? {} : { body }),
      cache: 'no-store',
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    });
  } catch {
    return proxyError('api_unavailable', 502);
  }

  return relayJson(upstream);
}

/**
 * Forwards the attachment content read. The API answers raw `text/plain` or
 * `text/markdown`; every failure keeps the JSON envelope, including the
 * `503 api_unavailable` a server without `HABI_ATTACHMENT_STORAGE_ROOT` returns.
 * The content type is relayed so the client never has to guess it.
 */
export async function forwardText(request: Request, path: string): Promise<Response> {
  const config = readApiConfig();

  if (config.kind !== 'configured') {
    return proxyError('api_unavailable', 503);
  }

  const headers = upstreamHeaders(
    request,
    config.origin,
    'text/plain, text/markdown;q=0.9, application/json;q=0.8',
  );

  let upstream: Response;

  try {
    upstream = await fetch(`${config.origin}/api${path}`, {
      method: 'GET',
      headers,
      cache: 'no-store',
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    });
  } catch {
    return proxyError('api_unavailable', 502);
  }

  const contentType = upstream.headers.get('content-type') ?? '';

  if (!upstream.ok || !contentType.startsWith('text/')) {
    return relayJson(upstream);
  }

  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: {
      'cache-control': 'no-store',
      'content-type': contentType,
      'x-content-type-options': 'nosniff',
    },
  });
}

/**
 * Passes the Run event stream through untouched, including the `Last-Event-ID`
 * request header and the `id:` frames the browser resumes from. There is no
 * timeout here: the backend owns the connection deadline (`SSE_MAX_CONNECTION_MS`)
 * and the client reconnects with its cursor.
 */
export async function forwardStream(request: Request, path: string): Promise<Response> {
  const config = readApiConfig();

  if (config.kind !== 'configured') {
    return proxyError('api_unavailable', 503);
  }

  const headers = upstreamHeaders(request, config.origin, 'text/event-stream');
  const lastEventId = request.headers.get('last-event-id');

  if (lastEventId !== null) {
    headers['last-event-id'] = lastEventId;
  }

  let upstream: Response;

  try {
    upstream = await fetch(`${config.origin}/api${path}`, {
      method: 'GET',
      headers,
      cache: 'no-store',
      signal: request.signal,
    });
  } catch {
    return proxyError('api_unavailable', 502);
  }

  const contentType = upstream.headers.get('content-type') ?? '';

  // A 401/404/5xx is a normal JSON envelope; relay it as such rather than
  // pretending an empty event stream succeeded.
  if (!upstream.ok || !contentType.startsWith('text/event-stream')) {
    return relayJson(upstream);
  }

  const responseHeaders = new Headers({
    'content-type': contentType,
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

/** Appends the caller's query string, if any, to a forwarded path. */
export function withSearch(request: Request, path: string): string {
  const search = new URL(request.url).search;

  return search.length === 0 ? path : `${path}${search}`;
}

/** A dynamic route's awaited segment map, as Next hands it to a handler. */
export interface ResourceContext {
  readonly params: Promise<Record<string, string>>;
}

/**
 * The generic single-resource route: one id, one collection.
 *
 * An unusable id is answered here as `404 not_found` and never becomes part of
 * a path. Everything else is forwarded with the incoming method, so `GET`,
 * `PATCH` and `DELETE` share one implementation. `relaySearch` carries the
 * caller's query string for reads that page or filter.
 */
export function singleResourceHandler(
  field: string,
  collection: string,
  relaySearch: boolean,
): (request: Request, context: ResourceContext) => Promise<Response> {
  return async (request, context) => {
    const params = await context.params;
    const segment = safeSegment(params[field]);

    if (segment === undefined) {
      return proxyError('not_found', 404);
    }

    const path = `/${collection}/${segment}`;

    return forwardJson(request, relaySearch ? withSearch(request, path) : path);
  };
}
