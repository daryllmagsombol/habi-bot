/**
 * Spike-only. Not product code. Enabled only when HABI_SPIKE_MODE=1.
 *
 * Minimal two-user run surface used to prove server-side ownership checks and
 * no-tool policy denial. It is not a product API: there is no persistence,
 * queue, harness call, or real authentication.
 *
 * `POST /spike/runs` also returns the fake harness id in the
 * `x-spike-harness-run-id` response header so tests can prove that a harness id
 * is never accepted as a path identifier. Callers cannot derive it otherwise.
 */
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { SpikeAuthGuard, getSpikeUserId } from './spike-auth.guard.js';
import type { SpikeRequest } from './spike-auth.guard.js';
import { SpikeRunsService, toRunView } from './spike-runs.service.js';
import type { SpikeRun, SpikeRunEvent, SpikeRunView } from './spike-runs.service.js';

const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;

function readConversationId(body: unknown): string | undefined {
  if (body === undefined || body === null) {
    return undefined;
  }

  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequestException({ error: { code: 'invalid_request' } });
  }

  const value = (body as Record<string, unknown>).conversationId;

  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string' || !CONVERSATION_ID_PATTERN.test(value)) {
    throw new BadRequestException({ error: { code: 'invalid_request' } });
  }

  return value;
}

@Controller('spike/runs')
@UseGuards(SpikeAuthGuard)
export class SpikeRunsController {
  constructor(@Inject(SpikeRunsService) private readonly runs: SpikeRunsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  createRun(
    @Body() body: unknown,
    @Req() request: SpikeRequest,
    @Res({ passthrough: true }) response: Response,
  ): SpikeRunView {
    const run = this.runs.createRun(getSpikeUserId(request), readConversationId(body));

    response.setHeader('x-spike-harness-run-id', run.harnessRunId);

    return toRunView(run);
  }

  @Get()
  listRuns(@Req() request: SpikeRequest): { runs: SpikeRunView[] } {
    return {
      runs: this.runs.listOwnedRuns(getSpikeUserId(request)).map(toRunView),
    };
  }

  @Get(':runId')
  getRun(@Param('runId') runId: string, @Req() request: SpikeRequest): SpikeRunView {
    return toRunView(this.requireOwnedRun(runId, request));
  }

  @Get(':runId/events')
  getRunEvents(
    @Param('runId') runId: string,
    @Req() request: SpikeRequest,
  ): { events: SpikeRunEvent[] } {
    const run = this.requireOwnedRun(runId, request);
    return { events: [...run.events] };
  }

  @Get(':runId/audit')
  getRunAudit(
    @Param('runId') runId: string,
    @Req() request: SpikeRequest,
  ): { events: SpikeRunEvent[] } {
    const run = this.requireOwnedRun(runId, request);
    return { events: this.runs.listAuditEvents(run) };
  }

  @Post(':runId/tools/:toolName')
  requestTool(
    @Param('runId') runId: string,
    @Param('toolName') toolName: string,
    @Req() request: SpikeRequest,
  ): never {
    const run = this.requireOwnedRun(runId, request);

    this.runs.recordPolicyDenial(run, toolName);

    throw new ForbiddenException({
      error: { code: 'policy_denied', tool: toolName },
    });
  }

  private requireOwnedRun(runId: string, request: SpikeRequest): SpikeRun {
    const run = this.runs.findOwnedRun(runId, getSpikeUserId(request));

    if (run === undefined) {
      throw new NotFoundException({ error: { code: 'not_found' } });
    }

    return run;
  }
}
