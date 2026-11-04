import { forwardJson, proxyError, safeSegment, withSearch } from '../../../proxy';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ threadId: string }>;
}

function pathFor(threadId: string, request: Request): string | undefined {
  const segment = safeSegment(threadId);

  return segment === undefined ? undefined : withSearch(request, `/threads/${segment}/messages`);
}

/** `GET /api/threads/:threadId/messages` — the persisted transcript page. */
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { threadId } = await context.params;
  const path = pathFor(threadId, request);

  if (path === undefined) {
    return proxyError('not_found', 404);
  }

  return forwardJson(request, path);
}

/**
 * `POST /api/threads/:threadId/messages` — persists the message and reserves a
 * Run. The CSRF token and Origin are forwarded by the proxy; the H-017 guard
 * still makes the decision.
 */
export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const { threadId } = await context.params;
  const segment = safeSegment(threadId);

  if (segment === undefined) {
    return proxyError('not_found', 404);
  }

  return forwardJson(request, `/threads/${segment}/messages`);
}
