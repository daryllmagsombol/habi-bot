/**
 * H-019 conversation and message contracts.
 *
 * These are the fields a client may see. Ownership columns, Run internals, and
 * other server-only identifiers are deliberately absent: the API layer maps a
 * persisted row to these shapes and never forwards the raw row.
 */

/** Conversation lifecycle from H-002 §3.1. `deleted` is a tombstone. */
export type ConversationStatus = 'active' | 'archived' | 'deleted';

/** A conversation as exposed to its owner. */
export interface Conversation {
  id: string;
  botId: string;
  title: string;
  status: ConversationStatus;
  lastMessageSeq: number;
  createdAt: string;
  updatedAt: string;
}

/** One page of owner-scoped conversations, newest updated first. */
export interface ConversationPage {
  conversations: Conversation[];
  /** Opaque cursor for the next page, or null when exhausted. */
  nextCursor: string | null;
}

/** Message author role; arbitrary role strings are rejected by the schema. */
export type MessageRole = 'user' | 'assistant';

/** Message lifecycle from H-002 §9.3. */
export type MessageStatus = 'pending' | 'final' | 'failed' | 'deleted';

/** A message as exposed to the conversation owner. */
export interface Message {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  /** Server-assigned, monotonically increasing within the conversation. */
  seq: number;
  status: MessageStatus;
  clientMessageId: string | null;
  createdAt: string;
  finalizedAt: string | null;
}

/**
 * One stable, sequence-based message page. Messages are always returned in
 * ascending `seq` order regardless of which direction was requested.
 */
export interface MessagePage {
  messages: Message[];
  /** Opaque cursor for messages older than this page, or null. */
  beforeCursor: string | null;
  /** Opaque cursor for messages newer than this page, or null. */
  afterCursor: string | null;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
}
