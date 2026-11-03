import type { Message, MessagePage } from '@habi/contracts';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { withTransaction } from './database.js';
import { decodeMessageCursor, encodeMessageCursor, isUuid } from './cursor.js';
import {
  isUniqueViolation,
  PersistenceConflictError,
  PersistenceNotFoundError,
  PersistenceValidationError,
  uniqueViolationConstraint,
} from './errors.js';
import { normalizeLimit } from './pagination.js';
import {
  loadOwnedConversation,
  MESSAGE_COLUMNS,
  requireActorUserId,
  requireResourceId,
  toMessage,
  type MessageRow,
} from './rows.js';
import type { AppendMessageInput, ListMessagesOptions } from './types.js';

interface ConversationLockRow {
  id: string;
  status: 'active' | 'archived' | 'deleted';
}

const MESSAGES_FORWARD = `SELECT ${MESSAGE_COLUMNS}
   FROM messages m
   JOIN conversations c ON c.id = m.conversation_id
  WHERE m.conversation_id = $1
    AND c.owner_user_id = $2
    AND c.deleted_at IS NULL
    AND m.deleted_at IS NULL
    AND m.status <> 'deleted'
    AND ($3::bigint IS NULL OR m.seq > $3)
  ORDER BY m.seq ASC
  LIMIT $4`;

const MESSAGES_BACKWARD = `SELECT ${MESSAGE_COLUMNS}
   FROM messages m
   JOIN conversations c ON c.id = m.conversation_id
  WHERE m.conversation_id = $1
    AND c.owner_user_id = $2
    AND c.deleted_at IS NULL
    AND m.deleted_at IS NULL
    AND m.status <> 'deleted'
    AND m.seq < $3
  ORDER BY m.seq DESC
  LIMIT $4`;

const MESSAGE_BY_ID = `SELECT ${MESSAGE_COLUMNS}
   FROM messages m
   JOIN conversations c ON c.id = m.conversation_id
  WHERE m.id = $1
    AND m.conversation_id = $2
    AND c.owner_user_id = $3
    AND c.deleted_at IS NULL
    AND m.deleted_at IS NULL
    AND m.status <> 'deleted'`;

const EXISTING_CLIENT_MESSAGE = `SELECT ${MESSAGE_COLUMNS}
   FROM messages m
  WHERE m.conversation_id = $1
    AND m.owner_user_id = $2
    AND m.client_message_id = $3`;

/**
 * Owner- and conversation-scoped message persistence. Sequence allocation
 * locks the conversation row, so concurrent appends serialize and cannot
 * duplicate or skip a `seq`.
 */
