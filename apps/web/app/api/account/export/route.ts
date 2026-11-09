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
import { proxyError, relayJson, upstreamHeaders } from '../../proxy';

export const dynamic = 'force-dynamic';

const EXPORT_TIMEOUT_MS = 30_000;

export async function GET(request: Request): Promise<Response> {
  const config = readApiConfig();

  if (config.kind !== 'configured') {
    return proxyError('api_unavailable', 503);
  }

  const headers = upstreamHeaders(request, config.origin, 'application/json');

  let upstream: Response;

  try {
    upstream = await fetch(`${config.origin}/api/account/export`, {
      method: 'GET',
      headers,
      cache: 'no-store',
      signal: AbortSignal.timeout(EXPORT_TIMEOUT_MS),
    });
  } catch {
    return proxyError('api_unavailable', 502);
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
