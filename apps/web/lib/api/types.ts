/**
 * Wire types for the P1 chat HTTP surface.
 *
 * These mirror the JSON the Nest API returns today. They are deliberately a
 * local copy rather than an import from `apps/backend`: the web app must not
 * depend on backend internals, and the mapping to component props happens in
 * exactly one place per screen. Nothing here is rendered directly.
 */

export type BotStatus = 'active' | 'archived';

/** One row of `GET /api/bots`. */
export interface BotSummaryDto {
  readonly id: string;
  readonly name: string;
  /** One bounded display line built from the owner's own description. */
  readonly purpose: string;
  readonly status: BotStatus;
  readonly avatarRef: string | null;
  readonly conversationCount: number;
  readonly lastActivityAt: string;
  readonly updatedAt: string;
}

export interface BotListDto {
  readonly bots: readonly BotSummaryDto[];
  readonly nextCursor: string | null;
}

export interface BotProfileDto {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly avatarRef: string | null;
  readonly instructionsMarkdown: string;
  readonly status: BotStatus;
  readonly archivedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** `GET /api/bots/:botId`. */
export interface BotDetailDto {
  readonly bot: BotProfileDto;
  readonly purpose: string;
  readonly conversationCount: number;
  readonly lastActivityAt: string;
}

export type ConversationStatus = 'active' | 'archived' | 'deleted';

/** `GET /api/bots/:botId/threads`. */
export interface ConversationDto {
  readonly id: string;
  readonly botId: string;
  readonly title: string;
  readonly status: ConversationStatus;
  readonly lastMessageSeq: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface BotThreadPageDto {
  readonly threads: readonly ConversationDto[];
  readonly nextCursor: string | null;
}

export type MessageRole = 'user' | 'assistant';
export type MessageStatus = 'pending' | 'final' | 'failed' | 'deleted';

/** `GET /api/threads/:threadId/messages`. */
export interface MessageDto {
  readonly id: string;
  readonly conversationId: string;
  readonly role: MessageRole;
  readonly content: string;
  readonly seq: number;
  readonly status: MessageStatus;
  readonly clientMessageId: string | null;
  readonly createdAt: string;
  readonly finalizedAt: string | null;
}

export interface MessagePageDto {
  readonly messages: readonly MessageDto[];
  readonly beforeCursor: string | null;
  readonly afterCursor: string | null;
  readonly hasMoreBefore: boolean;
  readonly hasMoreAfter: boolean;
}

export type RunStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'execution_uncertain';

export interface RunUsageDto {
  readonly status: 'known' | 'partial' | 'unknown';
  readonly grossPromptTokens: number | null;
  readonly grossCompletionTokens: number | null;
  readonly cachedPromptTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly totalTokens: number | null;
  readonly costStatus: 'known' | 'unknown';
}

/** The owner-visible Run projection (`POST` message results, cancel). */
export interface RunDto {
  readonly id: string;
  readonly conversationId: string;
  readonly status: RunStatus;
  readonly dispatchState: string;
  readonly errorCode: string | null;
  readonly lastEventSeq: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly usage: RunUsageDto;
}

/** `POST /api/threads/:threadId/messages` (201). */
export interface PostMessageDto {
  readonly message: MessageDto;
  readonly runId: string;
  readonly run: RunDto;
}

/** One frame named by the SSE `event:` field. */
export interface RunEventDto {
  readonly id: string;
  readonly runId: string;
  readonly seq: number;
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface GapDto {
  readonly runId: string;
  readonly fromSeq: number;
  readonly toSeq: number;
}

export interface ApiErrorBody {
  readonly error: { readonly code: string };
}
