import { forwardJson, withSearch } from '../proxy';

export const dynamic = 'force-dynamic';

/** `GET /api/bots` → `GET {HABI_API_URL}/api/bots`. */
export function GET(request: Request): Promise<Response> {
  return forwardJson(request, withSearch(request, '/bots'));
}
