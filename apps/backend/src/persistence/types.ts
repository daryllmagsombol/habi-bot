import type { ConversationStatus, MessageRole } from '@habi/contracts';

/** Caller input for creating a conversation. `botId` must be owned by the actor. */
export interface CreateConversationInput {
  botId: string;
  /** Trimmed server-side; defaults to `New conversation` when omitted. */
  title?: string;
}

export interface ListConversationsOptions {
  /** Defaults to active and archived conversations; deleted rows never list. */
  status?: Extract<ConversationStatus, 'active' | 'archived'>;
  limit?: number;
  /** Opaque cursor from a previous `ConversationPage`. */
  cursor?: string;
}

/** Caller input for appending one final message. */
export interface AppendMessageInput {
  conversationId: string;
  role: MessageRole;
  /** Stored exactly as supplied; values are always bound, never interpolated. */
  content: string;
  /** Idempotency key, unique per conversation when present. */
  clientMessageId?: string;
  /** Optional producing Run; must belong to the same conversation and owner. */
  runId?: string;
}

export interface ListMessagesOptions {
  limit?: number;
  /** Opaque cursor for messages newer than the last returned message. */
  afterCursor?: string;
  /** Opaque cursor for messages older than the first returned message. */
  beforeCursor?: string;
}
