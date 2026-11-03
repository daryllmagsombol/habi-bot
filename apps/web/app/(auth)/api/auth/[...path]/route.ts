/**
 * Same-origin BFF for the auth routes.
 *
 * Browser code never talks to the Nest API cross-origin, so the session cookie
 * stays HttpOnly on the web origin and no API base URL or credential is exposed
 * to client code. The upstream target is server configuration
 * (`HABI_AUTH_API_URL`), never a request value, and only the five known actions
 * are proxied.
 *
 * CSRF is not implemented here. The proxy forwards `X-CSRF-Token`, the session
 * cookie, and an Origin matching the upstream; the H-017 guards still make the
 * decision. `Origin` is asserted by the server-side proxy because the browser's
 * Origin names the web origin, not the API host.
 *
 * The client IP is not forwarded as a trusted identity: the backend reads its
 * socket peer, which is this proxy. Per-client rate limiting is therefore
 * coarse in this slice and documented as a POC limitation.
 */

export const dynamic = 'force-dynamic';

const DEFAULT_AUTH_API_ORIGIN = 'http://127.0.0.1:3001';
const ALLOWED_ACTIONS = new Set(['signup', 'login', 'logout', 'recovery/request', 'me']);
const MAX_BODY_BYTES = 16 * 1024;
const SESSION_COOKIE = /^(?:__Host-)?habi_session=/;

interface RouteContext {
  params: Promise<{ path: string[] }>;
}

function authApiOrigin(): string {
  const configured = process.env.HABI_AUTH_API_URL?.trim();

  if (configured === undefined || configured.length === 0) {
    return DEFAULT_AUTH_API_ORIGIN;
  }

  try {
    return new URL(configured).origin;
  } catch {
    return DEFAULT_AUTH_API_ORIGIN;
  }
}

function errorResponse(code: string, status: number): Response {
  return Response.json(
    { error: { code } },
    { status, headers: { 'cache-control': 'no-store' } },
  );
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

type PreparedRequest =
  | { readonly ok: true; readonly headers: Record<string, string>; readonly body?: string }
  | { readonly ok: false; readonly response: Response };

/**
 * Whitelist and method gate. Returns the response to send instead of proxying,
 * or `undefined` when the action may be forwarded.
 */
function rejectUnsupported(action: string, method: 'GET' | 'POST'): Response | undefined {
  if (!ALLOWED_ACTIONS.has(action)) {
    return errorResponse('not_found', 404);
  }

  if ((method === 'GET') !== (action === 'me')) {
    return errorResponse('method_not_allowed', 405);
  }

  return undefined;
}

/**
 * Builds the upstream request headers, relaying only the session cookie, the
 * CSRF token, the user agent, and (for POST) the content type. The origin is
 * asserted here because the browser's Origin names the web origin.
 */
function upstreamHeaders(request: Request): Record<string, string> {
  const headers: Record<string, string> = {
    origin: authApiOrigin(),
    accept: 'application/json',
  };
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

/**
 * Builds the upstream headers and reads the body for POST actions. An oversized
 * body returns the 413 response instead, matching the other proxy rejections.
 */
async function prepareRequest(
  request: Request,
  method: 'GET' | 'POST',
): Promise<PreparedRequest> {
  const headers = upstreamHeaders(request);

  if (method !== 'POST') {
    return { ok: true, headers };
  }

  const contentType = request.headers.get('content-type');

  if (contentType !== null) {
    headers['content-type'] = contentType;
  }

  const body = await request.text();

  if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
    return { ok: false, response: errorResponse('invalid_request', 413) };
  }

  return { ok: true, headers, body };
}

/**
 * Copies the upstream status and the relayed headers (content type, CSRF
 * token, retry-after, and every Set-Cookie) onto a no-store response.
 */
async function relayResponse(upstream: Response): Promise<Response> {
  const responseHeaders = new Headers({ 'cache-control': 'no-store' });
  const contentType = upstream.headers.get('content-type');
  const csrfToken = upstream.headers.get('x-csrf-token');
  const retryAfter = upstream.headers.get('retry-after');

  if (contentType !== null) {
    responseHeaders.set('content-type', contentType);
  }

  if (csrfToken !== null) {
    responseHeaders.set('x-csrf-token', csrfToken);
  }

  if (retryAfter !== null) {
    responseHeaders.set('retry-after', retryAfter);
  }

  for (const setCookie of upstream.headers.getSetCookie()) {
    responseHeaders.append('set-cookie', setCookie);
  }

  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: responseHeaders,
  });
}

async function forward(
  request: Request,
  context: RouteContext,
  method: 'GET' | 'POST',
): Promise<Response> {
  const { path } = await context.params;
  const action = path.join('/');
  const rejection = rejectUnsupported(action, method);

  if (rejection !== undefined) {
    return rejection;
  }

  const prepared = await prepareRequest(request, method);

  if (!prepared.ok) {
    return prepared.response;
  }

  let upstream: Response;

  try {
    upstream = await fetch(`${authApiOrigin()}/auth/${action}`, {
      method,
      headers: prepared.headers,
      ...(prepared.body === undefined ? {} : { body: prepared.body }),
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    return errorResponse('auth_unavailable', 502);
  }

  return relayResponse(upstream);
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  return forward(request, context, 'GET');
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  return forward(request, context, 'POST');
}
