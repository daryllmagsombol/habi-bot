import { forwardJson, proxyError, safeSegment } from '../../../proxy';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ skillId: string }>;
}

/** `POST /api/skills/:skillId/attach` — `{ botId }`. */
export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const { skillId } = await context.params;
  const segment = safeSegment(skillId);

  return segment === undefined
    ? proxyError('not_found', 404)
    : forwardJson(request, `/skills/${segment}/attach`);
}
