import type {
  Conversation,
  ConversationStatus,
  Message,
  MessageRole,
  MessageStatus,
} from '@habi/contracts';
import type { QueryResultRow } from 'pg';
import type { Queryable } from './database.js';
import { PersistenceNotFoundError } from './errors.js';
import { isUuid } from './cursor.js';

/** PostgreSQL returns `timestamptz` as a `Date`; text casts may arrive as a string. */
export type Timestamp = Date | string;
export type NullableTimestamp = Timestamp | null;

export interface ConversationRow {
  id: string;
  bot_id: string;
  title: string;
  status: ConversationStatus;
  last_message_seq: string;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ConversationStateRow extends ConversationRow {
  deleted_at: NullableTimestamp;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  owner_user_id: string;
  role: MessageRole;
  content: string;
  seq: string;
  status: MessageStatus;
  client_message_id: string | null;
  run_id: string | null;
  created_at: Timestamp;
  finalized_at: NullableTimestamp;
  deleted_at: NullableTimestamp;
}

export const CONVERSATION_COLUMNS =
  'id, bot_id, title, status, last_message_seq, created_at, updated_at';

export const MESSAGE_COLUMNS = `m.id, m.conversation_id, m.owner_user_id, m.role,
  m.content, m.seq, m.status, m.client_message_id, m.run_id, m.created_at,
  m.finalized_at, m.deleted_at`;

export function toIso(value: Timestamp): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function toNullableIso(value: NullableTimestamp): string | null {
  return value === null ? null : toIso(value);
}

function toSequence(value: string | number): number {
  const seq = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(seq) || seq < 0) {
    throw new TypeError('Persisted sequence is outside the supported integer range.');
  }
  return seq;
}

export function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    botId: row.bot_id,
    title: row.title,
    status: row.status,
    lastMessageSeq: toSequence(row.last_message_seq),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    seq: toSequence(row.seq),
    status: row.status,
    clientMessageId: row.client_message_id,
    createdAt: toIso(row.created_at),
    finalizedAt: toNullableIso(row.finalized_at),
  };
}

/**
 * Fails closed on a blank or non-UUID actor id rather than letting a type error
 * from PostgreSQL distinguish malformed input. The returned value is safe to
 * bind to an owner predicate.
 */
export function requireActorUserId(actorUserId: string): string {
  if (!isUuid(actorUserId)) {
    throw new PersistenceNotFoundError();
  }
  return actorUserId;
}

export function requireResourceId(resourceId: string): string {
  if (!isUuid(resourceId)) {
    throw new PersistenceNotFoundError();
  }
  return resourceId;
}

/**
 * Returns the first row of a write or read that must affect exactly one owned
 * row. A statement that matched nothing is the same non-enumerating not-found
 * for a missing, foreign, or tombstoned id.
 */
export function requireRow<T>(result: { readonly rows: readonly T[] }): T {
  const row = result.rows[0];
  if (row === undefined) {
    throw new PersistenceNotFoundError();
  }
  return row;
}

export interface ScopedLoadOptions {
  /** Also match a row whose `deleted_at` is set; ownership still applies. */
  includeDeleted?: boolean;
  /** Take the row lock for the surrounding transaction. */
  forUpdate?: boolean;
}

export interface OwnedRowStatements {
  /** Statement for a live row; the row id and actor bind to `$1` and `$2`. */
  live: string;
  /** Statement that also returns a tombstoned row. */
  withDeleted: string;
  /** Lock clause for `forUpdate`, e.g. `FOR UPDATE OF a` when the row is joined. */
  lock?: string;
}

/**
 * Picks one of the caller's complete statements for the requested scope and
 * appends the lock clause. Statements stay static, so only ids and filters
 * travel as bound parameters.
 */
export function scopedStatement(
  live: string,
  withDeleted: string,
  options: ScopedLoadOptions,
  lock = 'FOR UPDATE',
): string {
  const statement = options.includeDeleted === true ? withDeleted : live;
  return options.forUpdate === true ? `${statement} ${lock}` : statement;
}

/**
 * Loads one row through the owner predicate itself. A missing row and a row
 * owned by someone else produce the same not-found error.
 */
export async function loadOwnedRow<T extends QueryResultRow>(
  queryable: Queryable,
  actorUserId: string,
  resourceId: string,
  statements: OwnedRowStatements,
  options: ScopedLoadOptions = {},
): Promise<T> {
  const ownerUserId = requireActorUserId(actorUserId);
  const ownedResourceId = requireResourceId(resourceId);
  const sql = scopedStatement(
    statements.live,
    statements.withDeleted,
    options,
    statements.lock,
  );

  return requireRow(
    await queryable.query<T>(sql, [ownedResourceId, ownerUserId]),
  );
}

const CONVERSATION_SELECT = `SELECT ${CONVERSATION_COLUMNS}, deleted_at
   FROM conversations
  WHERE id = $1
    AND owner_user_id = $2
    AND deleted_at IS NULL`;

const CONVERSATION_SELECT_WITH_DELETED = `SELECT ${CONVERSATION_COLUMNS}, deleted_at
   FROM conversations
  WHERE id = $1
    AND owner_user_id = $2`;

const CONVERSATION_STATEMENTS: OwnedRowStatements = {
  live: CONVERSATION_SELECT,
  withDeleted: CONVERSATION_SELECT_WITH_DELETED,
};

export async function loadOwnedConversation(
  queryable: Queryable,
  actorUserId: string,
  conversationId: string,
  options: ScopedLoadOptions = {},
): Promise<ConversationStateRow> {
  return loadOwnedRow<ConversationStateRow>(
    queryable,
    actorUserId,
    conversationId,
    CONVERSATION_STATEMENTS,
    options,
  );
}
