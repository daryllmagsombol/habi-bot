import { forwardJson, proxyError, safeSegment } from '../../../proxy';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ memoryId: string }>;
}

/** `POST /api/memories/:memoryId/approvals` — sets both D2 gates. */
export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const { memoryId } = await context.params;
  const segment = safeSegment(memoryId);

  return segment === undefined
    ? proxyError('not_found', 404)
    : forwardJson(request, `/memories/${segment}/approvals`);
}
