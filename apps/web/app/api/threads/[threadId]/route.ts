import { singleResourceHandler } from '../../proxy';

export const dynamic = 'force-dynamic';

/**
 * `PATCH /api/threads/:threadId` — the title is required by the contract, so a
 * request that omits it is forwarded and answered `400 invalid_input`.
 */
export const PATCH = singleResourceHandler('threadId', 'threads', false);

/** `DELETE /api/threads/:threadId` — tombstones the thread; repeat is idempotent. */
export const DELETE = singleResourceHandler('threadId', 'threads', false);
