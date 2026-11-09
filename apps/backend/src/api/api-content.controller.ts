/**
 * Write and content-read surface for the P1 chat UI.
 *
 * Composition only, like `ApiController`: every method takes the actor id from
 * the validated session record, passes it to an owner-scoped service, and adds
 * no authorization rule of its own. Route paths and bodies never select an
 * owner. Unknown, foreign, malformed, and tombstoned ids all remain one
 * `404 not_found`; validation is only distinct after ownership is resolved.
 *
 * Route table:
 *
 *   POST   /api/bots
 *   PATCH  /api/bots/:botId
 *   DELETE /api/bots/:botId
 *   POST   /api/bots/:botId/threads
 *   PATCH  /api/threads/:threadId
 *   DELETE /api/threads/:threadId
 *   GET    /api/threads/:threadId/attachments
 *   GET    /api/attachments/:attachmentId
 *   GET    /api/attachments/:attachmentId/content
 *   GET    /api/artifacts
 *   POST   /api/artifacts
 *   GET    /api/artifacts/:artifactId
 *   PATCH  /api/artifacts/:artifactId
 *   GET    /api/artifacts/:artifactId/versions
 *   POST   /api/artifacts/:artifactId/restore
 *   GET    /api/bots/:botId/memories
 *   POST   /api/bots/:botId/memories
 *   POST   /api/memories/:memoryId/approvals
 *   GET    /api/skills
 *   POST   /api/skills
 *   GET    /api/skills/:skillId
 *   POST   /api/skills/:skillId/attach
 *   POST   /api/skills/:skillId/detach
 *   GET    /api/search
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import type { ApiService } from './api-service.js';
import { ApiError, ApiErrorFilter } from './api-errors.js';
import { ApiRuntime } from './api-runtime.js';
import type { AttachmentMetadata } from '../attachments/types.js';
import { PersistenceValidationError } from '../persistence/errors.js';
import { normalizeLimit } from '../persistence/pagination.js';
import { SessionAuthGuard } from '../session/session-auth.guard.js';
import { SessionCsrfGuard } from '../session/session-csrf.guard.js';
import { requireSession, type SessionRequest } from '../session/session-request.js';
import type { SkillStatus } from '../skills/types.js';

const TEXT_ATTACHMENT_CONTENT_TYPES: ReadonlySet<string> = new Set([
  'text/plain',
  'text/markdown',
]);

const SKILL_STATUSES: ReadonlySet<string> = new Set<SkillStatus>([
  'draft',
  'active',
  'archived',
  'deleted',
]);

const UNSIGNED_INTEGER = /^\d+$/;

function readOptionalString(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string' || value.length === 0) {
    throw new PersistenceValidationError('invalid_input');
  }

  return value;
}

/** Cursor parsing keeps the `invalid_cursor` vocabulary, including an empty value. */
function readCursor(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string' || value.length === 0) {
    throw new PersistenceValidationError('invalid_cursor');
  }

  return value;
}

function readLimit(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string' || !UNSIGNED_INTEGER.test(value)) {
    throw new PersistenceValidationError('invalid_input');
  }

  const limit = Number(value);

  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new PersistenceValidationError('invalid_input');
  }

  return normalizeLimit(limit);
}

function readOptionalVersion(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    throw new PersistenceValidationError('invalid_input');
  }

  const version = Number(value);

  if (!Number.isSafeInteger(version)) {
    throw new PersistenceValidationError('invalid_input');
  }

  return version;
}

function readSkillStatus(value: unknown): SkillStatus | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string' || !SKILL_STATUSES.has(value)) {
    throw new PersistenceValidationError('invalid_input');
  }

  return value as SkillStatus;
}

@Controller('api')
@UseGuards(SessionAuthGuard)
@UseFilters(ApiErrorFilter)
export class ApiContentController {
  constructor(@Inject(ApiRuntime) private readonly runtime: ApiRuntime) {}

