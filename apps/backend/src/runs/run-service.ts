/**
 * H-022 (#22) RunService: durable reservation, dispatch, cancellation and
 * restart reconciliation at the service/persistence level.
 *
 * Invariants this class enforces:
 *
 *   - Idempotency is decided by the database unique `(owner, key)`, not by
 *     in-memory state. The first submitter dispatches; every duplicate returns
 *     the stored Run without touching the adapter.
 *   - `unknown` dispatch is terminal for Habi (`execution_uncertain`) and is
 *     never retried automatically. Only a proven `not_dispatched` failure is a
 *     plain `failed`.
 *   - Terminal state is written in one atomic UPDATE guarded by the expected
 *     non-terminal status, so cancel and recovery cannot double-finalize or
 *     rewrite a completed run.
 *   - Usage comes from the adapter; missing/unknown usage is null, never zero.
 *   - Ownership is enforced inside every query and by the H-016 helper; a
 *     guessed, foreign, or malformed id is the same `not_found`.
 *
 * No HTTP endpoint, Nest provider, queue worker, deadline scheduler or retry
 * loop is wired here. Those are integration lanes.
 */
import type { Pool } from 'pg';
import { HarnessAdapterError } from '../adapters/harness-adapter.js';
import type {
  ChatMessage,
  CreateRunRequest,
  DispatchState,
  HarnessAdapter,
  Id,
  RecoveryOutcome,
  RunSnapshot,
  RunSnapshotStatus,
  UsageRecord,
} from '../adapters/harness-adapter.js';
import { lostDispatchState } from '../adapters/recovery.js';
import {
  PersistenceConflictError,
  PersistenceNotFoundError,
  PersistenceValidationError,
} from '../persistence/errors.js';
import {
  loadOwnedConversation,
  requireActorUserId,
  requireResourceId,
} from '../persistence/rows.js';
import { RunIdempotencyConflictError, RunContextError } from './errors.js';
import {
  RunRepository,
  toRunView,
  type RecoveryScanFilter,
  type RunRow,
} from './run-repository.js';
import {
  DEFAULT_DEADLINE_MS,
  DEFAULT_MAX_INPUT_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  normalizeAllowedTools,
  normalizeCancelReason,
  normalizeDeadlineAt,
  normalizeIdempotencyKey,
  normalizeMessages,
  normalizeTokenBudget,
  fingerprintRunRequest,
} from './validation.js';
import { normalizeUsage, unknownUsage } from './usage.js';
import type { PersistedRunUsage } from './usage.js';
import { isTerminalRunStatus } from './types.js';
import type {
  CreateRunInput,
  CreateRunOutcome,
  RunCancelReason,
  RunDispatchOutcome,
  RunFailureOutcome,
  RunRecoveryFilter,
  RunRecoveryResult,
  RunRecoverySummary,
  RunView,
} from './types.js';
import {
  applyTerminalSideEffects,
  type RunSideEffectDeps,
  type RunSideEffectLogger,
} from './finalization.js';
import type { RunEventStore } from '../events/index.js';
import type { UsageLimitService } from '../limits/index.js';

interface BotStateRow {
  status: string;
}

interface MappedTerminal {
  status: RunFailureOutcome;
  errorCode: string | null;
}

/**
 * Maps a reconciled harness snapshot to a Habi outcome. `null` means the
 * adapter contradicted a terminal classification; the safe fallback is `lost`.
 */
function mapTerminalSnapshot(snapshot: RunSnapshot): MappedTerminal | null {
  if (snapshot.harnessStatus === 'waiting_for_approval') {
    // No approval path exists in the POC; an approval pause is a policy failure.
    return { status: 'failed', errorCode: 'policy_denied' };
  }

  return mapSnapshotStatus(snapshot.status);
}

function mapSnapshotStatus(status: RunSnapshotStatus): MappedTerminal | null {
  switch (status) {
    case 'completed':
      return { status: 'completed', errorCode: null };
    case 'failed':
      return { status: 'failed', errorCode: 'provider_error' };
    case 'cancelled':
      return { status: 'cancelled', errorCode: null };
    case 'timed_out':
      return { status: 'failed', errorCode: 'timeout' };
    default:
      return null;
  }
}

function asRunId(id: string): Id<'Run'> {
  return id as Id<'Run'>;
}

function toSequence(value: string): number {
  const sequence = Number(value);

  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new TypeError('Persisted run sequence is outside the supported integer range.');
  }

  return sequence;
}

