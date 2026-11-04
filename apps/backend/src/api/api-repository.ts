/**
 * Read-only owner-scoped projections the chat surface needs beyond the existing
 * repositories: per-Bot conversation counts/activity, and a Bot-filtered thread
 * page.
 *
 * Both statements bind `owner_user_id` themselves. Foreign, unknown, and
 * tombstoned parents produce the same persistence `not_found` through the
 * existing ownership helpers, never an empty page that could act as an oracle.
 */
import type { Conversation } from '@habi/contracts';
import type { Pool } from 'pg';
import {
  decodeConversationCursor,
  encodeConversationCursor,
} from '../persistence/cursor.js';
import { normalizeLimit } from '../persistence/pagination.js';
import {
  CONVERSATION_COLUMNS,
  requireActorUserId,
  requireResourceId,
  toConversation,
  type ConversationRow,
  type Timestamp,
} from '../persistence/rows.js';

interface ActivityRow {
  bot_id: string;
  conversation_count: number;
  last_activity_at: Timestamp | null;
}

export interface ConversationActivity {
  botId: string;
  conversationCount: number;
  /** Null when the Bot has no live conversations. */
  lastActivityAt: string | null;
}

export interface BotThreadPage {
  threads: Conversation[];
  nextCursor: string | null;
}

export interface ListBotThreadsOptions {
  limit?: number;
  cursor?: string;
}

function toIso(value: Timestamp): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export class ApiProjectionRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * Counts live and archived conversations owned by the actor for the given
   * Bots. Deleted conversations are excluded from both count and activity.
   */
  async conversationActivity(
    actorUserId: string,
    botIds: readonly string[],
  ): Promise<Map<string, ConversationActivity>> {
    const actor = requireActorUserId(actorUserId);

    if (botIds.length === 0) {
      return new Map();
    }

    const result = await this.pool.query<ActivityRow>(
      `SELECT bot_id,
              count(*)::int AS conversation_count,
              max(updated_at) AS last_activity_at
         FROM conversations
        WHERE owner_user_id = $1
          AND bot_id = ANY($2::uuid[])
          AND deleted_at IS NULL
        GROUP BY bot_id`,
      [actor, botIds],
    );

    const activity = new Map<string, ConversationActivity>();

    for (const row of result.rows) {
      activity.set(row.bot_id, {
        botId: row.bot_id,
        conversationCount: row.conversation_count,
        lastActivityAt:
          row.last_activity_at === null ? null : toIso(row.last_activity_at),
      });
    }

    return activity;
  }

  /**
   * Lists one Bot's conversations for the actor, newest updated first. The Bot
   * ownership check happens before this query; this statement still binds the
   * owner so a foreign Bot id cannot return rows.
   */
  async listBotThreads(
    actorUserId: string,
    botId: string,
    options: ListBotThreadsOptions = {},
  ): Promise<BotThreadPage> {
    const actor = requireActorUserId(actorUserId);
    const ownedBotId = requireResourceId(botId);
    const limit = normalizeLimit(options.limit);
    const cursor =
      options.cursor === undefined
        ? null
        : decodeConversationCursor(options.cursor);

    const result = await this.pool.query<ConversationRow>(
      `SELECT ${CONVERSATION_COLUMNS}
         FROM conversations
        WHERE owner_user_id = $1
          AND bot_id = $2
          AND deleted_at IS NULL
          AND (
            $3::timestamptz IS NULL
            OR (updated_at, id) < ($3::timestamptz, $4::uuid)
          )
        ORDER BY updated_at DESC, id DESC
        LIMIT $5`,
      [actor, ownedBotId, cursor?.updatedAt ?? null, cursor?.id ?? null, limit + 1],
    );

    const hasMore = result.rows.length > limit;
    const rows = hasMore ? result.rows.slice(0, limit) : result.rows;
    const last = rows.at(-1);

    return {
      threads: rows.map(toConversation),
      nextCursor:
        hasMore && last !== undefined
          ? encodeConversationCursor({
              updatedAt: toIso(last.updated_at),
              id: last.id,
            })
          : null,
    };
  }
}
