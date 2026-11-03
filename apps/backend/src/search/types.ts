/**
 * H-029 (#29) owner-scoped conversation search contract.
 *
 * Search is a read surface over the requesting user's own conversation
 * history. Every query carries the owner predicate in SQL, so a client-supplied
 * conversation or Bot filter can only narrow what the caller already owns; it
 * can never widen the result set or prove that a foreign resource exists.
 *
 * Results deliberately carry a snippet rather than the full message body: the
 * snippet is the only field that embeds message content, and it is already
 * HTML-escaped (see `snippet.ts`). Ranking is deterministic:
 * `score DESC, created_at DESC, message id DESC` for messages and
 * `latest_match_at DESC, conversation id DESC` for conversations.
 */
import type { ConversationStatus, MessageRole } from '@habi/contracts';

/** Filter and paging input for one message search. */
export interface SearchMessagesInput {
  /** Authenticated actor. Never derived from request parameters. */
  actorUserId: string;
  /** Free-text query, parsed with `websearch_to_tsquery`; 2-200 characters. */
  query: string;
  /** Restricts results to one conversation the actor owns. */
  conversationId?: string;
  /** Restricts results to the actor's conversations under one Bot. */
  botId?: string;
  /** Page size; defaults to 20 and is clamped to 50. */
  limit?: number;
  /** Opaque cursor from a previous `MessageSearchPage`. */
  cursor?: string;
}

/** One matching message inside an owned conversation. */
export interface MessageSearchHit {
  messageId: string;
  conversationId: string;
  conversationTitle: string;
  botId: string;
  role: MessageRole;
  /** Conversation-local message order, useful for "jump to message". */
  seq: number;
  createdAt: string;
  /** Deterministic relevance score; higher is more relevant. */
  score: number;
  /** HTML-escaped, `<mark>`-delimited excerpt; never raw message markup. */
  snippet: string;
}

export interface MessageSearchPage {
  hits: MessageSearchHit[];
  /** True when another page exists for the same query and scope. */
  hasMore: boolean;
  /** Opaque cursor bound to the query and scope that produced this page. */
  nextCursor: string | null;
}

/** Filter and paging input for one conversation-grouped search. */
export interface SearchConversationsInput {
  actorUserId: string;
  query: string;
  conversationId?: string;
  botId?: string;
  limit?: number;
  cursor?: string;
}

/**
 * One conversation containing at least one matching message. Counts are
 * computed inside the same owner-scoped statement, so they cannot include
 * messages the caller may not read.
 */
export interface ConversationSearchHit {
  conversationId: string;
  title: string;
  botId: string;
  status: Extract<ConversationStatus, 'active' | 'archived'>;
  matchCount: number;
  /** Best per-message relevance score in this conversation. */
  bestScore: number;
  latestMatchAt: string;
}

export interface ConversationSearchPage {
  conversations: ConversationSearchHit[];
  hasMore: boolean;
  nextCursor: string | null;
}
