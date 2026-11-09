import { forwardJson, proxyError, safeSegment } from '../../proxy';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ threadId: string }>;
}

/**
 * `PATCH /api/threads/:threadId` — the title is required by the contract, so a
 * request that omits it is forwarded and answered `400 invalid_input`.
 */
export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  const { threadId } = await context.params;
  const segment = safeSegment(threadId);

  return segment === undefined
    ? proxyError('not_found', 404)
    : forwardJson(request, `/threads/${segment}`);
}

/** `DELETE /api/threads/:threadId` — tombstones the thread; repeat is idempotent. */
export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  const { threadId } = await context.params;
  const segment = safeSegment(threadId);

  return segment === undefined
    ? proxyError('not_found', 404)
    : forwardJson(request, `/threads/${segment}`);
}
