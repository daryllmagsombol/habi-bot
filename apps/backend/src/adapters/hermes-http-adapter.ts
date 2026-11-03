/**
 * Hermes HTTP harness adapter for H-021 (#21), first slice.
 *
 * Implements the framework-free `HarnessAdapter` contract against the pinned
 * Hermes API-server surface (design §3):
 *
 *   POST /v1/runs                     create (202, idempotent replay)
 *   GET  /v1/runs/{run_id}            status + usage
 *   GET  /v1/runs/{run_id}/events     SSE stream
 *   POST /v1/runs/{run_id}/steer      text-only steer
 *   POST /v1/runs/{run_id}/stop       cancel
 *
 * Deliberate boundaries:
 *   - global `fetch` + `AbortSignal` only; no dependencies and no real network
 *     in tests (a local node:http stub stands in);
 *   - the gateway key comes from injected config, is sent only as a bearer
 *     header, and is never logged or added to an error message;
 *   - at most one upstream dispatch per `(ownerUserId, idempotencyKey)`; a
 *     duplicate key returns the same Habi run and performs no second call;
 *   - ambiguous transport outcomes become `dispatchState: "unknown"` with no
 *     automatic retry;
 *   - HTTP 200 with an error finish and 202-then-`failed` are failures;
 *   - usage is `known` / `partial` / `unknown`, and unknown is `null`, never 0.
 *
 * The runId -> harness id mapping is in-memory in this slice. A durable mapping
 * row belongs to the persistence lane; `recoverAfterRestart` therefore only
 * reconciles runs created by this adapter instance. No app, DB, or module
 * wiring is included.
 */
import {
  HarnessAdapterError,
  failureForHttpStatus,
  isTerminalHarnessStatus,
} from './harness-adapter.js';
import {
  classifyHarnessStatus,
  confirmedTerminalOutcome,
  lostOutcome,
  stillRunningOutcome,
} from './recovery.js';
import type {
  CancelRequest,
  CancelResult,
  CreateRunRequest,
  CreateRunResult,
  DispatchState,
  HarnessAdapter,
  HarnessRunStatus,
  Id,
  RecoverAfterRestartInput,
  RecoveryOutcome,
  RecoveryReport,
  RunEvent,
  RunSnapshot,
  RunSnapshotStatus,
  SteerRequest,
  SteerResult,
  SubscribeRequest,
  SubscribeResult,
  UsageRecord,
  UsageStatus,
} from './harness-adapter.js';

export interface HermesHttpAdapterConfig {
  /** API-server origin, e.g. `http://127.0.0.1:8651`. */
  readonly baseUrl: string;
  /** Hermes gateway credential. Never logged, never returned to a client. */
  readonly gatewayKey: string;
  /** Bound for a single create/status/cancel/steer request. */
  readonly requestTimeoutMs?: number;
  /** Idle bound between SSE chunks. */
  readonly eventIdleTimeoutMs?: number;
  /** Injected clock for deterministic accepted/created timestamps. */
  readonly now?: () => number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_EVENT_IDLE_TIMEOUT_MS = 30_000;

const PRE_WRITE_ERROR_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

const TERMINAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  'run.completed',
  'run.failed',
  'run.cancelled',
]);

interface RunMapping {
  readonly runId: string;
  readonly ownerUserId: string;
  readonly conversationId: string;
  readonly botId: string;
  harnessSessionId: string | null;
  harnessRunId: string | null;
  dispatchState: DispatchState;
  harnessStatus: HarnessRunStatus | null;
  lastSeq: number;
  version: number;
  terminal: boolean;
}

interface IdempotencyEntry {
  readonly fingerprint: string;
  readonly result: Promise<CreateRunResult>;
}

interface ParsedEvent {
  readonly seq: number;
  readonly event: RunEvent;
}

interface BuiltRequest {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly body?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

interface JsonExchange {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
}

export class HermesHttpAdapter implements HarnessAdapter {
  private readonly baseUrl: string;
  private readonly gatewayKey: string;
  private readonly requestTimeoutMs: number;
  private readonly eventIdleTimeoutMs: number;
  private readonly now: () => number;
  private readonly mappings = new Map<string, RunMapping>();
  private readonly idempotency = new Map<string, IdempotencyEntry>();
  private readonly appliedSeq = new Map<string, number>();
  private readonly inflight = new Set<AbortController>();
  private closed = false;

