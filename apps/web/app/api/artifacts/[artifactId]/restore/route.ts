import { forwardJson, proxyError, safeSegment } from '../../../proxy';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ artifactId: string }>;
}

/** `POST /api/artifacts/:artifactId/restore` — appends the named version. */
export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const { artifactId } = await context.params;
  const segment = safeSegment(artifactId);

  return segment === undefined
    ? proxyError('not_found', 404)
    : forwardJson(request, `/artifacts/${segment}/restore`);
}
