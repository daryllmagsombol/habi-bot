import type { Conversation, ConversationPage } from '@habi/contracts';
import type { Pool } from 'pg';
import { withTransaction } from './database.js';
import { decodeConversationCursor, encodeConversationCursor } from './cursor.js';
import {
  PersistenceConflictError,
  PersistenceNotFoundError,
  PersistenceValidationError,
} from './errors.js';
import { normalizeLimit } from './pagination.js';
import {
  CONVERSATION_COLUMNS,
  loadOwnedConversation,
  requireActorUserId,
  requireResourceId,
  requireRow,
  toConversation,
  type ConversationRow,
  type ConversationStateRow,
} from './rows.js';
import type { CreateConversationInput, ListConversationsOptions } from './types.js';

const DEFAULT_TITLE = 'New conversation';

interface BotStateRow {
  status: string;
}

/**
 * Owner-scoped conversation persistence. Every statement carries
 * `owner_user_id = $actor` in the query itself; no caller-supplied owner is
 * trusted, and no method returns a row for another user.
 */
export class ConversationRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * Creates a conversation under a Bot the actor owns. A guessed Bot id and a
   * Bot owned by someone else are both reported as not found.
   */
  async create(actorUserId: string, input: CreateConversationInput): Promise<Conversation> {
    const ownerUserId = requireActorUserId(actorUserId);
    const botId = requireResourceId(input.botId);

    if (input.title !== undefined && typeof input.title !== 'string') {
      throw new PersistenceValidationError('invalid_input');
    }
    const title = input.title === undefined ? DEFAULT_TITLE : input.title.trim();

    if (title.length === 0) {
      throw new PersistenceValidationError('invalid_input');
    }

    const bot = await this.pool.query<BotStateRow>(
      `SELECT status
         FROM bots
        WHERE id = $1
          AND owner_user_id = $2
          AND deleted_at IS NULL`,
      [botId, ownerUserId],
    );

    const botRow = bot.rows[0];
    if (botRow === undefined) {
      throw new PersistenceNotFoundError();
    }
    if (botRow.status !== 'active') {
      throw new PersistenceConflictError('bot_unavailable');
    }

    const result = await this.pool.query<ConversationRow>(
      `INSERT INTO conversations (owner_user_id, bot_id, title)
       VALUES ($1, $2, $3)
       RETURNING ${CONVERSATION_COLUMNS}`,
      [ownerUserId, botId, title],
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error('Conversation insert returned no row.');
    }

    return toConversation(row);
  }

  /** Reads one live or archived conversation owned by the actor. */
  async get(actorUserId: string, conversationId: string): Promise<Conversation> {
    const row = await loadOwnedConversation(this.pool, actorUserId, conversationId);
    return toConversation(row);
  }

  /** Lists the actor's live and archived conversations, newest updated first. */
  async list(
    actorUserId: string,
    options: ListConversationsOptions = {},
  ): Promise<ConversationPage> {
    const ownerUserId = requireActorUserId(actorUserId);
    const status = options.status ?? null;

    if (status !== null && status !== 'active' && status !== 'archived') {
      throw new PersistenceValidationError('invalid_input');
    }

    const limit = normalizeLimit(options.limit);
    const cursor =
      options.cursor === undefined ? null : decodeConversationCursor(options.cursor);

    const result = await this.pool.query<ConversationRow>(
      `SELECT ${CONVERSATION_COLUMNS}
         FROM conversations
        WHERE owner_user_id = $1
          AND deleted_at IS NULL
          AND ($2::text IS NULL OR status = $2)
          AND (
            $3::timestamptz IS NULL
            OR (updated_at, id) < ($3::timestamptz, $4::uuid)
          )
        ORDER BY updated_at DESC, id DESC
        LIMIT $5`,
      [ownerUserId, status, cursor?.updatedAt ?? null, cursor?.id ?? null, limit + 1],
    );

    const hasMore = result.rows.length > limit;
    const rows = hasMore ? result.rows.slice(0, limit) : result.rows;
    const last = rows[rows.length - 1];

    return {
      conversations: rows.map(toConversation),
      nextCursor:
        hasMore && last !== undefined
          ? encodeConversationCursor({
              updatedAt:
                last.updated_at instanceof Date
                  ? last.updated_at.toISOString()
                  : new Date(last.updated_at).toISOString(),
              id: last.id,
            })
          : null,
    };
  }

  /** Renames a conversation the actor owns. Archived conversations stay editable. */
  async rename(
    actorUserId: string,
    conversationId: string,
    title: string,
  ): Promise<Conversation> {
    const ownerUserId = requireActorUserId(actorUserId);
    const ownedConversationId = requireResourceId(conversationId);

    if (typeof title !== 'string') {
      throw new PersistenceValidationError('invalid_input');
    }
    const nextTitle = title.trim();

    if (nextTitle.length === 0) {
      throw new PersistenceValidationError('invalid_input');
    }

    const result = await this.pool.query<ConversationRow>(
      `UPDATE conversations
          SET title = $3,
              updated_at = now()
        WHERE id = $1
          AND owner_user_id = $2
          AND deleted_at IS NULL
        RETURNING ${CONVERSATION_COLUMNS}`,
      [ownedConversationId, ownerUserId, nextTitle],
    );

    return toConversation(requireRow(result));
  }

  /**
   * Archives a conversation. Repeat calls are idempotent for the owner;
   * archived conversations remain readable but reject new messages.
   */
  async archive(actorUserId: string, conversationId: string): Promise<Conversation> {
    const ownerUserId = requireActorUserId(actorUserId);
    const ownedConversationId = requireResourceId(conversationId);

    const result = await this.pool.query<ConversationRow>(
      `UPDATE conversations
          SET status = 'archived',
              updated_at = now()
        WHERE id = $1
          AND owner_user_id = $2
          AND deleted_at IS NULL
        RETURNING ${CONVERSATION_COLUMNS}`,
      [ownedConversationId, ownerUserId],
    );

    // Deleted, foreign, or nonexistent: one non-enumerating outcome.
    return toConversation(requireRow(result));
  }

  /**
   * Soft-deletes a conversation and tombstones its messages in one
   * transaction. A repeated delete by the owner returns the tombstone; a
   * cross-owner or nonexistent id is not found. Tombstoned rows are never
   * returned by `get` or `list`, so a later append cannot resurrect them.
   */
  async delete(actorUserId: string, conversationId: string): Promise<Conversation> {
    const ownerUserId = requireActorUserId(actorUserId);
    const ownedConversationId = requireResourceId(conversationId);

    return withTransaction(this.pool, async (client) => {
      const deleted = await client.query<ConversationRow>(
        `UPDATE conversations
            SET status = 'deleted',
                deleted_at = now(),
                updated_at = now()
          WHERE id = $1
            AND owner_user_id = $2
            AND deleted_at IS NULL
          RETURNING ${CONVERSATION_COLUMNS}`,
        [ownedConversationId, ownerUserId],
      );

      const row = deleted.rows[0];
      if (row !== undefined) {
        await client.query(
          `UPDATE messages
              SET status = 'deleted',
                  deleted_at = now()
            WHERE conversation_id = $1
              AND owner_user_id = $2
              AND deleted_at IS NULL`,
          [ownedConversationId, ownerUserId],
        );

        return toConversation(row);
      }

      const alreadyDeleted = await client.query<ConversationStateRow>(
        `SELECT ${CONVERSATION_COLUMNS}, deleted_at
           FROM conversations
          WHERE id = $1
            AND owner_user_id = $2
            AND deleted_at IS NOT NULL`,
        [ownedConversationId, ownerUserId],
      );

      return toConversation(requireRow(alreadyDeleted));
    });
  }
}