  constructor(config: HermesHttpAdapterConfig) {
    const baseUrl = config.baseUrl.trim().replace(/\/+$/, '');

    if (!/^https?:\/\/[^/]+/i.test(baseUrl)) {
      throw new HarnessAdapterError('invalid_request', 'not_dispatched', {
        message: 'hermes baseUrl must be an http(s) origin',
      });
    }

    if (config.gatewayKey.trim().length === 0) {
      throw new HarnessAdapterError('auth_rejected', 'not_dispatched', {
        message: 'hermes gateway key is not configured',
      });
    }

    this.baseUrl = baseUrl;
    this.gatewayKey = config.gatewayKey;
    this.requestTimeoutMs = positive(config.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
    this.eventIdleTimeoutMs = positive(
      config.eventIdleTimeoutMs,
      DEFAULT_EVENT_IDLE_TIMEOUT_MS,
    );
    this.now = config.now ?? Date.now;
  }

  async createRun(req: CreateRunRequest): Promise<CreateRunResult> {
    this.assertOpen();
    this.validateCreateRequest(req);

    const existingMapping = this.mappings.get(req.runId);

    if (existingMapping !== undefined && existingMapping.ownerUserId !== req.ownerUserId) {
      throw new HarnessAdapterError('policy_denied', 'not_dispatched', {
        message: 'run ownership does not match the persisted run',
      });
    }

    const key = `${req.ownerUserId}\u0000${req.idempotencyKey}`;
    const fingerprint = fingerprintCreateRequest(req);
    const existing = this.idempotency.get(key);

    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        throw new HarnessAdapterError('idempotency_conflict', 'not_dispatched', {
          message: 'idempotency key was already used with a different request',
        });
      }

      const result = await existing.result;

      return { ...result, deduplicated: true };
    }

    const entry: IdempotencyEntry = {
      fingerprint,
      result: this.dispatchCreateRun(req),
    };

    this.idempotency.set(key, entry);

    return entry.result;
  }

  subscribe(req: SubscribeRequest): SubscribeResult {
    return this.streamEvents(req);
  }

  async cancel(req: CancelRequest): Promise<CancelResult> {
    this.assertOpen();
    const mapping = this.requireMapping(req.runId);

    if (mapping.terminal && mapping.harnessStatus !== null) {
      return {
        runId: mapping.runId as Id<'Run'>,
        status: toTerminalStatus(mapping.harnessStatus),
        dispatchState: mapping.dispatchState,
      };
    }

    const harnessRunId = this.requireHarnessRunId(mapping);
    const response = await this.sendJson({
      method: 'POST',
      path: `/v1/runs/${encodeURIComponent(harnessRunId)}/stop`,
      body: JSON.stringify({ reason: req.reason }),
      headers: { 'content-type': 'application/json' },
    });

    if (!response.ok) {
      throw failureForHttpStatus(response.status, mapping.dispatchState);
    }

    const body = response.body;
    const status = this.resolveHarnessStatus(body);

    if (status === 'waiting_for_approval') {
      throw new HarnessAdapterError('policy_denied', 'dispatched', {
        message: 'harness requires approval, which the no-tool POC does not grant',
        httpStatus: response.status,
      });
    }

    this.recordStatus(mapping, status);

    if (status !== null && isTerminalHarnessStatus(status)) {
      return {
        runId: mapping.runId as Id<'Run'>,
        status: toTerminalStatus(status),
        dispatchState: mapping.dispatchState,
      };
    }

    // `stopping`, `queued`, or `running` all mean the stop request was
    // accepted but the run is not terminal yet.
    return {
      runId: mapping.runId as Id<'Run'>,
      status: 'cancelling',
      dispatchState: mapping.dispatchState,
    };
  }

