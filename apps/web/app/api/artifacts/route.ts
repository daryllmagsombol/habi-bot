import { forwardJson, withSearch } from '../proxy';

export const dynamic = 'force-dynamic';

/** `GET /api/artifacts` → flat metadata page, optionally scoped to a thread. */
export function GET(request: Request): Promise<Response> {
  return forwardJson(request, withSearch(request, '/artifacts'));
}

/** `POST /api/artifacts` → 201 with one artifact and its version-1 body. */
export function POST(request: Request): Promise<Response> {
  return forwardJson(request, '/artifacts');
}
