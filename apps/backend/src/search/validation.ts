/**
 * Bounded, non-enumerating input rules for message and conversation search.
 *
 * The query never reaches `to_tsquery`; it is always bound as a parameter and
 * parsed by `websearch_to_tsquery`, which accepts arbitrary user text (quoted
 * phrases, `or`, `-term`) without raising syntax errors. Malformed query shape
 * is reported as `invalid_input`, and a query with no searchable lexeme (only
 * punctuation or stop words) is treated the same way instead of silently
 * returning an empty page.
 */
import { createHash } from 'node:crypto';
import type { Queryable } from '../persistence/database.js';
import { isUuid } from '../persistence/cursor.js';
import { PersistenceValidationError } from '../persistence/errors.js';

export const MIN_SEARCH_QUERY_LENGTH = 2;
export const MAX_SEARCH_QUERY_LENGTH = 200;
export const DEFAULT_SEARCH_LIMIT = 20;
/** Hard ceiling for one search page; callers may ask for more and get 50. */
export const MAX_SEARCH_LIMIT = 50;

const MAX_CURSOR_LENGTH = 512;
const MESSAGE_CURSOR_PREFIX = 's1.';
const CONVERSATION_CURSOR_PREFIX = 'sc1.';
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface NormalizedSearchQuery {
  /** Trimmed, whitespace-collapsed text; safe to bind as one parameter. */
  text: string;
  /** Stable digest binding a cursor to the query that produced it. */
  fingerprint: string;
}

/**
 * Replaces C0/C1 control characters with spaces so a pasted query cannot carry
 * NUL or terminal escapes into PostgreSQL or logs. Tab, LF, and CR stay and are
 * later collapsed as whitespace.
 */
function stripControlCharacters(value: string): string {
  let sanitized = '';

  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    const isWhitespaceControl = code === 0x09 || code === 0x0a || code === 0x0d;
    const isControl =
      (code < 0x20 && !isWhitespaceControl) || (code >= 0x7f && code <= 0x9f);

    sanitized += isControl ? ' ' : character;
  }

  return sanitized;
}

export function normalizeSearchQuery(value: unknown): NormalizedSearchQuery {
  if (typeof value !== 'string') {
    throw new PersistenceValidationError('invalid_input');
  }

  const text = stripControlCharacters(value).replaceAll(/\s+/g, ' ').trim();

  if (text.length < MIN_SEARCH_QUERY_LENGTH || text.length > MAX_SEARCH_QUERY_LENGTH) {
    throw new PersistenceValidationError('invalid_input');
  }

  return {
    text,
    fingerprint: createHash('sha256').update(text, 'utf8').digest('hex'),
  };
}

/**
 * The query is safe to bind, but PostgreSQL may still reduce it to an empty
 * tsquery (for example `!!!` or `the`). That is a malformed search request, not
 * a legitimate empty result set, so it fails closed as `invalid_input`.
 */
export async function assertSearchableQuery(
  queryable: Queryable,
  query: NormalizedSearchQuery,
): Promise<void> {
  const result = await queryable.query<{ nodes: number }>(
    `SELECT numnode(websearch_to_tsquery('english'::regconfig, $1::text))::int AS nodes`,
    [query.text],
  );
  const nodes = result.rows[0]?.nodes;

  if (typeof nodes !== 'number' || nodes < 1) {
    throw new PersistenceValidationError('invalid_input');
  }
}

export function normalizeSearchLimit(limit: unknown): number {
  if (limit === undefined) {
    return DEFAULT_SEARCH_LIMIT;
  }

  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) {
    throw new PersistenceValidationError('invalid_input');
  }

  return Math.min(limit, MAX_SEARCH_LIMIT);
}

/**
 * Normalizes an optional scope id. A syntactically invalid id is the same
 * non-enumerating not-found used elsewhere; a well-formed id that is foreign or
 * missing simply matches no owned row, so it yields an empty page rather than
 * a distinguishing error.
 */
export function normalizeScopeId(value: unknown): string | null {
  if (value === undefined) {
    return null;
  }

  if (!isUuid(value)) {
    throw new PersistenceValidationError('invalid_input');
  }

  return value;
}

export interface MessageSearchCursor {
  /** Relevance score of the last returned row. */
  score: number;
  /** PostgreSQL `created_at` text, preserving microseconds for exact keyset. */
  createdAt: string;
  /** Message id of the last returned row. */
  id: string;
  fingerprint: string;
  conversationId: string | null;
  botId: string | null;
}