  async steer(req: SteerRequest): Promise<SteerResult> {
    this.assertOpen();
    const mapping = this.requireMapping(req.runId);

    if (mapping.terminal) {
      return { accepted: false, reason: 'already_terminal' };
    }

    if (req.text.trim().length === 0) {
      return { accepted: false, reason: 'rejected_by_harness' };
    }

    const harnessRunId = this.requireHarnessRunId(mapping);
    const response = await this.sendJson({
      method: 'POST',
      path: `/v1/runs/${encodeURIComponent(harnessRunId)}/steer`,
      body: JSON.stringify({ text: req.text, client_steer_id: req.clientSteerId }),
      headers: { 'content-type': 'application/json' },
    });

    if (response.status === 404 || response.status === 409) {
      return { accepted: false, reason: 'not_running' };
    }

    if (response.status === 400 || response.status === 422) {
      return { accepted: false, reason: 'rejected_by_harness' };
    }

    if (!response.ok) {
      throw failureForHttpStatus(response.status, mapping.dispatchState);
    }

    const body = response.body;
    const accepted = readBoolean(body, ['accepted']) === true;

    if (accepted) {
      // Observed on the pinned harness: accepted but not applied. The adapter
      // reports the acknowledgement; product code must not present steering as
      // a working control until a configuration demonstrates the effect.
      return { accepted: true };
    }

    return { accepted: false, reason: 'rejected_by_harness' };
  }

  async getRun(runId: Id<'Run'>): Promise<RunSnapshot> {
    this.assertOpen();
    const { mapping, body } = await this.fetchRunBody(runId);
    const harnessStatus = this.resolveHarnessStatus(body) ?? mapping.harnessStatus;

    if (harnessStatus === null) {
      throw new HarnessAdapterError('provider_error', mapping.dispatchState, {
        message: 'harness run status was missing or unrecognized',
      });
    }

    if (harnessStatus === 'waiting_for_approval') {
      this.recordStatus(mapping, harnessStatus);
      throw new HarnessAdapterError('policy_denied', 'dispatched', {
        message: 'harness requires approval, which the no-tool POC does not grant',
      });
    }

    const snapshot = this.snapshotFor(mapping, body, harnessStatus);
    this.recordStatus(mapping, harnessStatus);

    return snapshot;
  }

  async getUsage(runId: Id<'Run'>): Promise<UsageRecord> {
    this.assertOpen();
    const { body } = await this.fetchRunBody(runId);
    const statusSource = statusEnvelope(body);
    const usage = isRecord(statusSource.usage) ? statusSource.usage : null;

    return toUsageRecord(runId, usage);
  }

  async recoverAfterRestart(input: RecoverAfterRestartInput): Promise<RecoveryReport> {
    this.assertOpen();
    const outcomes: RecoveryOutcome[] = [];

    for (const runId of input.runIds) {
      const mapping = this.mappings.get(runId);

      if (mapping === undefined || mapping.harnessRunId === null) {
        outcomes.push(
          lostOutcome(runId, mapping?.dispatchState ?? 'unknown'),
        );
        continue;
      }

      try {
        const { body } = await this.fetchRunBody(runId);
        const harnessStatus = this.resolveHarnessStatus(body);

        if (harnessStatus === null) {
          outcomes.push(lostOutcome(runId, 'unknown'));
          continue;
        }

        if (harnessStatus === 'waiting_for_approval') {
          const snapshot = this.snapshotFor(mapping, body, harnessStatus);
          this.recordStatus(mapping, 'failed');
          outcomes.push(confirmedTerminalOutcome(runId, snapshot));
          continue;
        }

        const classification = classifyHarnessStatus(harnessStatus);

        if (classification === 'confirmed_terminal') {
          const snapshot = this.snapshotFor(mapping, body, harnessStatus);
          this.recordStatus(mapping, harnessStatus);
          outcomes.push(confirmedTerminalOutcome(runId, snapshot));
          continue;
        }

        if (classification === 'still_running') {
          const snapshot = this.snapshotFor(mapping, body, harnessStatus);
          this.recordStatus(mapping, harnessStatus);
          outcomes.push(
            stillRunningOutcome(runId, snapshot, mapping.lastSeq),
          );
          continue;
        }

        outcomes.push(lostOutcome(runId, 'unknown'));
      } catch (error) {
        if (error instanceof HarnessAdapterError) {
          if (error.code === 'auth_rejected') {
            throw error;
          }

          if (error.httpStatus === 404) {
            outcomes.push(lostOutcome(runId, mapping.dispatchState));
            continue;
          }
        }

        outcomes.push(lostOutcome(runId, 'unknown'));
      }
    }

    return {
      recoveredAt: new Date(this.now()).toISOString(),
      outcomes,
    };
  }

