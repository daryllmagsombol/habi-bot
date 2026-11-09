import { forwardJson, withSearch } from '../proxy';

export const dynamic = 'force-dynamic';

/** `GET /api/search?q&botId&limit&cursor` — owner-scoped message search. */
export function GET(request: Request): Promise<Response> {
  return forwardJson(request, withSearch(request, '/search'));
}