  private get service(): ApiService {
    return this.runtime.getService();
  }

  // --- Bots -------------------------------------------------------------

  @Post('bots')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(SessionCsrfGuard)
  createBot(
    @Body() body: unknown,
    @Req() request: SessionRequest,
  ): ReturnType<ApiService['createBot']> {
    const { userId } = requireSession(request);

    return this.service.createBot(userId, body);
  }

  @Patch('bots/:botId')
  @UseGuards(SessionCsrfGuard)
  updateBot(
    @Param('botId') botId: string,
    @Body() body: unknown,
    @Req() request: SessionRequest,
  ): ReturnType<ApiService['updateBot']> {
    const { userId } = requireSession(request);

    return this.service.updateBot(userId, botId, body);
  }

  @Delete('bots/:botId')
  @UseGuards(SessionCsrfGuard)
  archiveBot(
    @Param('botId') botId: string,
    @Req() request: SessionRequest,
  ): ReturnType<ApiService['archiveBot']> {
    const { userId } = requireSession(request);

    return this.service.archiveBot(userId, botId);
  }

  // --- Threads ----------------------------------------------------------

  @Post('bots/:botId/threads')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(SessionCsrfGuard)
  createThread(
    @Param('botId') botId: string,
    @Body() body: unknown,
    @Req() request: SessionRequest,
  ): ReturnType<ApiService['createThread']> {
    const { userId } = requireSession(request);

    return this.service.createThread(userId, botId, body);
  }

  @Patch('threads/:threadId')
  @UseGuards(SessionCsrfGuard)
  renameThread(
    @Param('threadId') threadId: string,
    @Body() body: unknown,
    @Req() request: SessionRequest,
  ): ReturnType<ApiService['renameThread']> {
    const { userId } = requireSession(request);

    return this.service.renameThread(userId, threadId, body);
  }

  @Delete('threads/:threadId')
  @UseGuards(SessionCsrfGuard)
  deleteThread(
    @Param('threadId') threadId: string,
    @Req() request: SessionRequest,
  ): ReturnType<ApiService['deleteThread']> {
    const { userId } = requireSession(request);

    return this.service.deleteThread(userId, threadId);
  }

  // --- Attachments (metadata and verified text bytes) -------------------

  @Get('threads/:threadId/attachments')
  async listAttachments(
    @Param('threadId') threadId: string,
    @Req() request: SessionRequest,
    @Query('limit') limit: unknown,
  ): Promise<{ attachments: AttachmentMetadata[]; nextCursor: null }> {
    const { userId } = requireSession(request);
    const parsedLimit = readLimit(limit);
    const attachments = await this.runtime
      .getAttachments()
      .listForConversation(
        userId,
        threadId,
        parsedLimit === undefined ? {} : { limit: parsedLimit },
      );

    return { attachments, nextCursor: null };
  }

  @Get('attachments/:attachmentId/content')
  async readAttachmentContent(
    @Param('attachmentId') attachmentId: string,
    @Req() request: SessionRequest,
    @Res() response: Response,
  ): Promise<void> {
    const { userId } = requireSession(request);
    const { metadata, content } = await this.runtime
      .getAttachments()
      .readContent(userId, attachmentId);

    // Ownership and integrity were proven by the service. Refusing a binary
    // representation reveals nothing about another user's uploads.
    if (!TEXT_ATTACHMENT_CONTENT_TYPES.has(metadata.contentType)) {
      throw new ApiError('unsupported_media_type');
    }

    response.status(HttpStatus.OK);
    response.setHeader(
      'content-type',
      `${metadata.contentType}; charset=utf-8`,
    );
    response.setHeader('content-length', String(content.byteLength));
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    response.send(content);
  }

  @Get('attachments/:attachmentId')
  async getAttachment(
    @Param('attachmentId') attachmentId: string,
    @Req() request: SessionRequest,
  ): Promise<{ attachment: AttachmentMetadata }> {
    const { userId } = requireSession(request);

    return {
      attachment: await this.runtime
        .getAttachments()
        .getMetadata(userId, attachmentId),
    };
  }

