import type {
  Conversation,
  ConversationStatus,
  Message,
  MessageRole,
  MessageStatus,
} from '@habi/contracts';
import type { Queryable } from './database.js';
import { PersistenceNotFoundError } from './errors.js';
import { isUuid } from './cursor.js';

export interface ConversationRow {
  id: string;
  bot_id: string;
  title: string;
  status: ConversationStatus;
  last_message_seq: string;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface ConversationStateRow extends ConversationRow {
  deleted_at: Date | string | null;
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
  created_at: Date | string;
  finalized_at: Date | string | null;
  deleted_at: Date | string | null;
}

export const CONVERSATION_COLUMNS =
  'id, bot_id, title, status, last_message_seq, created_at, updated_at';

export const MESSAGE_COLUMNS = `m.id, m.conversation_id, m.owner_user_id, m.role,
  m.content, m.seq, m.status, m.client_message_id, m.run_id, m.created_at,
  m.finalized_at, m.deleted_at`;

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toNullableIso(value: Date | string | null): string | null {
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

export interface LoadConversationOptions {
  includeDeleted?: boolean;
  forUpdate?: boolean;
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

/**
 * Loads a conversation through the owner predicate itself. A missing row and a
 * row owned by someone else produce the same not-found error.
 */
export async function loadOwnedConversation(
  queryable: Queryable,
  actorUserId: string,
  conversationId: string,
  options: LoadConversationOptions = {},
): Promise<ConversationStateRow> {
  const ownerUserId = requireActorUserId(actorUserId);
  const ownedConversationId = requireResourceId(conversationId);

  // Four complete statements rather than interpolated clauses keep every query
  // string static; only ids and filters travel as bound parameters.
  let sql: string;
  if (options.includeDeleted === true && options.forUpdate === true) {
    sql = `${CONVERSATION_SELECT_WITH_DELETED} FOR UPDATE`;
  } else if (options.includeDeleted === true) {
    sql = CONVERSATION_SELECT_WITH_DELETED;
  } else if (options.forUpdate === true) {
    sql = `${CONVERSATION_SELECT} FOR UPDATE`;
  } else {
    sql = CONVERSATION_SELECT;
  }

  const result = await queryable.query<ConversationStateRow>(sql, [
    ownedConversationId,
    ownerUserId,
  ]);

  const row = result.rows[0];
  if (row === undefined) {
    throw new PersistenceNotFoundError();
  }

  return row;
}