export interface ConversationSearchCursor {
  /** PostgreSQL `max(created_at)` text, preserving microseconds. */
  latestMatchAt: string;
  conversationId: string;
  fingerprint: string;
  conversationIdFilter: string | null;
  botIdFilter: string | null;
}

export function encodeMessageSearchCursor(cursor: MessageSearchCursor): string {
  if (!isUuid(cursor.id) || !Number.isFinite(cursor.score) || cursor.score < 0) {
    throw new PersistenceValidationError('invalid_input');
  }

  return `${MESSAGE_CURSOR_PREFIX}${Buffer.from(
    JSON.stringify({
      s: cursor.score,
      t: cursor.createdAt,
      i: cursor.id,
      q: cursor.fingerprint,
      c: cursor.conversationId,
      b: cursor.botId,
    }),
    'utf8',
  ).toString('base64url')}`;
}

export function decodeMessageSearchCursor(cursor: string): MessageSearchCursor {
  const parsed = decodeCursorJson(cursor, MESSAGE_CURSOR_PREFIX);

  if (
    typeof parsed.s !== 'number' ||
    !Number.isFinite(parsed.s) ||
    parsed.s < 0 ||
    typeof parsed.t !== 'string' ||
    Number.isNaN(Date.parse(parsed.t)) ||
    typeof parsed.i !== 'string' ||
    !isUuid(parsed.i) ||
    typeof parsed.q !== 'string' ||
    !FINGERPRINT_PATTERN.test(parsed.q)
  ) {
    throw new PersistenceValidationError('invalid_cursor');
  }

  return {
    score: parsed.s,
    createdAt: parsed.t,
    id: parsed.i,
    fingerprint: parsed.q,
    conversationId: readOptionalUuid(parsed.c),
    botId: readOptionalUuid(parsed.b),
  };
}

/**
 * A cursor is an ordering hint for one exact query and scope. Reusing it with a
 * different query or filter would resume at a position that has no meaning for
 * the new result set, so it is rejected rather than silently mis-paged.
 */
export function assertMessageCursorScope(
  cursor: MessageSearchCursor,
  expected: {
    fingerprint: string;
    conversationId: string | null;
    botId: string | null;
  },
): void {
  if (
    cursor.fingerprint !== expected.fingerprint ||
    cursor.conversationId !== expected.conversationId ||
    cursor.botId !== expected.botId
  ) {
    throw new PersistenceValidationError('invalid_cursor');
  }
}

export function encodeConversationSearchCursor(cursor: ConversationSearchCursor): string {
  if (!isUuid(cursor.conversationId)) {
    throw new PersistenceValidationError('invalid_input');
  }

  return `${CONVERSATION_CURSOR_PREFIX}${Buffer.from(
    JSON.stringify({
      t: cursor.latestMatchAt,
      i: cursor.conversationId,
      q: cursor.fingerprint,
      c: cursor.conversationIdFilter,
      b: cursor.botIdFilter,
    }),
    'utf8',
  ).toString('base64url')}`;
}

export function decodeConversationSearchCursor(cursor: string): ConversationSearchCursor {
  const parsed = decodeCursorJson(cursor, CONVERSATION_CURSOR_PREFIX);

  if (
    typeof parsed.t !== 'string' ||
    Number.isNaN(Date.parse(parsed.t)) ||
    typeof parsed.i !== 'string' ||
    !isUuid(parsed.i) ||
    typeof parsed.q !== 'string' ||
    !FINGERPRINT_PATTERN.test(parsed.q)
  ) {
    throw new PersistenceValidationError('invalid_cursor');
  }

  return {
    latestMatchAt: parsed.t,
    conversationId: parsed.i,
    fingerprint: parsed.q,
    conversationIdFilter: readOptionalUuid(parsed.c),
    botIdFilter: readOptionalUuid(parsed.b),
  };
}

export function assertConversationCursorScope(
  cursor: ConversationSearchCursor,
  expected: {
    fingerprint: string;
    conversationId: string | null;
    botId: string | null;
  },
): void {
  if (
    cursor.fingerprint !== expected.fingerprint ||
    cursor.conversationIdFilter !== expected.conversationId ||
    cursor.botIdFilter !== expected.botId
  ) {
    throw new PersistenceValidationError('invalid_cursor');
  }
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
