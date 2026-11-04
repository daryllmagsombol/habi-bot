import { forwardJson, proxyError, safeSegment } from '../../../proxy';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ runId: string }>;
}

/** `POST /api/runs/:runId/cancel` — owner-scoped, idempotent local cancel. */
export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const { runId } = await context.params;
  const segment = safeSegment(runId);

  if (segment === undefined) {
    return proxyError('not_found', 404);
  }

  return forwardJson(request, `/runs/${segment}/cancel`);
}