function normalizeRecoveryFilter(
  filter: string | RunRecoveryFilter | undefined,
): RecoveryScanFilter {
  if (filter === undefined) {
    return {
      ownerUserId: null,
      runIds: null,
      staleAfterMs: null,
      excludeRunIds: [],
      limit: null,
    };
  }

  if (typeof filter === 'string') {
    return {
      ownerUserId: requireActorUserId(filter),
      runIds: null,
      staleAfterMs: null,
      excludeRunIds: [],
      limit: null,
    };
  }

  const runIds =
    filter.runIds === undefined
      ? null
      : filter.runIds.map((runId) => requireResourceId(runId));

  let staleAfterMs: number | null = null;
  let excludeRunIds: readonly string[] = [];
  let limit: number | null = null;

  if (filter.lease !== undefined) {
    staleAfterMs = filter.lease.staleAfterMs;

    if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs < 0) {
      throw new PersistenceValidationError('invalid_input');
    }

    excludeRunIds = (filter.lease.excludeRunIds ?? []).map((runId) =>
      requireResourceId(runId),
    );

    if (filter.lease.limit !== undefined) {
      limit = filter.lease.limit;

      if (!Number.isSafeInteger(limit) || limit < 1) {
        throw new PersistenceValidationError('invalid_input');
      }
    }
  }

  return {
    ownerUserId:
      filter.ownerUserId === undefined
        ? null
        : requireActorUserId(filter.ownerUserId),
    runIds,
    staleAfterMs,
    excludeRunIds,
    limit,
  };
}

export interface RunServiceOptions {
  /**
   * Optional terminal side-effect writers. The API composition uses only the
   * reservation/dispatch seam, while the worker passes the event store and
   * allowance service so a dispatch or recovery failure still settles the hold
   * and emits exactly one terminal event.
   */
  readonly events?: RunEventStore;
  readonly limits?: UsageLimitService;
  readonly logger?: RunSideEffectLogger;
}

export class RunService {
  private readonly repository: RunRepository;
  private readonly finalization: RunSideEffectDeps;

  constructor(
    private readonly pool: Pool,
    private readonly adapter: HarnessAdapter,
    options: RunServiceOptions = {},
  ) {
    this.repository = new RunRepository(pool);
    this.finalization = {
      repository: this.repository,
      ...(options.events === undefined ? {} : { events: options.events }),
      ...(options.limits === undefined ? {} : { limits: options.limits }),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    };
  }

  /**
   * Reserves one Run and dispatches it once. The same key and fingerprint
   * returns the stored Run with `deduplicated: true`; the same key with a
   * different body throws `idempotency_conflict` and dispatches nothing.
   */
  async createRun(input: CreateRunInput): Promise<CreateRunOutcome> {
    const ownerUserId = requireActorUserId(input.ownerUserId);
    const conversationId = requireResourceId(input.conversationId);
    const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
    const messages = normalizeMessages(input.messages);
    const allowedTools = normalizeAllowedTools(input.allowedTools);
    const tokenBudget = normalizeTokenBudget(input.tokenBudget);
    const deadlineAt = normalizeDeadlineAt(input.deadlineAt, Date.now());

    const conversation = await loadOwnedConversation(
      this.pool,
      ownerUserId,
      conversationId,
    );

    if (conversation.status !== 'active') {
      throw new PersistenceConflictError('conversation_archived');
    }

    const botId = conversation.bot_id;

    if (input.botId !== undefined && requireResourceId(input.botId) !== botId) {
      throw new PersistenceValidationError('invalid_input');
    }

    await this.requireActiveBot(ownerUserId, botId);

    const fingerprint = fingerprintRunRequest({
      conversationId,
      botId,
      messages,
    });

    const existing = await this.repository.findByIdempotencyKey(
      ownerUserId,
      idempotencyKey,
    );

    if (existing !== null) {
      return this.reuse(existing, fingerprint);
    }

    const reserved = await this.repository.insertQueued({
      ownerUserId,
      conversationId,
      idempotencyKey,
      requestFingerprint: fingerprint,
    });

    if (reserved === null) {
      // A concurrent submit won the unique constraint. Read it instead of
      // dispatching a second time.
      const raced = await this.repository.findByIdempotencyKey(
        ownerUserId,
        idempotencyKey,
      );

      if (raced === null) {
        throw new Error('Run reservation disappeared after a unique conflict.');
      }

      return this.reuse(raced, fingerprint);
    }

    const request: CreateRunRequest = {
      runId: asRunId(reserved.id),
      idempotencyKey,
      correlationId: reserved.id,
      ownerUserId: ownerUserId as Id<'User'>,
      conversationId: conversationId as Id<'Conversation'>,
      botId: botId as Id<'Bot'>,
      messages: messages.map(
        (message): ChatMessage => ({
          role: message.role,
          content: message.content,
          messageId: message.messageId as Id<'Message'>,
        }),
      ),
      deadlineAt,
      tokenBudget,
      allowedTools,
    };

    const outcome = await this.dispatchOnce(reserved, request);

    return { run: outcome.run, deduplicated: false };
  }

