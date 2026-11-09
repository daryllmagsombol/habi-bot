import { forwardText, proxyError, safeSegment } from '../../../proxy';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ attachmentId: string }>;
}

/**
 * `GET /api/attachments/:attachmentId/content` — raw `text/plain` or
 * `text/markdown`. Without attachment storage the API answers
 * `503 api_unavailable`, which is relayed as the shared JSON envelope.
 */
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { attachmentId } = await context.params;
  const segment = safeSegment(attachmentId);

  return segment === undefined
    ? proxyError('not_found', 404)
    : forwardText(request, `/attachments/${segment}/content`);
}