  // --- Artifacts --------------------------------------------------------

  @Get('artifacts')
  listArtifacts(
    @Req() request: SessionRequest,
    @Query('conversationId') conversationId: unknown,
    @Query('limit') limit: unknown,
    @Query('cursor') cursor: unknown,
  ): ReturnType<ApiService['listArtifacts']> {
    const { userId } = requireSession(request);
    const parsedConversationId = readOptionalString(conversationId);
    const parsedLimit = readLimit(limit);
    const parsedCursor = readCursor(cursor);

    return this.service.listArtifacts(userId, {
      ...(parsedConversationId === undefined
        ? {}
        : { conversationId: parsedConversationId }),
      ...(parsedLimit === undefined ? {} : { limit: parsedLimit }),
      ...(parsedCursor === undefined ? {} : { cursor: parsedCursor }),
    });
  }

  @Post('artifacts')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(SessionCsrfGuard)
  createArtifact(
    @Body() body: unknown,
    @Req() request: SessionRequest,
  ): ReturnType<ApiService['createArtifact']> {
    const { userId } = requireSession(request);

    return this.service.createArtifact(userId, body);
  }

  @Get('artifacts/:artifactId')
  getArtifact(
    @Param('artifactId') artifactId: string,
    @Req() request: SessionRequest,
    @Query('version') version: unknown,
  ): ReturnType<ApiService['getArtifact']> {
    const { userId } = requireSession(request);

    return this.service.getArtifact(
      userId,
      artifactId,
      readOptionalVersion(version),
    );
  }

  @Patch('artifacts/:artifactId')
  @UseGuards(SessionCsrfGuard)
  updateArtifact(
    @Param('artifactId') artifactId: string,
    @Body() body: unknown,
    @Req() request: SessionRequest,
  ): ReturnType<ApiService['updateArtifact']> {
    const { userId } = requireSession(request);

    return this.service.updateArtifact(userId, artifactId, body);
  }

  @Get('artifacts/:artifactId/versions')
  listArtifactVersions(
    @Param('artifactId') artifactId: string,
    @Req() request: SessionRequest,
    @Query('limit') limit: unknown,
    @Query('cursor') cursor: unknown,
  ): ReturnType<ApiService['listArtifactVersions']> {
    const { userId } = requireSession(request);
    const parsedLimit = readLimit(limit);
    const parsedCursor = readCursor(cursor);

    return this.service.listArtifactVersions(userId, artifactId, {
      ...(parsedLimit === undefined ? {} : { limit: parsedLimit }),
      ...(parsedCursor === undefined ? {} : { cursor: parsedCursor }),
    });
  }