export class MessageRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * Appends one final message. A repeated `clientMessageId` with the same
   * role/content returns the original row without allocating a new sequence;
   * a different payload is a conflict. Tombstoned messages are never
   * resurrected, and a deleted conversation is not found.
   */
  async append(actorUserId: string, input: AppendMessageInput): Promise<Message> {
    const ownerUserId = requireActorUserId(actorUserId);
    const conversationId = requireResourceId(input.conversationId);

    if (input.role !== 'user' && input.role !== 'assistant') {
      throw new PersistenceValidationError('invalid_input');
    }
    if (typeof input.content !== 'string' || input.content.length === 0) {
      throw new PersistenceValidationError('invalid_input');
    }

    const clientMessageId = input.clientMessageId ?? null;
    if (
      clientMessageId !== null &&
      (typeof clientMessageId !== 'string' || clientMessageId.length === 0)
    ) {
      throw new PersistenceValidationError('invalid_input');
    }

    const runId = input.runId ?? null;
    if (runId !== null && !isUuid(runId)) {
      throw new PersistenceValidationError('invalid_run_reference');
    }

    return withTransaction(this.pool, async (client) => {
      const conversation = await this.lockOwnedConversation(
        client,
        ownerUserId,
        conversationId,
      );

      if (conversation.status === 'archived') {
        throw new PersistenceConflictError('conversation_archived');
      }

      if (clientMessageId !== null) {
        const existing = await client.query<MessageRow>(EXISTING_CLIENT_MESSAGE, [
          conversationId,
          ownerUserId,
          clientMessageId,
        ]);
        const existingRow = existing.rows[0];

        if (existingRow !== undefined) {
          if (existingRow.deleted_at !== null || existingRow.status === 'deleted') {
            throw new PersistenceConflictError('message_tombstoned');
          }

          if (
            existingRow.role === input.role &&
            existingRow.content === input.content &&
            existingRow.status === 'final'
          ) {
            return toMessage(existingRow);
          }

          throw new PersistenceConflictError('message_idempotency_conflict');
        }
      }

      if (runId !== null) {
        const run = await client.query<{ id: string }>(
          `SELECT id
             FROM runs
            WHERE id = $1
              AND conversation_id = $2
              AND owner_user_id = $3`,
          [runId, conversationId, ownerUserId],
        );

        if (run.rows[0] === undefined) {
          throw new PersistenceValidationError('invalid_run_reference');
        }
      }

      const allocated = await client.query<{ last_message_seq: string }>(
        `UPDATE conversations
            SET last_message_seq = last_message_seq + 1,
                updated_at = now()
          WHERE id = $1
            AND owner_user_id = $2
            AND deleted_at IS NULL
            AND status = 'active'
          RETURNING last_message_seq`,
        [conversationId, ownerUserId],
      );

      const allocatedRow = allocated.rows[0];
      if (allocatedRow === undefined) {
        throw new PersistenceConflictError('conversation_archived');
      }

      let inserted: QueryResult<MessageRow>;
      try {
        inserted = await client.query<MessageRow>(
          `INSERT INTO messages AS m (
             conversation_id,
             owner_user_id,
             role,
             content,
             client_message_id,
             seq,
             run_id,
             status,
             finalized_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'final', now())
           RETURNING ${MESSAGE_COLUMNS}`,
          [
            conversationId,
            ownerUserId,
            input.role,
            input.content,
            clientMessageId,
            allocatedRow.last_message_seq,
            runId,
          ],
        );
      } catch (error) {
        if (isUniqueViolation(error)) {
          const constraint = uniqueViolationConstraint(error);
          if (constraint === 'messages_run_assistant_result_key') {
            throw new PersistenceConflictError('run_result_exists');
          }
          if (constraint === 'messages_conversation_client_id_key') {
            throw new PersistenceConflictError('message_idempotency_conflict');
          }
          if (constraint === 'messages_conversation_seq_key') {
            throw new PersistenceConflictError('message_sequence_conflict');
          }
        }
        throw error;
      }

      const row = inserted.rows[0];
      if (row === undefined) {
        throw new Error('Message insert returned no row.');
      }

      return toMessage(row);
    });
  }

  /**
   * Lists a conversation transcript in ascending `seq` order. Supplying
   * `beforeCursor` fetches the page immediately older than that cursor;
   * otherwise `afterCursor` (or the beginning) fetches forward. Cursors are
   * sequence-based, so timestamp skew cannot reorder or skip messages.
   */
  async list(
    actorUserId: string,
    conversationId: string,
    options: ListMessagesOptions = {},
  ): Promise<MessagePage> {
    const ownerUserId = requireActorUserId(actorUserId);
    const ownedConversationId = requireResourceId(conversationId);

    if (options.afterCursor !== undefined && options.beforeCursor !== undefined) {
      throw new PersistenceValidationError('invalid_input');
    }

    // Resolves both cross-user and nonexistent conversations as not found and
    // prevents an empty page from doubling as an existence oracle.
    const conversation = await loadOwnedConversation(
      this.pool,
      ownerUserId,
      ownedConversationId,
    );

    const limit = normalizeLimit(options.limit);
    const beforeSeq =
      options.beforeCursor === undefined
        ? null
        : decodeMessageCursor(options.beforeCursor);
    const afterSeq =
      options.afterCursor === undefined
        ? null
        : decodeMessageCursor(options.afterCursor);

    const result =
      beforeSeq !== null
        ? await this.pool.query<MessageRow>(MESSAGES_BACKWARD, [
            ownedConversationId,
            ownerUserId,
            beforeSeq,
            limit + 1,
          ])
        : await this.pool.query<MessageRow>(MESSAGES_FORWARD, [
            ownedConversationId,
            ownerUserId,
            afterSeq,
            limit + 1,
          ]);

    const hasMore = result.rows.length > limit;
    const pageRows = hasMore ? result.rows.slice(0, limit) : result.rows;
    const orderedRows = beforeSeq !== null ? [...pageRows].reverse() : pageRows;

    const first = orderedRows[0];
    const last = orderedRows[orderedRows.length - 1];

    return {
      messages: orderedRows.map(toMessage),
      beforeCursor: first === undefined ? null : encodeMessageCursor(Number(first.seq)),
      afterCursor: last === undefined ? null : encodeMessageCursor(Number(last.seq)),
      hasMoreBefore:
        beforeSeq !== null ? hasMore : afterSeq !== null && first !== undefined,
      hasMoreAfter:
        beforeSeq !== null
          ? last !== undefined &&
            Number(last.seq) < Number(conversation.last_message_seq)
          : hasMore,
    };
  }

  /** Reads one live message only through an owned, non-deleted conversation. */
  async get(
    actorUserId: string,
    conversationId: string,
    messageId: string,
  ): Promise<Message> {
    const ownerUserId = requireActorUserId(actorUserId);
    const ownedConversationId = requireResourceId(conversationId);
    const ownedMessageId = requireResourceId(messageId);

    const result = await this.pool.query<MessageRow>(MESSAGE_BY_ID, [
      ownedMessageId,
      ownedConversationId,
      ownerUserId,
    ]);

    const row = result.rows[0];
    if (row === undefined) {
      throw new PersistenceNotFoundError();
    }

    return toMessage(row);
  }

  private async lockOwnedConversation(
    client: PoolClient,
    ownerUserId: string,
    conversationId: string,
  ): Promise<ConversationLockRow> {
    const result = await client.query<ConversationLockRow>(
      `SELECT id, status
         FROM conversations
        WHERE id = $1
          AND owner_user_id = $2
          AND deleted_at IS NULL
        FOR UPDATE`,
      [conversationId, ownerUserId],
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new PersistenceNotFoundError();
    }

    return row;
  }
}