  /**
   * Dispatches an already-reserved Run. This is the public seam the worker uses
   * after claiming: it atomically moves `not_dispatched` to `unknown` before the
   * provider call, so at most one caller can dispatch, and a crash after the
   * call is recoverable as ambiguous rather than retried.
   *
   * A terminal Run, or one another dispatcher already claimed, returns its
   * stored projection with `dispatched: false` and never reaches the adapter.
   * Unknown, malformed, or foreign ids are the same non-enumerating
   * `not_found`; a persisted Run whose context cannot be rebuilt is a permanent
   * `invalid_request` terminal failure with no provider call.
   */
  async dispatchReserved(
    ownerUserId: string,
    runId: string,
  ): Promise<RunDispatchOutcome> {
    const owner = requireActorUserId(ownerUserId);
    const id = requireResourceId(runId);
    const current = await this.repository.loadOwnedRun(owner, id);

    if (isTerminalRunStatus(current.status)) {
      return { run: toRunView(current), dispatched: false };
    }

    if (current.dispatch_state !== 'not_dispatched') {
      return { run: toRunView(current), dispatched: false };
    }

    const claimed = await this.repository.claimRun(id, owner);

    if (claimed === null) {
      const stored = await this.repository.loadOwnedRun(owner, id);
      return { run: toRunView(stored), dispatched: false };
    }

    let request: CreateRunRequest;

    try {
      request = await this.buildPersistedRequest(claimed);
    } catch (error) {
      if (error instanceof RunContextError) {
        this.finalization.logger?.log({
          event: 'run.context_rejected',
          runId: claimed.id,
          reason: error.message,
        });

        const row = await this.failInvalidRequest(claimed);
        return { run: toRunView(row), dispatched: false };
      }

      // No provider call happened, so give the claim back instead of leaving
      // the Run leased until reconciliation.
      await this.repository.releaseClaim(claimed.id, claimed.owner_user_id);
      throw error;
    }

    return this.dispatchOnce(claimed, request);
  }

  /** Owner-scoped read. Foreign, missing, and malformed ids share one error. */
  async getRun(ownerUserId: string, runId: string): Promise<RunView> {
    const row = await this.repository.loadOwnedRun(ownerUserId, runId);
    return toRunView(row);
  }

  /**
   * Cancels a non-terminal Run and keeps cancellation terminal even while the
   * provider unwinds. Repeating the call returns the same terminal row with its
   * original finish time; a completed run is never rewritten to cancelled.
   */
  async cancelRun(
    ownerUserId: string,
    runId: string,
    reason: RunCancelReason,
  ): Promise<RunView> {
    const actorUserId = requireActorUserId(ownerUserId);
    const ownedRunId = requireResourceId(runId);
    const cancelReason = normalizeCancelReason(reason);

    const current = await this.repository.loadOwnedRun(actorUserId, ownedRunId);

    if (isTerminalRunStatus(current.status)) {
      return toRunView(current);
    }

    const mayHaveExecuted = current.dispatch_state !== 'not_dispatched';
    let dispatchState: DispatchState | null = null;
    let errorCode: string | null = null;
    let outcome: RunFailureOutcome = 'cancelled';
    let unexpectedError: unknown = null;

    if (mayHaveExecuted) {
      try {
        const result = await this.adapter.cancel({
          runId: asRunId(ownedRunId),
          reason: cancelReason,
        });

        dispatchState = result.dispatchState;
        // A harness that already finished is authoritative; do not relabel a
        // completed run as cancelled.
        if (result.status === 'completed') {
          outcome = 'completed';
        } else if (result.status === 'failed') {
          outcome = 'failed';
          errorCode = 'provider_error';
        }
      } catch (error) {
        if (error instanceof HarnessAdapterError) {
          dispatchState = error.dispatchState;
          errorCode = error.code;
        } else {
          dispatchState = 'unknown';
          errorCode = 'harness_unavailable';
          unexpectedError = error;
        }
        // Cancellation remains terminal for Habi even if the adapter rejected
        // or lost the stop request; late output is discarded by state.
      }
    }

    const usage = await this.readUsage(ownedRunId, mayHaveExecuted);
    const updated = await this.repository.terminalize({
      runId: ownedRunId,
      ownerUserId: actorUserId,
      status: outcome,
      dispatchState,
      errorCode: outcome === 'cancelled' ? null : errorCode,
      usage,
      lastEventSeq: 0,
      startExecution: mayHaveExecuted,
    });

    const finalRow =
      updated ?? (await this.repository.loadOwnedRun(actorUserId, ownedRunId));

    if (unexpectedError !== null) {
      throw unexpectedError;
    }

    await this.applyEffects(finalRow);

    return toRunView(finalRow);
  }

