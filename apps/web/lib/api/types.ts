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

/** `GET /api/threads/:threadId/attachments`. Never paginated. */
export interface AttachmentMetadataDto {
  readonly id: string;
  readonly conversationId: string;
  readonly messageId: string | null;
  readonly originalFilename: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly status: 'pending' | 'stored' | 'rejected' | 'deleted';
  readonly createdAt: string;
  readonly storedAt: string | null;
  readonly deletedAt: string | null;
}

export interface AttachmentListDto {
  readonly attachments: readonly AttachmentMetadataDto[];
  /** Always `null`: attachment metadata is returned in one page. */
  readonly nextCursor: null;
}

/** `GET /api/bots/:botId/memories`. */
export interface MemoryDto {
  readonly id: string;
  readonly botId: string;
  readonly conversationId: string | null;
  readonly content: string;
  readonly sourceMessageId: string | null;
  readonly status: 'proposed' | 'accepted' | 'deleted';
  readonly botApproved: boolean;
  readonly conversationApproved: boolean;
  readonly provenanceState: 'live' | 'tombstoned';
  readonly provenanceTombstonedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
}

export interface MemoryListDto {
  readonly memories: readonly MemoryDto[];
  readonly nextCursor: string | null;
}

/** `GET /api/skills`. */
export interface SkillDto {
  readonly id: string;
  readonly botId: string | null;
  readonly name: string;
  readonly description: string;
  readonly bodyMarkdown: string;
  readonly version: number;
  readonly status: 'draft' | 'active' | 'archived' | 'deleted';
  readonly archivedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
}

export interface SkillListDto {
  readonly skills: readonly SkillDto[];
  readonly nextCursor: string | null;
}

export type ArtifactKind = 'markdown' | 'text' | 'json';
export type ArtifactStatus = 'draft' | 'final' | 'deleted';

/** Flat metadata list item. `GET /api/artifacts` never includes a body. */
export interface ArtifactDto {
  readonly id: string;
  readonly conversationId: string | null;
  readonly runId: string | null;
  readonly kind: ArtifactKind;
  readonly title: string;
  readonly currentVersion: number;
  readonly status: ArtifactStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
}

export interface ArtifactListDto {
  readonly artifacts: readonly ArtifactDto[];
  readonly nextCursor: string | null;
}

export interface ArtifactVersionDto {
  readonly artifactId: string;
  readonly version: number;
  readonly content: string;
  readonly contentSha256: string;
  readonly byteSize: number;
  readonly createdBy: string;
  readonly createdAt: string;
}

/** Version metadata without the body. `GET /api/artifacts/:id/versions`. */
export interface ArtifactVersionMetadataDto {
  readonly artifactId: string;
  readonly version: number;
  readonly contentSha256: string;
  readonly byteSize: number;
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface ArtifactVersionListDto {
  readonly versions: readonly ArtifactVersionMetadataDto[];
  readonly nextCursor: string | null;
}

/** Single-artifact responses are nested: metadata plus the hash-verified body. */
export interface ArtifactDetailDto {
  readonly artifact: ArtifactDto;
  readonly version: ArtifactVersionDto;
}

export interface ArtifactDetailEnvelopeDto {
  readonly artifact: ArtifactDetailDto;
}

export interface ArtifactVersionPageEnvelopeDto {
  readonly versions: readonly ArtifactVersionMetadataDto[];
  readonly nextCursor: string | null;
}

/** `GET /api/search`. Snippet is HTML-escaped and `<mark>`-delimited. */
export interface SearchHitDto {
  readonly messageId: string;
  readonly conversationId: string;
  readonly conversationTitle: string;
  readonly botId: string;
  readonly role: MessageRole;
  readonly seq: number;
  readonly createdAt: string;
  readonly score: number;
  readonly snippet: string;
}

export interface SearchPageDto {
  readonly results: readonly SearchHitDto[];
  readonly nextCursor: string | null;
}

/** `GET /api/account`. Lightweight identity only; never the export document. */
export interface AccountProfileDto {
  readonly userId: string;
  readonly email: string;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly emailVerifiedAt: string | null;
}

export interface AccountEnvelopeDto {
  readonly account: AccountProfileDto;
}

export interface ApiErrorBody {
  readonly error: { readonly code: string };
}
