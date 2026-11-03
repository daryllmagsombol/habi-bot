/**
 * H-029 (#29) message search over the requesting user's own conversation
 * history.
 *
 * Guarantees enforced by the SQL itself, not by the caller:
 *   - `messages.owner_user_id`, `conversations.owner_user_id`, and the Bot
 *     owner all equal the authenticated actor;
 *   - deleted conversations, tombstoned messages, and tombstoned Bots are
 *     excluded, while archived conversations and archived Bots stay readable
 *     (H-002 §5.1 ancestor lifecycle);
 *   - the optional conversation/Bot filters can only narrow an already
 *     owner-scoped set, so a foreign or unknown id yields the same empty page.
 *
 * Ranking is `ts_rank_cd` over the generated `search_vector`; ordering and the
 * keyset cursor use `(score, created_at, id)` so equal timestamps cannot
 * duplicate or skip a row.
 */
import type { Pool } from 'pg';
import type { MessageRole } from '@habi/contracts';
import { requireActorUserId, toIso, type Timestamp } from '../persistence/rows.js';
import { toSnippet, SNIPPET_HIT_END, SNIPPET_HIT_START } from './snippet.js';
import type { MessageSearchHit, MessageSearchPage, SearchMessagesInput } from './types.js';
import {
  assertMessageCursorScope,
  assertSearchableQuery,
  decodeMessageSearchCursor,
  encodeMessageSearchCursor,
  normalizeScopeId,
  normalizeSearchLimit,
  normalizeSearchQuery,
} from './validation.js';

interface MessageSearchRow {
  id: string;
  conversation_id: string;
  conversation_title: string;
  bot_id: string;
  role: string;
  seq: string;
  created_at: Timestamp;
  created_at_text: string;
  score: number;
  snippet: string;
}

const HEADLINE_OPTIONS =
  `StartSel=${SNIPPET_HIT_START}, StopSel=${SNIPPET_HIT_END}, ` +
  'MaxWords=28, MinWords=8, MaxFragments=2';

const MESSAGE_SEARCH = `WITH q AS (
    SELECT websearch_to_tsquery('english'::regconfig, $1::text) AS tsquery
  )
  SELECT m.id,
         m.conversation_id,
         c.title AS conversation_title,
         c.bot_id,
         m.role,
         m.seq,
         m.created_at,
         to_char(
           m.created_at AT TIME ZONE 'UTC',
           'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
         ) AS created_at_text,
         ts_rank_cd(m.search_vector, q.tsquery)::double precision AS score,
         ts_headline('english'::regconfig, m.content, q.tsquery, $8::text) AS snippet
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
     AND ($3::uuid IS NULL OR m.conversation_id = $3)
     AND ($4::uuid IS NULL OR c.bot_id = $4)
     AND (
       $5::double precision IS NULL
       OR (ts_rank_cd(m.search_vector, q.tsquery)::double precision, m.created_at, m.id)
          < ($5::double precision, $6::timestamptz, $7::uuid)
     )
   ORDER BY score DESC, m.created_at DESC, m.id DESC
   LIMIT $9`;

function toSequence(value: string): number {
  const seq = Number(value);
  if (!Number.isSafeInteger(seq) || seq < 0) {
    throw new TypeError('Persisted message sequence is outside the supported range.');
  }
  return seq;
}

function toRole(value: string): MessageRole {
  if (value !== 'user' && value !== 'assistant') {
    throw new TypeError('Persisted message role is not searchable.');
  }
  return value;
}

function toHit(row: MessageSearchRow): MessageSearchHit {
  return {
    messageId: row.id,
    conversationId: row.conversation_id,
    conversationTitle: row.conversation_title,
    botId: row.bot_id,
    role: toRole(row.role),
    seq: toSequence(row.seq),
    createdAt: toIso(row.created_at),
    score: row.score,
    snippet: toSnippet(row.snippet),
  };
}

/** A fresh empty page per call; results are never shared mutably. */
function emptyPage(): MessageSearchPage {
  return { hits: [], hasMore: false, nextCursor: null };
}

export class SearchService {
  constructor(private readonly pool: Pool) {}

  /**
   * Searches messages in the actor's own history. `query` is bound and parsed
   * with `websearch_to_tsquery`, so quotes, `or`, and `-term` work without any
   * string interpolation. An empty page is returned for a valid but foreign or
   * unknown filter id; malformed filters and cursors fail closed.
   */
  async searchMessages(input: SearchMessagesInput): Promise<MessageSearchPage> {
    const actorUserId = requireActorUserId(input.actorUserId);
    const query = normalizeSearchQuery(input.query);
    const conversationId = normalizeScopeId(input.conversationId);
    const botId = normalizeScopeId(input.botId);
    const limit = normalizeSearchLimit(input.limit);

    const cursor = input.cursor === undefined ? null : decodeMessageSearchCursor(input.cursor);
    if (cursor !== null) {
      assertMessageCursorScope(cursor, {
        fingerprint: query.fingerprint,
        conversationId,
        botId,
      });
    }

    await assertSearchableQuery(this.pool, query);

    const result = await this.pool.query<MessageSearchRow>(MESSAGE_SEARCH, [
      query.text,
      actorUserId,
      conversationId,
      botId,
      cursor?.score ?? null,
      cursor?.createdAt ?? null,
      cursor?.id ?? null,
      HEADLINE_OPTIONS,
      limit + 1,
    ]);

    const hasMore = result.rows.length > limit;
    const pageRows = hasMore ? result.rows.slice(0, limit) : result.rows;
    const last = pageRows.at(-1);

    if (pageRows.length === 0) {
      return emptyPage();
    }

    return {
      hits: pageRows.map(toHit),
      hasMore,
      nextCursor:
        hasMore && last !== undefined
          ? encodeMessageSearchCursor({
              score: last.score,
              createdAt: last.created_at_text,
              id: last.id,
              fingerprint: query.fingerprint,
              conversationId,
              botId,
            })
          : null,
    };
  }
}
