import { PersistenceValidationError } from '../persistence/errors.js';
import { isUuid } from '../persistence/cursor.js';
import type { SkillCursor } from './types.js';

const CURSOR_PREFIX = 'sk:';

/** Opaque keyset cursor for owner-scoped `(updated_at DESC, id DESC)` listing. */
export function encodeSkillCursor(cursor: SkillCursor): string {
  return Buffer.from(
    `${CURSOR_PREFIX}${JSON.stringify({ u: cursor.updatedAt, i: cursor.id })}`,
    'utf8',
  ).toString('base64url');
}

/** Rejects malformed cursors; a cursor is an ordering hint, never an access key. */
export function decodeSkillCursor(cursor: string): SkillCursor {
  const decoded = decodeBase64Url(cursor);

  if (!decoded?.startsWith(CURSOR_PREFIX)) {
    throw new PersistenceValidationError('invalid_cursor');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded.slice(CURSOR_PREFIX.length));
  } catch {
    throw new PersistenceValidationError('invalid_cursor');
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('u' in parsed) ||
    !('i' in parsed) ||
    typeof parsed.u !== 'string' ||
    typeof parsed.i !== 'string' ||
    !isUuid(parsed.i) ||
    Number.isNaN(Date.parse(parsed.u))
  ) {
    throw new PersistenceValidationError('invalid_cursor');
  }

  // Keep the server-rendered timestamp text instead of round-tripping through
  // `Date`, which would truncate PostgreSQL microseconds and skip same-ms rows.
  return { updatedAt: parsed.u, id: parsed.i };
}

function decodeBase64Url(value: string): string | null {
  if (typeof value !== 'string' || value.length === 0 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    return null;
  }

  try {
    return Buffer.from(value, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}