  /**
   * Reconciles non-terminal Runs after a restart. `lost` becomes terminal
   * `execution_uncertain` with no dispatch retry; `confirmed_terminal` adopts
   * the harness outcome and usage; `still_running` only advances the replay
   * cursor. An already-terminal row is never rewritten.
   *
   * Scope:
   *   - no filter keeps the historical full sweep over every non-terminal row,
   *     including fresh `queued` / `not_dispatched` reservations. It is the
   *     safe whole-service restart reconciliation and must not run alongside a
   *     live claim loop.
   *   - a bare owner string keeps the original owner-scoped full sweep.
   *   - `{ lease }` selects only rows whose claim/heartbeat expired and that may
   *     already have been claimed or dispatched, so a fresh reservation stays
   *     claimable. This is what the worker uses.
   *   - `{ runIds }` reconciles exactly those Runs after ownership/format
   *     validation by the repository predicate.
   */
  async recoverAfterRestart(
    filter?: string | RunRecoveryFilter,
  ): Promise<RunRecoverySummary> {
    const scan = normalizeRecoveryFilter(filter);
    const rows = await this.repository.listForRecovery(scan);

    if (rows.length === 0) {
      return { outcomes: [] };
    }

    const report = await this.adapter.recoverAfterRestart({
      runIds: rows.map((row) => asRunId(row.id)),
    });

    const byRun = new Map<string, RecoveryOutcome>();
    for (const outcome of report.outcomes) {
      byRun.set(outcome.runId, outcome);
    }

    const outcomes: RunRecoveryResult[] = [];

    for (const row of rows) {
      const outcome = byRun.get(row.id);

      // A contract-compliant adapter returns exactly one outcome per run. A
      // missing outcome is treated as lost rather than assumed successful.
      if (outcome === undefined) {
        outcomes.push(
          await this.applyLost(row, 'harness_unavailable'),
        );
        continue;
      }

      if (outcome.kind === 'still_running') {
        const resumeAfter = Math.max(
          outcome.resumeAfterSeq,
          outcome.snapshot.lastSeq,
          toSequence(row.last_event_seq),
        );
        const updated = await this.repository.recordStillRunning(
          row.id,
          row.owner_user_id,
          resumeAfter,
        );
        const finalRow =
          updated ??
          (await this.repository.loadOwnedRun(row.owner_user_id, row.id));

        outcomes.push({
          runId: row.id,
          outcome: 'still_running',
          status: finalRow.status,
          lastEventSeq: toSequence(finalRow.last_event_seq),
        });
        continue;
      }

      if (outcome.kind === 'lost') {
        const dispatchState = lostDispatchState(outcome.dispatchState);
        outcomes.push(
          await this.applyLost(
            row,
            dispatchState === 'not_dispatched'
              ? 'harness_unavailable'
              : 'transport_ambiguous',
            dispatchState,
          ),
        );
        continue;
      }

      const terminal = mapTerminalSnapshot(outcome.snapshot);

      if (terminal === null) {
        outcomes.push(await this.applyLost(row, 'harness_unavailable'));
        continue;
      }

      const usage = await this.readUsage(row.id, true);
      const updated = await this.repository.terminalize({
        runId: row.id,
        ownerUserId: row.owner_user_id,
        status: terminal.status,
        // A confirmed terminal snapshot proves the harness ran; merging only
        // upgrades a `not_dispatched` row, never downgrades `dispatched`.
        dispatchState: 'dispatched',
        errorCode: terminal.errorCode,
        usage,
        lastEventSeq: outcome.snapshot.lastSeq,
        startExecution: true,
      });

      const finalRow =
        updated ??
        (await this.repository.loadOwnedRun(row.owner_user_id, row.id));

      await this.applyEffects(finalRow);

      outcomes.push({
        runId: row.id,
        outcome: 'confirmed_terminal',
        status: finalRow.status,
        lastEventSeq: toSequence(finalRow.last_event_seq),
      });
    }

    return { outcomes };
  }