  async close(): Promise<void> {
    this.closed = true;

    for (const controller of this.inflight) {
      controller.abort();
    }

    this.inflight.clear();
  }

  private async dispatchCreateRun(req: CreateRunRequest): Promise<CreateRunResult> {
    const response = await this.sendJson({
      method: 'POST',
      path: '/v1/runs',
      body: JSON.stringify(createRequestBody(req)),
      headers: {
        'content-type': 'application/json',
        'idempotency-key': req.idempotencyKey,
        'x-habi-run-id': req.runId,
        'x-habi-owner-user-id': req.ownerUserId,
        'x-habi-conversation-id': req.conversationId,
        'x-habi-bot-id': req.botId,
        'x-habi-correlation-id': req.correlationId,
      },
    });

    if (!response.ok) {
      throw failureForHttpStatus(response.status, 'not_dispatched');
    }

    const body = response.body;
    const statusSource = statusEnvelope(body);
    const harnessRunId = readString(statusSource, ['run_id', 'runId', 'id']);

    if (harnessRunId === null) {
      // A success status with no run id cannot be reconciled and may have
      // dispatched work; it is ambiguous, not a clean failure.
      throw new HarnessAdapterError('provider_error', 'unknown', {
        message: 'harness create response did not include a run id',
        httpStatus: response.status,
      });
    }

    const replayedHeader = response.headers.get('idempotency-replayed');
    const deduplicated =
      isTruthyHeader(replayedHeader) || readBoolean(statusSource, ['replayed']) === true;
    const harnessStatus = this.resolveHarnessStatus(body);
    const acceptedAt = new Date(this.now()).toISOString();
    const mapping: RunMapping = {
      runId: req.runId,
      ownerUserId: req.ownerUserId,
      conversationId: req.conversationId,
      botId: req.botId,
      harnessSessionId: readString(statusSource, ['session_id', 'sessionId']),
      harnessRunId,
      dispatchState: 'dispatched',
      harnessStatus,
      lastSeq: 0,
      version: 0,
      terminal: harnessStatus !== null && isTerminalHarnessStatus(harnessStatus),
    };

    this.mappings.set(req.runId, mapping);

    return {
      runId: req.runId,
      harnessSessionId: mapping.harnessSessionId,
      harnessRunId,
      dispatchState: 'dispatched',
      deduplicated,
      acceptedAt,
    };
  }

