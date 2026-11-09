import { forwardJson, proxyError, safeSegment } from '../../proxy';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ skillId: string }>;
}

/** `GET /api/skills/:skillId` — one owned skill. */
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { skillId } = await context.params;
  const segment = safeSegment(skillId);

  return segment === undefined
    ? proxyError('not_found', 404)
    : forwardJson(request, `/skills/${segment}`);
}