  private reuse(existing: RunRow, fingerprint: string): CreateRunOutcome {
    if (existing.request_fingerprint !== fingerprint) {
      throw new RunIdempotencyConflictError();
    }

    return { run: toRunView(existing), deduplicated: true };
  }

  private async dispatchOnce(
    reserved: RunRow,
    request: CreateRunRequest,
  ): Promise<RunDispatchOutcome> {
    let result;

    try {
      result = await this.adapter.createRun(request);
    } catch (error) {
      if (error instanceof HarnessAdapterError) {
        const row = await this.finishDispatchFailure(reserved, error);
        return { run: toRunView(row), dispatched: false };
      }

      // An unexpected controller/adapter bug is still an ambiguous external
      // effect: persist the safe outcome before surfacing the error.
      const updated = await this.repository.terminalize({
        runId: reserved.id,
        ownerUserId: reserved.owner_user_id,
        status: 'execution_uncertain',
        dispatchState: 'unknown',
        errorCode: 'harness_unavailable',
        usage: unknownUsage(),
        lastEventSeq: 0,
        startExecution: true,
      });
      const row =
        updated ??
        (await this.repository.loadOwnedRun(
          reserved.owner_user_id,
          reserved.id,
        ));
      await this.applyEffects(row);
      throw error;
    }

    if (result.dispatchState === 'unknown') {
      // Accepted with ambiguous dispatch: never retry potentially paid work.
      const updated = await this.repository.terminalize({
        runId: reserved.id,
        ownerUserId: reserved.owner_user_id,
        status: 'execution_uncertain',
        dispatchState: 'unknown',
        errorCode: 'transport_ambiguous',
        usage: unknownUsage(),
        lastEventSeq: 0,
        startExecution: true,
      });
      const row =
        updated ??
        (await this.repository.loadOwnedRun(
          reserved.owner_user_id,
          reserved.id,
        ));
      await this.applyEffects(row);
      return { run: toRunView(row), dispatched: false };
    }

    const updated = await this.repository.recordDispatch(
      reserved.id,
      reserved.owner_user_id,
      result.dispatchState,
      result.harnessRunId,
      result.harnessSessionId,
    );

    const row =
      updated ??
      (await this.repository.loadOwnedRun(reserved.owner_user_id, reserved.id));

    if (updated === null) {
      // Another writer terminalized the Run between claim and acceptance.
      await this.applyEffects(row);
    }

    return {
      run: toRunView(row),
      dispatched: updated !== null,
    };
  }

  /**
   * Records a dispatch failure according to the adapter's dispatch state:
   * `not_dispatched` is a plain failure; `dispatched` failed after the call;
   * `unknown` is terminal `execution_uncertain` and is never retried.
   */
  private async finishDispatchFailure(
    reserved: RunRow,
    error: HarnessAdapterError,
  ): Promise<RunRow> {
    const status: RunFailureOutcome =
      error.dispatchState === 'unknown' ? 'execution_uncertain' : 'failed';
    const usage =
      error.dispatchState === 'dispatched'
        ? await this.readUsage(reserved.id, true)
        : unknownUsage();

    const updated = await this.repository.terminalize({
      runId: reserved.id,
      ownerUserId: reserved.owner_user_id,
      status,
      dispatchState: error.dispatchState,
      errorCode: error.code,
      usage,
      lastEventSeq: 0,
      startExecution: error.dispatchState !== 'not_dispatched',
      // A proven pre-dispatch failure corrects the conservative `unknown` claim
      // back to `not_dispatched`; an accepted dispatch is never downgraded.
      replaceDispatchState: error.dispatchState === 'not_dispatched',
    });

    const finalRow =
      updated ??
      (await this.repository.loadOwnedRun(reserved.owner_user_id, reserved.id));

    await this.applyEffects(finalRow);

    return finalRow;
  }

