import { singleResourceHandler } from '../../proxy';

export const dynamic = 'force-dynamic';

/** `GET /api/bots/:botId` → `GET {HABI_API_URL}/api/bots/:botId`. */
export const GET = singleResourceHandler('botId', 'bots', true);

/** `PATCH /api/bots/:botId` — name, description and instructions only. */
export const PATCH = singleResourceHandler('botId', 'bots', false);

/** `DELETE /api/bots/:botId` — archives the Bot; repeating it is idempotent. */
export const DELETE = singleResourceHandler('botId', 'bots', false);
