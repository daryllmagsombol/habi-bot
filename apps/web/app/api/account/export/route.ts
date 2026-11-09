/**
 * `GET /api/account/export` — the account export as a same-origin download.
 *
 * The browser only sees this route; the API origin is server configuration and
 * never crosses into the response. Only the session cookie is relayed, and the
 * `Origin` header is asserted to the API origin because the browser's Origin
 * names the web origin.
 *
 * A successful export is streamed straight through with the API's
 * `content-disposition`, `content-type` and `cache-control: no-store`, so a
 * large account is never buffered here. A failure (401, 5xx, unreachable) keeps
 * the shared JSON envelope instead of pretending a download started.
 */
import { readApiConfig } from '../../../../lib/api/config';

export const dynamic = 'force-dynamic';

const SESSION_COOKIE = /^(?:__Host-)?habi_session=/;
const EXPORT_TIMEOUT_MS = 30_000;

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

function errorResponse(code: string, status: number): Response {
  return Response.json(
    { error: { code } },
    { status, headers: { 'cache-control': 'no-store' } },
  );
}

/** Keeps the API envelope (and anything the client must echo) on a failure. */
async function relayJson(upstream: Response): Promise<Response> {
  const headers = new Headers({ 'cache-control': 'no-store' });
  const contentType = upstream.headers.get('content-type');

  if (contentType !== null) {
    headers.set('content-type', contentType);
  }

  return new Response(await upstream.text(), {
    status: upstream.status,
    headers,
  });
}

export async function GET(request: Request): Promise<Response> {
  const config = readApiConfig();

  if (config.kind !== 'configured') {
    return errorResponse('api_unavailable', 503);
  }

  const headers: Record<string, string> = {
    origin: config.origin,
    accept: 'application/json',
  };
  const cookie = sessionCookies(request.headers.get('cookie'));
  const userAgent = request.headers.get('user-agent');

  if (cookie !== undefined) {
    headers.cookie = cookie;
  }

  if (userAgent !== null) {
    headers['user-agent'] = userAgent;
  }

  let upstream: Response;

  try {
    upstream = await fetch(`${config.origin}/api/account/export`, {
      method: 'GET',
      headers,
      cache: 'no-store',
      signal: AbortSignal.timeout(EXPORT_TIMEOUT_MS),
    });
  } catch {
    return errorResponse('api_unavailable', 502);
  }

  const contentType = upstream.headers.get('content-type') ?? '';

  if (!upstream.ok || !contentType.startsWith('application/json')) {
    return relayJson(upstream);
  }

  const responseHeaders = new Headers({
    'content-type': contentType,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  const disposition = upstream.headers.get('content-disposition');

  if (disposition !== null) {
    responseHeaders.set('content-disposition', disposition);
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}
