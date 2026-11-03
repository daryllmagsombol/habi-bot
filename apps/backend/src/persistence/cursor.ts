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
  return writeCursor(MESSAGE_CURSOR_PREFIX, seq);
}

/** Decodes a message cursor, rejecting anything that is not a positive integer. */
export function decodeMessageCursor(cursor: string): number {
  const rawSeq = readCursorPayload(cursor, MESSAGE_CURSOR_PREFIX);

  if (!/^[1-9]\d*$/.test(rawSeq)) {
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

/** Writes an opaque base64url cursor; the payload is a hint, never an access key. */
export function writeCursor(prefix: string, payload: unknown): string {
  return Buffer.from(`${prefix}${JSON.stringify(payload)}`, 'utf8').toString(
    'base64url',
  );
}

/** Strips the prefix from an opaque cursor, rejecting unreadable input. */
export function readCursorPayload(cursor: string, prefix: string): string {
  const decoded = decodeBase64Url(cursor);

  if (!decoded?.startsWith(prefix)) {
    throw new PersistenceValidationError('invalid_cursor');
  }

  return decoded.slice(prefix.length);
}

/**
 * Reads the `{u,i}` keyset payload shared by `(updated_at DESC, id DESC)`
 * listings. The timestamp text is returned unchanged; callers decide whether to
 * round-trip it through `Date`.
 */
export function readTimestampIdCursor(payload: string): ConversationCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new PersistenceValidationError('invalid_cursor');
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new PersistenceValidationError('invalid_cursor');
  }

  const { u, i } = parsed as Record<string, unknown>;
  if (
    typeof u !== 'string' ||
    typeof i !== 'string' ||
    !isUuid(i) ||
    Number.isNaN(Date.parse(u))
  ) {
    throw new PersistenceValidationError('invalid_cursor');
  }

  return { updatedAt: u, id: i };
}

/** Opaque keyset cursor for `(updated_at DESC, id DESC)` conversation listing. */
export function encodeConversationCursor(cursor: ConversationCursor): string {
  return writeCursor('', { u: cursor.updatedAt, i: cursor.id });
}

export function decodeConversationCursor(cursor: string): ConversationCursor {
  const parsed = readTimestampIdCursor(readCursorPayload(cursor, ''));

  return { updatedAt: new Date(parsed.updatedAt).toISOString(), id: parsed.id };
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
