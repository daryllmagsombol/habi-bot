import { forwardStream, proxyError, safeSegment } from '../../../proxy';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ runId: string }>;
}

/**
 * `GET /api/runs/:runId/events` — SSE pass-through.
 *
 * Body frames, `id:` cursors, and the `Last-Event-ID` request header are
 * relayed untouched, so a reconnect asks the Run's own event log for the next
 * sequence instead of restarting the transcript.
 */
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { runId } = await context.params;
  const segment = safeSegment(runId);

  if (segment === undefined) {
    return proxyError('not_found', 404);
  }

  return forwardStream(request, `/runs/${segment}/events`);
}
