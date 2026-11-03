import {
  readCursorPayload,
  readTimestampIdCursor,
  writeCursor,
} from '../persistence/cursor.js';
import type { SkillCursor } from './types.js';

const CURSOR_PREFIX = 'sk:';

/** Opaque keyset cursor for owner-scoped `(updated_at DESC, id DESC)` listing. */
export function encodeSkillCursor(cursor: SkillCursor): string {
  return writeCursor(CURSOR_PREFIX, { u: cursor.updatedAt, i: cursor.id });
}

/** Rejects malformed cursors; a cursor is an ordering hint, never an access key. */
export function decodeSkillCursor(cursor: string): SkillCursor {
  const parsed = readTimestampIdCursor(readCursorPayload(cursor, CURSOR_PREFIX));

  // Keep the server-rendered timestamp text instead of round-tripping through
  // `Date`, which would truncate PostgreSQL microseconds and skip same-ms rows.
  return { updatedAt: parsed.updatedAt, id: parsed.id };
}
