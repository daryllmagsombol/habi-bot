import { forwardJson, proxyError, safeSegment } from '../../proxy';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ attachmentId: string }>;
}

/** `GET /api/attachments/:attachmentId` — metadata for one attachment. */
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { attachmentId } = await context.params;
  const segment = safeSegment(attachmentId);

  return segment === undefined
    ? proxyError('not_found', 404)
    : forwardJson(request, `/attachments/${segment}`);
}
