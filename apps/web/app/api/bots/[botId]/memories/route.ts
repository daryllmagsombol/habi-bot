import { forwardJson, proxyError, safeSegment, withSearch } from '../../../proxy';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ botId: string }>;
}

/** `GET /api/bots/:botId/memories` — opaque offset-derived cursor. */
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { botId } = await context.params;
  const segment = safeSegment(botId);

  if (segment === undefined) {
    return proxyError('not_found', 404);
  }

  return forwardJson(request, withSearch(request, `/bots/${segment}/memories`));
}

/** `POST /api/bots/:botId/memories` — `{ text, threadId }`, threadId required. */
export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const { botId } = await context.params;
  const segment = safeSegment(botId);

  if (segment === undefined) {
    return proxyError('not_found', 404);
  }

  return forwardJson(request, `/bots/${segment}/memories`);
}
