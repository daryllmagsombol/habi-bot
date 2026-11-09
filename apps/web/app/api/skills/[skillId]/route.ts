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

/**
 * `PATCH /api/skills/:skillId` — a partial edit.
 *
 * Only the fields the caller names are forwarded; omitted fields keep their
 * stored value and the service appends a new version rather than rewriting
 * history. Archived and deleted skills answer `skill_unavailable`.
 */
export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  const { skillId } = await context.params;
  const segment = safeSegment(skillId);

  return segment === undefined
    ? proxyError('not_found', 404)
    : forwardJson(request, `/skills/${segment}`);
}
