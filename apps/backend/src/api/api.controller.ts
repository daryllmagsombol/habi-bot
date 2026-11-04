/**
 * HTTP surface for the P1 chat UI (H-018). Composition only, not new policy.
 *
 * Enabled only with `HABI_P1_API=1`; `AppModule` does not import the module
 * otherwise, so none of these routes exist in the default app.
 *
 * Every route requires a real H-017 session (`SessionAuthGuard`); mutations also
 * require the synchronizer CSRF token and same-origin check
 * (`SessionCsrfGuard`). The actor id is read from the validated session record,
 * never from a path/query/body field. Unknown, foreign, malformed, and
 * tombstoned ids all return the same `404 not_found`.
 *
 * Route table:
 *
 *   GET  /api/bots
 *   GET  /api/bots/:botId
 *   GET  /api/bots/:botId/threads
 *   GET  /api/threads/:threadId/messages
 *   POST /api/threads/:threadId/messages
 *   GET  /api/runs/:runId/events
 *   POST /api/runs/:runId/cancel
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { UsageLimitError, usageLimitErrorBody } from '../limits/index.js';
import { SSE_MAX_CONNECTION_MS, readSseHeartbeatMs } from './api-config.js';
import { ApiErrorFilter } from './api-errors.js';
import type {
  ApiService,
  BotListPage,
  PostMessageResult,
} from './api-service.js';
import { ApiRuntime } from './api-runtime.js';
import {
  eventChunk,
  gapChunk,
  heartbeatChunk,
  readResumeAfterSeq,
  writeChunk,
} from './api-sse.js';
import type { BotDetail } from './api-projection.js';
import type { BotThreadPage, ListBotThreadsOptions } from './api-repository.js';
import type { BotStatus } from '../bots/types.js';
import {
  PersistenceNotFoundError,
  PersistenceValidationError,
} from '../persistence/errors.js';
import { normalizeLimit } from '../persistence/pagination.js';
import type { ListMessagesOptions } from '../persistence/types.js';
import { SessionAuthGuard } from '../session/session-auth.guard.js';
import { SessionCsrfGuard } from '../session/session-csrf.guard.js';
import { requireSession, type SessionRequest } from '../session/session-request.js';
import type { RunView } from '../runs/types.js';

function readOptionalString(
  value: unknown,
  code: 'invalid_input' | 'invalid_cursor',
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string' || value.length === 0) {
    throw new PersistenceValidationError(code);
  }

  return value;
}

function readLimit(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new PersistenceValidationError('invalid_input');
  }

  const limit = Number(value);

  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new PersistenceValidationError('invalid_input');
  }

  return normalizeLimit(limit);
}

function readStatus(value: unknown): BotStatus | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value !== 'active' && value !== 'archived') {
    throw new PersistenceValidationError('invalid_input');
  }

  return value;
}

@Controller('api')
@UseGuards(SessionAuthGuard)
@UseFilters(ApiErrorFilter)
export class ApiController {
  constructor(@Inject(ApiRuntime) private readonly runtime: ApiRuntime) {}

  @Get('bots')
  async listBots(
    @Req() request: SessionRequest,
    @Query('limit') limit: unknown,
    @Query('cursor') cursor: unknown,
    @Query('status') status: unknown,
  ): Promise<BotListPage> {
    const { userId } = requireSession(request);
    const service = this.runtime.getService();
    const parsedLimit = readLimit(limit);
    const parsedCursor = readOptionalString(cursor, 'invalid_cursor');
    const parsedStatus = readStatus(status);

    return service.listBots(userId, {
      ...(parsedLimit === undefined ? {} : { limit: parsedLimit }),
      ...(parsedCursor === undefined ? {} : { cursor: parsedCursor }),
      ...(parsedStatus === undefined ? {} : { status: parsedStatus }),
    });
  }

  @Get('bots/:botId')
  async getBot(
    @Param('botId') botId: string,
    @Req() request: SessionRequest,
  ): Promise<BotDetail> {
    const { userId } = requireSession(request);

    return this.runtime.getService().getBot(userId, botId);
  }

  @Get('bots/:botId/threads')
  async listThreads(
    @Param('botId') botId: string,
    @Req() request: SessionRequest,
    @Query('limit') limit: unknown,
    @Query('cursor') cursor: unknown,
  ): Promise<BotThreadPage> {
    const { userId } = requireSession(request);
    const parsedLimit = readLimit(limit);
    const parsedCursor = readOptionalString(cursor, 'invalid_cursor');
    const options: ListBotThreadsOptions = {
      ...(parsedLimit === undefined ? {} : { limit: parsedLimit }),
      ...(parsedCursor === undefined ? {} : { cursor: parsedCursor }),
    };

    return this.runtime.getService().listThreads(userId, botId, options);
  }

  @Get('threads/:threadId/messages')
  listMessages(
    @Param('threadId') threadId: string,
    @Req() request: SessionRequest,
    @Query('limit') limit: unknown,
    @Query('before') before: unknown,
    @Query('after') after: unknown,
  ): ReturnType<ApiService['listMessages']> {
    const { userId } = requireSession(request);
    const parsedLimit = readLimit(limit);
    const parsedBefore = readOptionalString(before, 'invalid_cursor');
    const parsedAfter = readOptionalString(after, 'invalid_cursor');
    const options: ListMessagesOptions = {
      ...(parsedLimit === undefined ? {} : { limit: parsedLimit }),
      ...(parsedBefore === undefined ? {} : { beforeCursor: parsedBefore }),
      ...(parsedAfter === undefined ? {} : { afterCursor: parsedAfter }),
    };

    return this.runtime.getService().listMessages(userId, threadId, options);
  }

  @Post('threads/:threadId/messages')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(SessionCsrfGuard)
  async postMessage(
    @Param('threadId') threadId: string,
    @Body() body: unknown,
    @Req() request: SessionRequest,
  ): Promise<PostMessageResult> {
    const { userId } = requireSession(request);

    try {
      return await this.runtime.getService().postMessage(userId, threadId, body);
    } catch (error) {
      // Allowance refusal keeps the H-023 vocabulary and status (`429` for
      // exhaustion, `409` for an unreconciled bucket). It is a recoverable
      // admission outcome, not an internal failure.
      if (error instanceof UsageLimitError) {
        throw new HttpException(usageLimitErrorBody(error), error.status);
      }

      throw error;
    }
  }

  @Post('runs/:runId/cancel')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SessionCsrfGuard)
  async cancelRun(
    @Param('runId') runId: string,
    @Req() request: SessionRequest,
  ): Promise<{ run: RunView }> {
    const { userId } = requireSession(request);

    return { run: await this.runtime.getService().cancelRun(userId, runId) };
  }

  /**
   * SSE replay plus live delivery. Ownership is resolved before any header is
   * written, so a foreign/unknown Run is a normal 404 envelope rather than a
   * half-open event stream. From then on, failures end the response.
   */
  @Get('runs/:runId/events')
  async streamRunEvents(
    @Param('runId') runId: string,
    @Req() request: SessionRequest,
    @Res() response: Response,
  ): Promise<void> {
    const { userId } = requireSession(request);
    const service = this.runtime.getService();
    const position = await service.events.loadPosition(userId, runId);
    const afterSeq = readResumeAfterSeq(request, runId);

    // A cursor beyond this Run's stream cannot have come from it.
    if (afterSeq > position.lastEventSeq) {
      throw new PersistenceNotFoundError();
    }

    response.status(HttpStatus.OK);
    response.setHeader('content-type', 'text/event-stream; charset=utf-8');
    response.setHeader('cache-control', 'no-store');
    response.setHeader('connection', 'keep-alive');
    response.setHeader('x-accel-buffering', 'no');
    response.flushHeaders();

    const abort = new AbortController();
    const onClose = (): void => {
      abort.abort();
    };

    response.once('close', onClose);

    const subscription = service.createStream().subscribe({
      actorUserId: userId,
      runId,
      afterSeq,
      signal: abort.signal,
    });

    const heartbeat = setInterval(() => {
      if (!response.writableEnded) {
        void writeChunk(response, heartbeatChunk());
      }
    }, readSseHeartbeatMs());
    heartbeat.unref();

    const deadline = setTimeout(() => {
      abort.abort();
    }, SSE_MAX_CONNECTION_MS);
    deadline.unref();

    try {
      for await (const item of subscription) {
        if (response.writableEnded || abort.signal.aborted) {
          break;
        }

        await writeChunk(
          response,
          item.kind === 'event' ? eventChunk(item) : gapChunk(item),
        );
      }
    } catch {
      // Ownership was already proven; a late transport/read failure just ends
      // this connection. The client reconnects with Last-Event-ID.
    } finally {
      clearInterval(heartbeat);
      clearTimeout(deadline);
      response.off('close', onClose);

      if (!response.writableEnded) {
        response.end();
      }
    }
  }
}