  /**
   * Applies the lost outcome: terminal `execution_uncertain`, no create call,
   * and usage unknown unless the adapter can still report it.
   */
  private async applyLost(
    row: RunRow,
    errorCode: string,
    dispatchState?: DispatchState,
  ): Promise<RunRecoveryResult> {
    const resolvedDispatch =
      dispatchState ?? lostDispatchState(row.dispatch_state);
    const usage = await this.readUsage(
      row.id,
      resolvedDispatch !== 'not_dispatched',
    );

    const updated = await this.repository.terminalize({
      runId: row.id,
      ownerUserId: row.owner_user_id,
      status: 'execution_uncertain',
      dispatchState: resolvedDispatch,
      errorCode,
      usage,
      lastEventSeq: 0,
      startExecution: resolvedDispatch !== 'not_dispatched',
      replaceDispatchState: true,
    });

    const finalRow =
      updated ??
      (await this.repository.loadOwnedRun(row.owner_user_id, row.id));

    await this.applyEffects(finalRow);

    return {
      runId: row.id,
      outcome: 'lost',
      status: finalRow.status,
      lastEventSeq: toSequence(finalRow.last_event_seq),
    };
  }

  private async buildPersistedRequest(run: RunRow): Promise<CreateRunRequest> {
    const botId = await this.repository.loadConversationBot(
      run.owner_user_id,
      run.conversation_id,
    );

    if (botId === null) {
      throw new RunContextError(
        'the Run conversation is missing or not owned',
      );
    }

    const rows = await this.repository.loadContextMessages(
      run.owner_user_id,
      run.conversation_id,
      run.id,
      run.idempotency_key,
    );

    if (rows.length === 0) {
      throw new RunContextError('the Run has no persisted context message');
    }

    const messages = rows.map(
      (row): ChatMessage => ({
        role: row.role,
        content: row.content,
        messageId: row.id as Id<'Message'>,
      }),
    );

    return {
      runId: asRunId(run.id),
      idempotencyKey: run.idempotency_key,
      correlationId: run.id,
      ownerUserId: run.owner_user_id as Id<'User'>,
      conversationId: run.conversation_id as Id<'Conversation'>,
      botId: botId as Id<'Bot'>,
      messages,
      deadlineAt: new Date(Date.now() + DEFAULT_DEADLINE_MS).toISOString(),
      tokenBudget: {
        maxInputTokens: DEFAULT_MAX_INPUT_TOKENS,
        maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
      },
      allowedTools: [],
    };
  }

  /** Permanent persisted-context failure: terminal without a provider call. */
  private async failInvalidRequest(claimed: RunRow): Promise<RunRow> {
    const updated = await this.repository.terminalize({
      runId: claimed.id,
      ownerUserId: claimed.owner_user_id,
      status: 'failed',
      dispatchState: 'not_dispatched',
      errorCode: 'invalid_request',
      usage: unknownUsage(),
      lastEventSeq: 0,
      startExecution: false,
      replaceDispatchState: true,
    });

    const finalRow =
      updated ??
      (await this.repository.loadOwnedRun(claimed.owner_user_id, claimed.id));

    await this.applyEffects(finalRow);

    return finalRow;
  }

  private applyEffects(row: RunRow): Promise<void> {
    return applyTerminalSideEffects(this.finalization, row);
  }

  private async readUsage(
    runId: string,
    mayHaveExecuted: boolean,
  ): Promise<PersistedRunUsage> {
    if (!mayHaveExecuted) {
      return unknownUsage();
    }

    try {
      const usage: UsageRecord = await this.adapter.getUsage(asRunId(runId));
      return normalizeUsage(usage);
    } catch {
      // Missing usage after a possible execution is unknown, never zero.
      return unknownUsage();
    }
  }

  private async requireActiveBot(
    ownerUserId: string,
    botId: string,
  ): Promise<void> {
    const result = await this.pool.query<BotStateRow>(
      `SELECT status
         FROM bots
        WHERE id = $1
          AND owner_user_id = $2
          AND deleted_at IS NULL`,
      [botId, ownerUserId],
    );

    const row = result.rows[0];

    if (row === undefined) {
      throw new PersistenceNotFoundError();
    }

    if (row.status !== 'active') {
      throw new PersistenceConflictError('bot_unavailable');
    }
  }
}
