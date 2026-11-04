import { forwardJson, proxyError, safeSegment, withSearch } from '../../../proxy';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ botId: string }>;
}

/** `GET /api/bots/:botId/threads` → the owner-scoped thread page. */
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { botId } = await context.params;
  const segment = safeSegment(botId);

  if (segment === undefined) {
    return proxyError('not_found', 404);
  }

  return forwardJson(request, withSearch(request, `/bots/${segment}/threads`));
}
