import { forwardJson, proxyError, safeSegment, withSearch } from '../../proxy';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ artifactId: string }>;
}

async function pathFor(
  context: RouteContext,
  request: Request,
): Promise<string | undefined> {
  const { artifactId } = await context.params;
  const segment = safeSegment(artifactId);

  return segment === undefined
    ? undefined
    : withSearch(request, `/artifacts/${segment}`);
}

/** `GET /api/artifacts/:artifactId` — nested `{ artifact: { artifact, version } }`. */
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const path = await pathFor(context, request);

  return path === undefined ? proxyError('not_found', 404) : forwardJson(request, path);
}

/** `PATCH /api/artifacts/:artifactId` — appends a version. */
export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  const { artifactId } = await context.params;
  const segment = safeSegment(artifactId);

  return segment === undefined
    ? proxyError('not_found', 404)
    : forwardJson(request, `/artifacts/${segment}`);
}
