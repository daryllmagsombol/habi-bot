/**
 * `/api/account` — the lightweight profile read and the account deletion.
 *
 * The confirmation body is tiny (the account email), so it is read here and
 * bounded before it reaches the shared JSON proxy. Everything else — session
 * cookie, `x-csrf-token`, server-side `Origin`, the JSON envelope — is the same
 * forwarding contract as the rest of `/api/**`.
 */
import { forwardJson, proxyError } from '../proxy';

export const dynamic = 'force-dynamic';

/** The whole body is `{"confirm":"<email>"}`; anything larger is not that. */
const MAX_CONFIRM_BODY_BYTES = 4 * 1024;

/**
 * `GET /api/account` — the lightweight identity read.
 *
 * The export page uses this as its preflight before triggering a download, and
 * it is the same shape the server-rendered account page reads. It carries no
 * export content: only `{userId, email, status, createdAt, updatedAt,
 * emailVerifiedAt}`.
 */
export function GET(request: Request): Promise<Response> {
  return forwardJson(request, '/account');
}

export async function DELETE(request: Request): Promise<Response> {
  const body = await request.text();

  if (Buffer.byteLength(body, 'utf8') > MAX_CONFIRM_BODY_BYTES) {
    return proxyError('invalid_input', 413);
  }

  const headers = new Headers(request.headers);
  // The body is resent by fetch, so a stale length must not ride along.
  headers.delete('content-length');
  headers.delete('transfer-encoding');

  return forwardJson(
    new Request(request.url, { method: 'DELETE', headers, body }),
    '/account',
  );
}