  private async *streamEvents(req: SubscribeRequest): AsyncGenerator<RunEvent> {
    this.assertOpen();
    const mapping = this.requireMapping(req.runId);
    const harnessRunId = this.requireHarnessRunId(mapping);
    const afterSeq =
      Number.isFinite(req.afterSeq) && req.afterSeq > 0 ? Math.floor(req.afterSeq) : 0;
    let lastApplied =
      this.appliedSeq.get(req.runId) ?? (afterSeq > 0 ? afterSeq : -1);

    const controller = new AbortController();
    let timedOut = false;
    let externallyAborted = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

    const arm = (ms: number): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }

      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, ms);
    };

    const onAbort = (): void => {
      externallyAborted = true;
      controller.abort();
    };

    req.signal?.addEventListener('abort', onAbort, { once: true });
    this.inflight.add(controller);

    try {
      arm(this.requestTimeoutMs);
      const response = await fetch(
        `${this.baseUrl}/v1/runs/${encodeURIComponent(harnessRunId)}/events?after_seq=${afterSeq}`,
        {
          method: 'GET',
          headers: this.headers({
            accept: 'text/event-stream',
            'cache-control': 'no-cache',
          }),
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        await drain(response);
        throw failureForHttpStatus(response.status, mapping.dispatchState);
      }

      if (response.body === null) {
        throw new HarnessAdapterError('provider_error', mapping.dispatchState, {
          message: 'harness events response had no body',
        });
      }

      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let eventName: string | undefined;
      let dataLines: string[] = [];
      let sawTerminal = false;

      arm(this.eventIdleTimeoutMs);

      while (!sawTerminal) {
        const chunk = await reader.read();

        if (chunk.done) {
          break;
        }

        arm(this.eventIdleTimeoutMs);
        buffer += decoder.decode(chunk.value, { stream: true });

        while (buffer.includes('\n')) {
          const newline = buffer.indexOf('\n');
          let line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);

          if (line.endsWith('\r')) {
            line = line.slice(0, -1);
          }

          if (line === '') {
            const parsed = parseEvent(mapping, eventName, dataLines, lastApplied, this.now);
            eventName = undefined;
            dataLines = [];

            if (parsed === null) {
              continue;
            }

            const next = applyEvent(parsed, lastApplied);

            if (next === null) {
              continue;
            }

            lastApplied = next.seq;
            this.appliedSeq.set(req.runId, next.seq);
            recordSeq(mapping, next.seq);
            yield next.event;

            if (TERMINAL_EVENT_TYPES.has(next.event.type)) {
              sawTerminal = true;
              break;
            }

            continue;
          }

          if (line.startsWith(':')) {
            continue;
          }

          if (line.startsWith('event:')) {
            eventName = line.slice('event:'.length).trim();
            continue;
          }

          if (line.startsWith('data:')) {
            dataLines.push(line.slice('data:'.length).replace(/^ /, ''));
          }
        }
      }

      // A well-formed stream ends an event with a blank line. Flush any
      // remainder so a truncated final event is not silently dropped.
      if (!sawTerminal && dataLines.length > 0) {
        const parsed = parseEvent(mapping, eventName, dataLines, lastApplied, this.now);

        if (parsed !== null) {
          const next = applyEvent(parsed, lastApplied);

          if (next !== null) {
            this.appliedSeq.set(req.runId, next.seq);
            recordSeq(mapping, next.seq);
            yield next.event;
          }
        }
      }
    } catch (error) {
      throw this.toAdapterError(error, timedOut, externallyAborted);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }

      req.signal?.removeEventListener('abort', onAbort);
      this.inflight.delete(controller);

      try {
        await reader?.cancel();
      } catch {
        // The stream is already closed; nothing to release.
      }
    }
  }

  private async fetchRunBody(
    runId: Id<'Run'>,
  ): Promise<{ mapping: RunMapping; body: Record<string, unknown> }> {
    const mapping = this.requireMapping(runId);
    const harnessRunId = this.requireHarnessRunId(mapping);
    const response = await this.sendJson({
      method: 'GET',
      path: `/v1/runs/${encodeURIComponent(harnessRunId)}`,
    });

    if (response.status === 404) {
      throw new HarnessAdapterError('provider_error', 'unknown', {
        message: 'harness run was not found',
        httpStatus: 404,
      });
    }

    if (!response.ok) {
      throw failureForHttpStatus(response.status, mapping.dispatchState);
    }

    return { mapping, body: response.body };
  }

  private snapshotFor(
    mapping: RunMapping,
    body: Record<string, unknown>,
    harnessStatus: HarnessRunStatus,
  ): RunSnapshot {
    const statusSource = statusEnvelope(body);
    const lastSeq =
      readNumber(statusSource, ['last_seq', 'lastSeq']) ?? mapping.lastSeq;
    const version =
      readNumber(statusSource, ['version']) ?? mapping.version + 1;

    mapping.version = version;

    return {
      runId: mapping.runId as Id<'Run'>,
      status: toSnapshotStatus(harnessStatus),
      harnessStatus,
      lastSeq,
      version,
    };
  }

  private resolveHarnessStatus(body: Record<string, unknown>): HarnessRunStatus | null {
    const source = statusEnvelope(body);
    const rawStatus = readString(source, ['status', 'state']);
    const harnessStatus = rawStatus === null ? null : normalizeHarnessStatus(rawStatus);
    const errorFinish = isErrorFinish(source);

    if (errorFinish && harnessStatus !== 'cancelled') {
      return 'failed';
    }

    if (harnessStatus !== null) {
      return harnessStatus;
    }

    const lastEvent = readString(source, ['last_event', 'lastEvent']);

    if (lastEvent === 'run.failed') {
      return 'failed';
    }

    if (lastEvent === 'run.completed') {
      return 'completed';
    }

    if (lastEvent === 'run.cancelled') {
      return 'cancelled';
    }

    return null;
  }

  private recordStatus(mapping: RunMapping, status: HarnessRunStatus | null): void {
    mapping.harnessStatus = status;

    if (status !== null) {
      mapping.terminal = isTerminalHarnessStatus(status);
    }
  }

  /**
   * Performs one JSON exchange inside a single bound. Reading the body happens
   * before the timer is cleared, so a response that stalls after its headers
   * still times out.
   */
  private async sendJson(req: BuiltRequest): Promise<JsonExchange> {
    const controller = new AbortController();
    let timedOut = false;
    let externallyAborted = false;

    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.requestTimeoutMs);

    const onAbort = (): void => {
      externallyAborted = true;
      controller.abort();
    };

    req.signal?.addEventListener('abort', onAbort, { once: true });
    this.inflight.add(controller);

    try {
      const response = await fetch(`${this.baseUrl}${req.path}`, {
        method: req.method,
        headers: this.headers(req.headers),
        ...(req.body === undefined ? {} : { body: req.body }),
        signal: controller.signal,
      });
      const text = await response.text();

      return {
        status: response.status,
        ok: response.ok,
        headers: response.headers,
        body: parseJsonRecord(text),
      };
    } catch (error) {
      throw this.toAdapterError(error, timedOut, externallyAborted);
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onAbort);
      this.inflight.delete(controller);
    }
  }

  private headers(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
    return {
      authorization: `Bearer ${this.gatewayKey}`,
      accept: 'application/json',
      ...extra,
    };
  }

  private validateCreateRequest(req: CreateRunRequest): void {
    if (req.allowedTools.length > 0) {
      throw new HarnessAdapterError('policy_denied', 'not_dispatched', {
        message: 'the no-tool POC rejects a non-empty allowedTools list',
      });
    }

    if (!isNonEmpty(req.runId) || !isNonEmpty(req.idempotencyKey)) {
      throw new HarnessAdapterError('invalid_request', 'not_dispatched', {
        message: 'runId and idempotencyKey are required',
      });
    }

    if (
      !isNonEmpty(req.ownerUserId) ||
      !isNonEmpty(req.conversationId) ||
      !isNonEmpty(req.botId)
    ) {
      throw new HarnessAdapterError('invalid_request', 'not_dispatched', {
        message: 'owner, conversation, and bot identity are required',
      });
    }

    if (!isNonEmpty(req.deadlineAt) || Number.isNaN(Date.parse(req.deadlineAt))) {
      throw new HarnessAdapterError('invalid_request', 'not_dispatched', {
        message: 'deadlineAt must be an ISO-8601 timestamp',
      });
    }

    if (
      !Number.isFinite(req.tokenBudget.maxInputTokens) ||
      req.tokenBudget.maxInputTokens < 0 ||
      (req.tokenBudget.maxOutputTokens !== null &&
        (!Number.isFinite(req.tokenBudget.maxOutputTokens) ||
          req.tokenBudget.maxOutputTokens < 0))
    ) {
      throw new HarnessAdapterError('invalid_request', 'not_dispatched', {
        message: 'tokenBudget values must be non-negative numbers',
      });
    }
  }

  private requireMapping(runId: string): RunMapping {
    const mapping = this.mappings.get(runId);

    if (mapping === undefined) {
      throw new HarnessAdapterError('invalid_request', 'not_dispatched', {
        message: 'run is not known to this adapter instance',
      });
    }

    return mapping;
  }

  private requireHarnessRunId(mapping: RunMapping): string {
    if (mapping.harnessRunId === null) {
      throw new HarnessAdapterError('provider_error', mapping.dispatchState, {
        message: 'run has no harness run id yet',
      });
    }

    return mapping.harnessRunId;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new HarnessAdapterError('harness_unavailable', 'not_dispatched', {
        message: 'adapter is closed',
      });
    }
  }

  private toAdapterError(
    error: unknown,
    timedOut: boolean,
    externallyAborted: boolean,
  ): HarnessAdapterError {
    if (error instanceof HarnessAdapterError) {
      return error;
    }

    if (timedOut) {
      return new HarnessAdapterError('timeout', 'unknown', {
        message: 'harness request timed out',
      });
    }

    if (externallyAborted) {
      return new HarnessAdapterError('transport_ambiguous', 'unknown', {
        message: 'harness request was aborted by the caller',
      });
    }

    const code = readErrorCode(error);

    if (code !== null && PRE_WRITE_ERROR_CODES.has(code)) {
      return new HarnessAdapterError('harness_unavailable', 'not_dispatched', {
        message: 'harness could not be reached before the request was written',
      });
    }

    return new HarnessAdapterError('transport_ambiguous', 'unknown', {
      message: 'harness transport failed after the request may have been written',
    });
  }
}

