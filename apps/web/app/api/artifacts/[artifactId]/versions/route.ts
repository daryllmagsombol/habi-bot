import { forwardJson, proxyError, safeSegment, withSearch } from '../../../proxy';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ artifactId: string }>;
}

/** `GET /api/artifacts/:artifactId/versions` — metadata only. */
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { artifactId } = await context.params;
  const segment = safeSegment(artifactId);

  if (segment === undefined) {
    return proxyError('not_found', 404);
  }

  return forwardJson(
    request,
    withSearch(request, `/artifacts/${segment}/versions`),
  );
}
