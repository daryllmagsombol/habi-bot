import { singleResourceHandler } from '../../proxy';

export const dynamic = 'force-dynamic';

/**
 * `GET /api/skills/:skillId` → `GET {HABI_API_URL}/api/skills/:skillId`.
 *
 * One owned skill. Unknown, foreign, malformed and tombstoned ids share the
 * same `404 not_found`, so the route cannot be used to enumerate.
 */
export const GET = singleResourceHandler('skillId', 'skills', false);

/**
 * `PATCH /api/skills/:skillId` — a partial edit.
 *
 * Only the fields the caller names are forwarded; omitted fields keep their
 * stored value and the service appends a new version rather than rewriting
 * history. Archived and deleted skills answer `skill_unavailable`.
 */
export const PATCH = singleResourceHandler('skillId', 'skills', false);