function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function isNonEmpty(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function createRequestBody(req: CreateRunRequest): Record<string, unknown> {
  return {
    run_id: req.runId,
    messages: req.messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    metadata: {
      correlation_id: req.correlationId,
      owner_user_id: req.ownerUserId,
      conversation_id: req.conversationId,
      bot_id: req.botId,
      deadline_at: req.deadlineAt,
    },
  };
}

function fingerprintCreateRequest(req: CreateRunRequest): string {
  return JSON.stringify({
    runId: req.runId,
    ownerUserId: req.ownerUserId,
    conversationId: req.conversationId,
    botId: req.botId,
    messages: req.messages.map((message) => [
      message.role,
      message.content,
      message.messageId,
    ]),
    deadlineAt: req.deadlineAt,
    maxInputTokens: req.tokenBudget.maxInputTokens,
    maxOutputTokens: req.tokenBudget.maxOutputTokens,
    allowedTools: [...req.allowedTools],
  });
}

export function toUsageRecord(
  runId: Id<'Run'>,
  usage: Record<string, unknown> | null,
): UsageRecord {
  if (usage === null) {
    return {
      runId,
      usageStatus: 'unknown',
      grossPromptTokens: null,
      grossCompletionTokens: null,
      cachedPromptTokens: null,
      reasoningTokens: null,
      totalTokens: null,
      costStatus: 'unknown',
      raw: {},
    };
  }

  const input = firstNumber(usage, ['input_tokens', 'inputTokens', 'prompt_tokens']);
  const output = firstNumber(usage, ['output_tokens', 'outputTokens', 'completion_tokens']);
  const reportedTotal = firstNumber(usage, ['total_tokens', 'totalTokens']);
  const cachedPrompt = firstNumber(usage, [
    'cache_read_tokens',
    'cacheReadTokens',
    'cached_tokens',
    'cachedPromptTokens',
  ]);
  const reasoning = firstNumber(usage, ['reasoning_tokens', 'reasoningTokens']);

  let usageStatus: UsageStatus;
  let total: number | null = reportedTotal;

  if (input === null && output === null) {
    usageStatus = 'unknown';
  } else if (input !== null && output !== null) {
    if (reportedTotal === null) {
      // The sum is defensible but was not reported, so the record is partial.
      total = input + output;
      usageStatus = 'partial';
    } else if (reportedTotal !== input + output) {
      usageStatus = 'unknown';
      total = null;
    } else {
      usageStatus = 'known';
    }
  } else {
    usageStatus = 'partial';
  }

  const known = usageStatus !== 'unknown';

  return {
    runId,
    usageStatus,
    grossPromptTokens: known ? input : null,
    grossCompletionTokens: known ? output : null,
    cachedPromptTokens: known ? cachedPrompt : null,
    reasoningTokens: known ? reasoning : null,
    totalTokens: known ? total : null,
    costStatus: 'unknown',
    raw: usage,
  };
}

function parseEvent(
  mapping: RunMapping,
  eventName: string | undefined,
  dataLines: readonly string[],
  lastApplied: number,
  now: () => number,
): ParsedEvent | null {
  if (dataLines.length === 0) {
    return null;
  }

  const data = dataLines.join('\n').trim();

  if (data.length === 0 || data === '[DONE]') {
    return null;
  }

  let payload: Record<string, unknown>;

  try {
    const parsed: unknown = JSON.parse(data);

    if (!isRecord(parsed)) {
      return null;
    }

    payload = parsed;
  } catch {
    return null;
  }

  const seq = readNumber(payload, ['seq']);

  if (seq === null || !Number.isInteger(seq) || seq < 0 || seq <= lastApplied) {
    return null;
  }

  const type =
    readString(payload, ['type']) ?? eventName ?? 'message.delta';
  const createdAt =
    readString(payload, ['created_at', 'createdAt', 'at']) ??
    new Date(now()).toISOString();

  return {
    seq,
    event: {
      id: `${mapping.runId}:${seq}`,
      runId: mapping.runId as Id<'Run'>,
      ownerUserId: mapping.ownerUserId as Id<'User'>,
      conversationId: mapping.conversationId as Id<'Conversation'>,
      seq,
      type,
      payload,
      createdAt,
    },
  };
}

function applyEvent(parsed: ParsedEvent, lastApplied: number): ParsedEvent | null {
  return parsed.seq <= lastApplied ? null : parsed;
}

function recordSeq(mapping: RunMapping, seq: number): void {
  if (seq > mapping.lastSeq) {
    mapping.lastSeq = seq;
  }
}

function statusEnvelope(body: Record<string, unknown>): Record<string, unknown> {
  return isRecord(body.run) ? body.run : body;
}

function isErrorFinish(source: Record<string, unknown>): boolean {
  const finishReason = readString(source, ['finish_reason', 'finishReason']);

  if (finishReason === 'error') {
    return true;
  }

  if (isRecord(source.hermes) && source.hermes.failed === true) {
    return true;
  }

  return source.failed === true;
}

function normalizeHarnessStatus(raw: string): HarnessRunStatus | null {
  const value = raw.trim().toLowerCase().replaceAll('-', '_').replaceAll(' ', '_');

  switch (value) {
    case 'queued':
    case 'pending':
      return 'queued';
    case 'running':
    case 'started':
    case 'in_progress':
      return 'running';
    case 'waiting_for_approval':
    case 'awaiting_approval':
      return 'waiting_for_approval';
    case 'stopping':
      return 'stopping';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    case 'failed':
    case 'error':
      return 'failed';
    case 'completed':
    case 'complete':
    case 'succeeded':
    case 'success':
      return 'completed';
    default:
      return null;
  }
}

function toSnapshotStatus(status: HarnessRunStatus): RunSnapshotStatus {
  switch (status) {
    case 'queued':
      return 'queued';
    case 'running':
    case 'stopping':
      return 'running';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'waiting_for_approval':
      return 'failed';
  }
}

function toTerminalStatus(status: HarnessRunStatus): 'completed' | 'failed' | 'cancelled' {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'failed';
  }
}

