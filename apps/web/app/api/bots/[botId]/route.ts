import { forwardJson, proxyError, safeSegment, withSearch } from '../../proxy';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ botId: string }>;
}

async function pathFor(
  context: RouteContext,
  request: Request,
): Promise<string | undefined> {
  const { botId } = await context.params;
  const segment = safeSegment(botId);

  return segment === undefined ? undefined : withSearch(request, `/bots/${segment}`);
}

/** `GET /api/bots/:botId` → `GET {HABI_API_URL}/api/bots/:botId`. */
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const path = await pathFor(context, request);

  return path === undefined ? proxyError('not_found', 404) : forwardJson(request, path);
}

/** `PATCH /api/bots/:botId` — name, description and instructions only. */
export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  const { botId } = await context.params;
  const segment = safeSegment(botId);

  return segment === undefined
    ? proxyError('not_found', 404)
    : forwardJson(request, `/bots/${segment}`);
}

/** `DELETE /api/bots/:botId` — archives the Bot; repeating it is idempotent. */
export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  const { botId } = await context.params;
  const segment = safeSegment(botId);

  return segment === undefined
    ? proxyError('not_found', 404)
    : forwardJson(request, `/bots/${segment}`);
}
