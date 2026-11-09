import { forwardJson, withSearch } from '../proxy';

export const dynamic = 'force-dynamic';

/** `GET /api/skills` — owner-scoped page, optionally filtered by Bot/status. */
export function GET(request: Request): Promise<Response> {
  return forwardJson(request, withSearch(request, '/skills'));
}

/** `POST /api/skills` — 201 with one skill. */
export function POST(request: Request): Promise<Response> {
  return forwardJson(request, '/skills');
}