function isTruthyHeader(value: string | null): boolean {
  if (value === null) {
    return false;
  }

  const normalized = value.trim().toLowerCase();

  return normalized === 'true' || normalized === '1';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = record[key];

    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }

  return null;
}

function readNumber(
  record: Record<string, unknown>,
  keys: readonly string[],
): number | null {
  for (const key of keys) {
    const value = record[key];

    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }

  return null;
}

function firstNumber(
  record: Record<string, unknown>,
  keys: readonly string[],
): number | null {
  return readNumber(record, keys);
}

function readBoolean(
  record: Record<string, unknown>,
  keys: readonly string[],
): boolean | null {
  for (const key of keys) {
    const value = record[key];

    if (typeof value === 'boolean') {
      return value;
    }
  }

  return null;
}

function readErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) {
    return null;
  }

  const record = error as { code?: unknown; cause?: unknown };

  if (typeof record.code === 'string') {
    return record.code;
  }

  if (record.cause !== undefined) {
    return readErrorCode(record.cause);
  }

  return null;
}

function parseJsonRecord(text: string): Record<string, unknown> {
  if (text.trim().length === 0) {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(text);

    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function drain(response: Response): Promise<void> {
  try {
    await response.text();
  } catch {
    // The body is intentionally discarded; a read failure changes nothing.
  }
}
