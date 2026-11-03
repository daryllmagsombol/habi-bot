import { PersistenceValidationError } from './errors.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MESSAGE_CURSOR_PREFIX = 'm:';

/** True only for canonical UUID text. Used to fail closed before a DB cast. */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** Opaque cursor for a message `seq`; the value itself is not an access key. */
export function encodeMessageCursor(seq: number): string {
  return Buffer.from(`${MESSAGE_CURSOR_PREFIX}${seq}`, 'utf8').toString('base64url');
}

/** Decodes a message cursor, rejecting anything that is not a positive integer. */
export function decodeMessageCursor(cursor: string): number {
  const decoded = decodeBase64Url(cursor);

  if (decoded === null || !decoded.startsWith(MESSAGE_CURSOR_PREFIX)) {
    throw new PersistenceValidationError('invalid_cursor');
  }

  const rawSeq = decoded.slice(MESSAGE_CURSOR_PREFIX.length);
  if (!/^[1-9][0-9]*$/.test(rawSeq)) {
    throw new PersistenceValidationError('invalid_cursor');
  }

  const seq = Number(rawSeq);
  if (!Number.isSafeInteger(seq)) {
    throw new PersistenceValidationError('invalid_cursor');
  }

  return seq;
}

export interface ConversationCursor {
  updatedAt: string;
  id: string;
}

/** Opaque keyset cursor for `(updated_at DESC, id DESC)` conversation listing. */
export function encodeConversationCursor(cursor: ConversationCursor): string {
  return Buffer.from(
    JSON.stringify({ u: cursor.updatedAt, i: cursor.id }),
    'utf8',
  ).toString('base64url');
}

export function decodeConversationCursor(cursor: string): ConversationCursor {
  const decoded = decodeBase64Url(cursor);

  if (decoded === null) {
    throw new PersistenceValidationError('invalid_cursor');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
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

  return { updatedAt: new Date(parsed.u).toISOString(), id: parsed.i };
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
