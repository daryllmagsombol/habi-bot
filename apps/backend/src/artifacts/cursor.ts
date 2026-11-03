/**
 * Opaque keyset cursors for artifact and version listing.
 *
 * Cursors carry only ordering coordinates and the exact filter that produced
 * them. They are not access keys: every query still binds the owner. A cursor
 * reused with a different conversation filter is rejected instead of silently
 * paging a different result set.
 *
 * `updatedAt` preserves PostgreSQL's microsecond text form, so rows that share
 * a millisecond cannot be skipped or duplicated by the keyset predicate.
 */
import { isUuid } from '../persistence/cursor.js';
import { PersistenceValidationError } from '../persistence/errors.js';

const ARTIFACT_CURSOR_PREFIX = 'a1.';
const VERSION_CURSOR_PREFIX = 'av1.';
const MAX_CURSOR_LENGTH = 512;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface ArtifactCursor {
  updatedAt: string;
  id: string;
  conversationId: string | null;
}

export function encodeArtifactCursor(cursor: ArtifactCursor): string {
  if (
    typeof cursor.updatedAt !== 'string' ||
    Number.isNaN(Date.parse(cursor.updatedAt)) ||
    !isUuid(cursor.id) ||
    (cursor.conversationId !== null && !isUuid(cursor.conversationId))
  ) {
    throw new PersistenceValidationError('invalid_input');
  }

  return `${ARTIFACT_CURSOR_PREFIX}${Buffer.from(
    JSON.stringify({
      u: cursor.updatedAt,
      i: cursor.id,
      c: cursor.conversationId,
    }),
    'utf8',
  ).toString('base64url')}`;
}

export function decodeArtifactCursor(cursor: string): ArtifactCursor {
  const parsed = decodeCursorJson(cursor, ARTIFACT_CURSOR_PREFIX);

  if (
    typeof parsed.u !== 'string' ||
    Number.isNaN(Date.parse(parsed.u)) ||
    typeof parsed.i !== 'string' ||
    !isUuid(parsed.i)
  ) {
    throw new PersistenceValidationError('invalid_cursor');
  }

  return {
    updatedAt: parsed.u,
    id: parsed.i,
    conversationId: readOptionalUuid(parsed.c),
  };
}

/**
 * A cursor is meaningful only for the exact filter that produced it. Reusing it
 * under another conversation filter is a malformed request, not an empty page.
 */
export function assertArtifactCursorScope(
  cursor: ArtifactCursor,
  conversationId: string | null,
): void {
  if (cursor.conversationId !== conversationId) {
    throw new PersistenceValidationError('invalid_cursor');
  }
}

export function encodeArtifactVersionCursor(version: number): string {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new PersistenceValidationError('invalid_input');
  }

  return `${VERSION_CURSOR_PREFIX}${Buffer.from(String(version), 'utf8').toString(
    'base64url',
  )}`;
}

export function decodeArtifactVersionCursor(cursor: string): number {
  if (
    typeof cursor !== 'string' ||
    cursor.length === 0 ||
    cursor.length > MAX_CURSOR_LENGTH ||
    !cursor.startsWith(VERSION_CURSOR_PREFIX)
  ) {
    throw new PersistenceValidationError('invalid_cursor');
  }

  const encoded = cursor.slice(VERSION_CURSOR_PREFIX.length);

  if (!BASE64URL_PATTERN.test(encoded)) {
    throw new PersistenceValidationError('invalid_cursor');
  }

  let decoded: string;
  try {
    decoded = Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    throw new PersistenceValidationError('invalid_cursor');
  }

  if (!/^[1-9]\d*$/.test(decoded)) {
    throw new PersistenceValidationError('invalid_cursor');
  }

  const version = Number(decoded);

  if (!Number.isSafeInteger(version)) {
    throw new PersistenceValidationError('invalid_cursor');
  }

  return version;
}

function readOptionalUuid(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (!isUuid(value)) {
    throw new PersistenceValidationError('invalid_cursor');
  }

  return value;
}

function decodeCursorJson(
  cursor: string,
  prefix: string,
): Record<string, unknown> {
  if (
    typeof cursor !== 'string' ||
    cursor.length === 0 ||
    cursor.length > MAX_CURSOR_LENGTH ||
    !cursor.startsWith(prefix)
  ) {
    throw new PersistenceValidationError('invalid_cursor');
  }

  const encoded = cursor.slice(prefix.length);

  if (!BASE64URL_PATTERN.test(encoded)) {
    throw new PersistenceValidationError('invalid_cursor');
  }

  let decoded: string;
  try {
    decoded = Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    throw new PersistenceValidationError('invalid_cursor');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    throw new PersistenceValidationError('invalid_cursor');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new PersistenceValidationError('invalid_cursor');
  }

  return parsed as Record<string, unknown>;
}
