/**
 * H-029 (#29) conversation-grouped search: which of the actor's conversations
 * contain matches, and how many.
 *
 * Counts are computed inside the same owner-scoped statement as the grouping,
 * so a count can never include a message, conversation, or Bot that the
 * requesting user does not own. Archived conversations and archived Bots are
 * included because H-002 keeps them readable; deleted ancestors are not.
 *
 * Ordering is `latest_match_at DESC, conversation_id DESC` so the cursor is a
 * stable `(timestamp, id)` keyset even while match counts change.
 */
import type { Pool } from 'pg';
import type { ConversationStatus } from '@habi/contracts';
import { requireActorUserId, toIso, type Timestamp } from '../persistence/rows.js';
import type {
  ConversationSearchHit,
  ConversationSearchPage,
  SearchConversationsInput,
} from './types.js';
import {
  assertConversationCursorScope,
  assertSearchableQuery,
  decodeConversationSearchCursor,
  encodeConversationSearchCursor,
  normalizeScopeId,
  normalizeSearchLimit,
  normalizeSearchQuery,
} from './validation.js';

interface ConversationSearchRow {
  id: string;
  title: string;
  bot_id: string;
  status: string;
  match_count: number;
  best_score: number;
  latest_match_at: Timestamp;
  latest_match_at_text: string;
}

const CONVERSATION_SEARCH = `WITH q AS (
    SELECT websearch_to_tsquery('english'::regconfig, $1::text) AS tsquery
  )
  SELECT c.id,
         c.title,
         c.bot_id,
         c.status,
         count(*)::int AS match_count,
         max(ts_rank_cd(m.search_vector, q.tsquery)::double precision) AS best_score,
         max(m.created_at) AS latest_match_at,
         to_char(
           max(m.created_at) AT TIME ZONE 'UTC',
           'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
         ) AS latest_match_at_text
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    JOIN bots b
      ON b.id = c.bot_id
     AND b.owner_user_id = $2
    CROSS JOIN q
   WHERE m.owner_user_id = $2
     AND c.owner_user_id = $2
     AND c.deleted_at IS NULL
     AND c.status <> 'deleted'
     AND b.deleted_at IS NULL
     AND b.status <> 'deleted'
     AND m.deleted_at IS NULL
     AND m.status <> 'deleted'
     AND m.search_vector @@ q.tsquery
     AND ($3::uuid IS NULL OR c.id = $3)
     AND ($4::uuid IS NULL OR c.bot_id = $4)
   GROUP BY c.id, c.title, c.bot_id, c.status
  HAVING (
    $5::timestamptz IS NULL
    OR (max(m.created_at), c.id) < ($5::timestamptz, $6::uuid)
  )
   ORDER BY max(m.created_at) DESC, c.id DESC
   LIMIT $7`;

function toStatus(value: string): Extract<ConversationStatus, 'active' | 'archived'> {
  if (value !== 'active' && value !== 'archived') {
    throw new TypeError('Persisted conversation status is not searchable.');
  }
  return value;
}

function toHit(row: ConversationSearchRow): ConversationSearchHit {
  return {
    conversationId: row.id,
    title: row.title,
    botId: row.bot_id,
    status: toStatus(row.status),
    matchCount: row.match_count,
    bestScore: row.best_score,
    latestMatchAt: toIso(row.latest_match_at),
  };
}

/** A fresh empty page per call; results are never shared mutably. */
function emptyPage(): ConversationSearchPage {
  return { conversations: [], hasMore: false, nextCursor: null };
}

export class ConversationSearchService {
  constructor(private readonly pool: Pool) {}

  /**
   * Lists the actor's conversations that contain at least one matching message,
   * newest match first. A foreign or unknown filter id produces the same empty
   * page as a conversation with no matches.
   */
  async searchConversations(
    input: SearchConversationsInput,
  ): Promise<ConversationSearchPage> {
    const actorUserId = requireActorUserId(input.actorUserId);
    const query = normalizeSearchQuery(input.query);
    const conversationId = normalizeScopeId(input.conversationId);
    const botId = normalizeScopeId(input.botId);
    const limit = normalizeSearchLimit(input.limit);

    const cursor =
      input.cursor === undefined ? null : decodeConversationSearchCursor(input.cursor);
    if (cursor !== null) {
      assertConversationCursorScope(cursor, {
        fingerprint: query.fingerprint,
        conversationId,
        botId,
      });
    }

    await assertSearchableQuery(this.pool, query);

    const result = await this.pool.query<ConversationSearchRow>(CONVERSATION_SEARCH, [
      query.text,
      actorUserId,
      conversationId,
      botId,
      cursor?.latestMatchAt ?? null,
      cursor?.conversationId ?? null,
      limit + 1,
    ]);

    const hasMore = result.rows.length > limit;
    const pageRows = hasMore ? result.rows.slice(0, limit) : result.rows;
    const last = pageRows.at(-1);

    if (pageRows.length === 0) {
      return emptyPage();
    }

    return {
      conversations: pageRows.map(toHit),
      hasMore,
      nextCursor:
        hasMore && last !== undefined
          ? encodeConversationSearchCursor({
              latestMatchAt: last.latest_match_at_text,
              conversationId: last.id,
              fingerprint: query.fingerprint,
              conversationIdFilter: conversationId,
              botIdFilter: botId,
            })
          : null,
    };
  }
}
