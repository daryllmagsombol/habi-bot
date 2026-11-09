import { forwardJson, proxyError, safeSegment, withSearch } from '../../../proxy';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ threadId: string }>;
}

/** `GET /api/threads/:threadId/attachments` — metadata only, one page. */
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { threadId } = await context.params;
  const segment = safeSegment(threadId);

  if (segment === undefined) {
    return proxyError('not_found', 404);
  }

  return forwardJson(
    request,
    withSearch(request, `/threads/${segment}/attachments`),
  );
}