  @Post('artifacts/:artifactId/restore')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SessionCsrfGuard)
  restoreArtifactVersion(
    @Param('artifactId') artifactId: string,
    @Body() body: unknown,
    @Req() request: SessionRequest,
  ): ReturnType<ApiService['restoreArtifactVersion']> {
    const { userId } = requireSession(request);

    return this.service.restoreArtifactVersion(userId, artifactId, body);
  }

  // --- Memory -----------------------------------------------------------

  @Get('bots/:botId/memories')
  listMemories(
    @Param('botId') botId: string,
    @Req() request: SessionRequest,
    @Query('limit') limit: unknown,
    @Query('cursor') cursor: unknown,
  ): ReturnType<ApiService['listMemories']> {
    const { userId } = requireSession(request);
    const parsedLimit = readLimit(limit);
    const parsedCursor = readCursor(cursor);

    return this.service.listMemories(userId, botId, {
      ...(parsedLimit === undefined ? {} : { limit: parsedLimit }),
      ...(parsedCursor === undefined ? {} : { cursor: parsedCursor }),
    });
  }

  @Post('bots/:botId/memories')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(SessionCsrfGuard)
  createMemory(
    @Param('botId') botId: string,
    @Body() body: unknown,
    @Req() request: SessionRequest,
  ): ReturnType<ApiService['createMemory']> {
    const { userId } = requireSession(request);

    return this.service.createMemory(userId, botId, body);
  }

  @Post('memories/:memoryId/approvals')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SessionCsrfGuard)
  setMemoryApprovals(
    @Param('memoryId') memoryId: string,
    @Body() body: unknown,
    @Req() request: SessionRequest,
  ): ReturnType<ApiService['setMemoryApprovals']> {
    const { userId } = requireSession(request);

    return this.service.setMemoryApprovals(userId, memoryId, body);
  }

  // --- Skills -----------------------------------------------------------

  @Get('skills')
  listSkills(
    @Req() request: SessionRequest,
    @Query('botId') botId: unknown,
    @Query('status') status: unknown,
    @Query('limit') limit: unknown,
    @Query('cursor') cursor: unknown,
  ): ReturnType<ApiService['listSkills']> {
    const { userId } = requireSession(request);
    const parsedBotId = readOptionalString(botId);
    const parsedStatus = readSkillStatus(status);
    const parsedLimit = readLimit(limit);
    const parsedCursor = readCursor(cursor);

    return this.service.listSkills(userId, {
      ...(parsedBotId === undefined ? {} : { botId: parsedBotId }),
      ...(parsedStatus === undefined ? {} : { status: parsedStatus }),
      ...(parsedLimit === undefined ? {} : { limit: parsedLimit }),
      ...(parsedCursor === undefined ? {} : { cursor: parsedCursor }),
    });
  }

  @Post('skills')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(SessionCsrfGuard)
  createSkill(
    @Body() body: unknown,
    @Req() request: SessionRequest,
  ): ReturnType<ApiService['createSkill']> {
    const { userId } = requireSession(request);

    return this.service.createSkill(userId, body);
  }

  @Get('skills/:skillId')
  getSkill(
    @Param('skillId') skillId: string,
    @Req() request: SessionRequest,
  ): ReturnType<ApiService['getSkill']> {
    const { userId } = requireSession(request);

    return this.service.getSkill(userId, skillId);
  }

  @Post('skills/:skillId/attach')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SessionCsrfGuard)
  attachSkill(
    @Param('skillId') skillId: string,
    @Body() body: unknown,
    @Req() request: SessionRequest,
  ): ReturnType<ApiService['attachSkill']> {
    const { userId } = requireSession(request);

    return this.service.attachSkill(userId, skillId, body);
  }

  @Post('skills/:skillId/detach')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SessionCsrfGuard)
  detachSkill(
    @Param('skillId') skillId: string,
    @Req() request: SessionRequest,
  ): ReturnType<ApiService['detachSkill']> {
    const { userId } = requireSession(request);

    return this.service.detachSkill(userId, skillId);
  }

  // --- Search -----------------------------------------------------------

  @Get('search')
  searchMessages(
    @Req() request: SessionRequest,
    @Query('q') q: unknown,
    @Query('botId') botId: unknown,
    @Query('limit') limit: unknown,
    @Query('cursor') cursor: unknown,
  ): ReturnType<ApiService['searchMessages']> {
    const { userId } = requireSession(request);

    if (typeof q !== 'string' || q.length === 0) {
      throw new PersistenceValidationError('invalid_input');
    }

    const parsedBotId = readOptionalString(botId);
    const parsedLimit = readLimit(limit);
    const parsedCursor = readCursor(cursor);

    return this.service.searchMessages(userId, {
      query: q,
      ...(parsedBotId === undefined ? {} : { botId: parsedBotId }),
      ...(parsedLimit === undefined ? {} : { limit: parsedLimit }),
      ...(parsedCursor === undefined ? {} : { cursor: parsedCursor }),
    });
  }
}
