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

async function forward(
  request: Request,
  context: RouteContext,
  method: 'GET' | 'POST',
): Promise<Response> {
  const { path } = await context.params;
  const action = path.join('/');

  if (!ALLOWED_ACTIONS.has(action)) {
    return errorResponse('not_found', 404);
  }

  if ((method === 'GET') !== (action === 'me')) {
    return errorResponse('method_not_allowed', 405);
  }

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

  let body: string | undefined;

  if (method === 'POST') {
    const contentType = request.headers.get('content-type');

    if (contentType !== null) {
      headers['content-type'] = contentType;
    }

    body = await request.text();

    if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
      return errorResponse('invalid_request', 413);
    }
  }

  let upstream: Response;

  try {
    upstream = await fetch(`${authApiOrigin()}/auth/${action}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    return errorResponse('auth_unavailable', 502);
  }

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

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  return forward(request, context, 'GET');
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  return forward(request, context, 'POST');
}
