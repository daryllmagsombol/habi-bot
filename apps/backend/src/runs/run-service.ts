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
 *   - A cancel for a Run that may already be dispatched is a durable intent on
 *     the Row, not a local status write: the API records it, and the owning
 *     worker claims exactly one adapter stop before terminalizing through the
 *     one finalization path.
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
  CancelResult,
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
  PROVIDER_CALL_EVENT,
  RUN_DISPATCH_ACCEPTED_EVENT,
  RUN_DISPATCH_SKIPPED_EVENT,
  RUN_DUPLICATE_EVENT,
  RUN_ENQUEUED_EVENT,
  RUN_RESERVED_EVENT,
  RUN_TERMINAL_EVENT,
  correlateRun,
  providerCallFields,
  usageSummary,
} from '../observability/run-telemetry.js';
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
import {
  CANCEL_CLAIM_TTL_MS,
  MAX_CANCEL_ATTEMPTS,
  isTerminalRunStatus,
} from './types.js';
import type {
  CancelIntentOutcome,
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

/**
 * A harness that already finished is authoritative, so its terminal status is
 * adopted verbatim; anything else the stop reported is a cancellation.
 */
function cancelStatusFor(result: CancelResult): RunFailureOutcome {
  if (result.status === 'completed') {
    return 'completed';
  }

  if (result.status === 'failed') {
    return 'failed';
  }

  return 'cancelled';
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

/**
 * A durable cancellation intent outranks everything except an already-terminal
 * Run, whose stored outcome must not be relabelled.
 */
function hasPendingCancelIntent(row: RunRow): boolean {
  return !isTerminalRunStatus(row.status) && row.cancel_requested_at !== null;
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
  /**
   * Optional observability hooks. Logging/metrics calls only: the service
   * never branches on these and never changes a transition because of them.
   * When absent (for example in unit tests), the service stays silent and
   * uncounted rather than constructing a default.
   */
  readonly telemetry?: RunTelemetryHooks;
}

/** Logging/metrics seam for run observability. All methods are best-effort. */
export interface RunTelemetryHooks {
  readonly events?: RunTelemetryEventLogger;
  readonly metrics?: RunTelemetryMetrics;
}

export interface RunTelemetryEventLogger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export interface RunTelemetryMetrics {
  recordEnqueue(deduplicated: boolean): void;
  recordDispatchAccepted(): void;
  recordDispatchSkip(reason: string): void;
  recordTerminal(status: string): void;
  recordProviderCall(
    outcome: 'success' | 'failure',
    errorCode?: string,
    retried?: boolean,
  ): void;
  recordQueueFailure(): void;
  setQueueHealth(input: {
    readonly depth: number;
    readonly oldestAgeMs: number | null;
  }): void;
}

export class RunService {
  private readonly repository: RunRepository;
  private readonly finalization: RunSideEffectDeps;
  private readonly telemetry: RunTelemetryHooks;

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
    this.telemetry = options.telemetry ?? {};
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
      this.observeEnqueue(existing.id, existing.conversation_id, true);
      return this.reuse(existing, fingerprint);
    }

    const reserved = await this.repository.insertQueued({
      ownerUserId,
      conversationId,
      idempotencyKey,
      requestFingerprint: fingerprint,
    });

    if (reserved !== null) {
      this.observeEnqueue(reserved.id, reserved.conversation_id, false);
    }

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

      this.observeEnqueue(raced.id, raced.conversation_id, true);
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
      this.observeDispatchSkip(current.id, current.conversation_id, 'terminal');
      return { run: toRunView(current), dispatched: false };
    }

    if (current.cancel_requested_at !== null) {
      // A durable cancellation intent wins over dispatch: the Run must never be
      // sent to the provider after the user asked to stop it. The worker's idle
      // sweep terminalizes this reservation.
      this.observeDispatchSkip(
        current.id,
        current.conversation_id,
        'cancel_requested',
      );
      return { run: toRunView(current), dispatched: false };
    }

    if (current.dispatch_state !== 'not_dispatched') {
      this.observeDispatchSkip(
        current.id,
        current.conversation_id,
        'claimed_elsewhere',
      );
      return { run: toRunView(current), dispatched: false };
    }

    const claimed = await this.repository.claimRun(id, owner);

    if (claimed === null) {
      const stored = await this.repository.loadOwnedRun(owner, id);
      this.observeDispatchSkip(
        stored.id,
        stored.conversation_id,
        isTerminalRunStatus(stored.status) ? 'terminal' : 'claimed_elsewhere',
      );
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
        this.observeDispatchSkip(
          claimed.id,
          claimed.conversation_id,
          'invalid_context',
        );

        const row = await this.failInvalidRequest(claimed);
        this.observeTerminal(row);
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
   * Cancels a non-terminal Run. The intent is committed first, so a Run that may
   * already be on the harness is stopped by whichever worker owns the claim: the
   * API process has no adapter and never reports a stop it did not receive.
   *
   *   - undispatched: terminal `cancelled` immediately, allowance hold released;
   *   - dispatched/unknown: durable intent, current non-terminal row returned;
   *   - already terminal: the stored row, unchanged, which makes repeats no-ops.
   *
   * `applyCancelIntent` is the worker half and is idempotent with this call.
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

    // Null means the Run turned terminal between the read and this write, or it
    // never belonged to the actor. Reloading produces the same 404 as any other
    // owner-scoped read and the stored terminal row otherwise.
    const requested = await this.repository.requestCancel(
      ownedRunId,
      actorUserId,
      cancelReason,
    );

    if (requested === null) {
      return toRunView(
        await this.repository.loadOwnedRun(actorUserId, ownedRunId),
      );
    }

    const outcome = await this.applyCancelIntent(actorUserId, ownedRunId);
    return outcome.run;
  }

  /**
   * Honours one durable cancellation intent exactly once.
   *
   * The adapter is only called after an atomic claim, so the owning stream's
   * heartbeat and the idle worker sweep cannot both stop the same Run. A
   * successful stop terminalizes `cancelled` (or the harness's authoritative
   * terminal status) and runs the standard finalization side effects: the
   * allowance hold is settled or released once, and the terminal event is
   * appended through the same deterministic id as every other terminal path.
   *
   * A failure to reach the adapter is recorded on the Row and returns `failed`
   * with the Run still non-terminal. The intent stays for a bounded retry.
   */
  async applyCancelIntent(
    ownerUserId: string,
    runId: string,
  ): Promise<CancelIntentOutcome> {
    const actorUserId = requireActorUserId(ownerUserId);
    const ownedRunId = requireResourceId(runId);
    const current = await this.repository.loadOwnedRun(actorUserId, ownedRunId);

    if (!hasPendingCancelIntent(current)) {
      return { kind: 'none', run: toRunView(current), errorCode: null };
    }

    if (current.cancel_attempts >= MAX_CANCEL_ATTEMPTS) {
      // A previous processor spent the bound and died before recording the
      // outcome. Stop retrying and record the honest uncertainty.
      return this.finishUnconfirmedCancel(
        current,
        current.cancel_error_code ?? 'harness_unavailable',
      );
    }

    const claimed = await this.repository.claimCancel(
      ownedRunId,
      actorUserId,
      MAX_CANCEL_ATTEMPTS,
      CANCEL_CLAIM_TTL_MS,
    );

    if (claimed === null) {
      return this.reloadCancelOutcome(actorUserId, ownedRunId);
    }

    if (claimed.dispatch_state === 'not_dispatched') {
      return this.cancelUnsentClaim(actorUserId, ownedRunId);
    }

    const cancelReason = normalizeCancelReason(claimed.cancel_reason ?? 'user');
    let result: CancelResult;

    try {
      result = await this.adapter.cancel({
        runId: asRunId(ownedRunId),
        reason: cancelReason,
      });
    } catch (error) {
      return this.recordAdapterCancelFailure(actorUserId, ownedRunId, error);
    }

    return this.terminalizeConfirmedCancel(actorUserId, ownedRunId, result);
  }

  /**
   * Reads the stored row after a losing claim. A terminal row means the outcome
   * is already decided; anything else is another processor's fresh attempt,
   * which this caller must not repeat.
   */
  private async reloadCancelOutcome(
    ownerUserId: string,
    runId: string,
  ): Promise<CancelIntentOutcome> {
    const stored = await this.repository.loadOwnedRun(ownerUserId, runId);

    return {
      kind: isTerminalRunStatus(stored.status) ? 'none' : 'deferred',
      run: toRunView(stored),
      errorCode: stored.cancel_error_code,
    };
  }

  /**
   * Terminalizes a claimed Run that provably never reached the provider. The
   * dispatch-state guard is what makes this safe against a concurrent claim.
   */
  private async cancelUnsentClaim(
    ownerUserId: string,
    runId: string,
  ): Promise<CancelIntentOutcome> {
    const updated = await this.repository.terminalize({
      runId,
      ownerUserId,
      status: 'cancelled',
      dispatchState: null,
      errorCode: null,
      usage: unknownUsage(),
      lastEventSeq: 0,
      startExecution: false,
      expectedDispatchState: 'not_dispatched',
    });

    if (updated === null) {
      return this.reloadCancelOutcome(ownerUserId, runId);
    }

    await this.applyEffects(updated);
    this.observeTerminal(updated);
    return { kind: 'terminal', run: toRunView(updated), errorCode: null };
  }

  /**
   * Records a stop that the adapter did not confirm. The Run stays non-terminal
   * until the bounded retries are spent, unless it finished meanwhile, in which
   * case the stored outcome is adopted rather than relabelled.
   */
  private async recordAdapterCancelFailure(
    ownerUserId: string,
    runId: string,
    error: unknown,
  ): Promise<CancelIntentOutcome> {
    const errorCode =
      error instanceof HarnessAdapterError ? error.code : 'harness_unavailable';
    const failed =
      (await this.repository.recordCancelFailure(runId, ownerUserId, errorCode)) ??
      (await this.repository.loadOwnedRun(ownerUserId, runId));

    if (isTerminalRunStatus(failed.status)) {
      await this.applyEffects(failed);
      this.observeTerminal(failed);
      return {
        kind: 'terminal',
        run: toRunView(failed),
        errorCode: failed.error_code,
      };
    }

    if (failed.cancel_attempts >= MAX_CANCEL_ATTEMPTS) {
      // The bound is spent. The Run must not be reported cancelled, and it must
      // not stay non-terminal forever: record the uncertainty and let the
      // standard terminal side effects settle the hold.
      this.finalization.logger?.log({
        event: 'run.cancel_exhausted',
        runId,
        errorCode,
        attempts: failed.cancel_attempts,
      });

      return this.finishUnconfirmedCancel(failed, errorCode);
    }

    this.finalization.logger?.log({
      event: 'run.cancel_failed',
      runId,
      errorCode,
      attempts: failed.cancel_attempts,
    });

    return { kind: 'failed', run: toRunView(failed), errorCode };
  }

  /** Writes the adapter-acknowledged terminal outcome and its side effects. */
  private async terminalizeConfirmedCancel(
    ownerUserId: string,
    runId: string,
    result: CancelResult,
  ): Promise<CancelIntentOutcome> {
    const status = cancelStatusFor(result);
    const usage = await this.readUsage(runId, true);
    const updated = await this.repository.terminalize({
      runId,
      ownerUserId,
      status,
      dispatchState: result.dispatchState,
      errorCode: status === 'failed' ? 'provider_error' : null,
      usage,
      lastEventSeq: 0,
      startExecution: true,
    });

    const finalRow =
      updated ?? (await this.repository.loadOwnedRun(ownerUserId, runId));

    await this.applyEffects(finalRow);
    this.observeProviderCall(
      { id: runId, conversation_id: finalRow.conversation_id },
      'success',
      status === 'failed' ? 'provider_error' : null,
      result.dispatchState,
      usage,
    );
    this.observeTerminal(finalRow);

    return {
      kind: 'terminal',
      run: toRunView(finalRow),
      errorCode: finalRow.error_code,
    };
  }

  /**
   * Handles outstanding intents for Runs no local task owns: a Run cancelled
   * while queued, or one orphaned by a worker restart. Bounded by `limit`; an
   * unexpected failure on one Run is logged and does not stop the sweep.
   */
  async processCancelIntents(
    limit: number,
    excludeRunIds: readonly string[] = [],
  ): Promise<CancelIntentOutcome[]> {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new PersistenceValidationError('invalid_input');
    }

    const rows = await this.repository.listCancelPending(limit, excludeRunIds);
    const outcomes: CancelIntentOutcome[] = [];

    for (const row of rows) {
      try {
        outcomes.push(
          await this.applyCancelIntent(row.owner_user_id, row.id),
        );
      } catch (error) {
        this.finalization.logger?.log({
          event: 'run.cancel_sweep_failed',
          runId: row.id,
          message: error instanceof Error ? error.name : 'unknown_error',
        });
      }
    }

    return outcomes;
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
      outcomes.push(await this.reconcileRecoveredRow(row, byRun));
    }

    return { outcomes };
  }

  /** Applies exactly one recovery decision to one abandoned Run. */
  private reconcileRecoveredRow(
    row: RunRow,
    byRun: ReadonlyMap<string, RecoveryOutcome>,
  ): Promise<RunRecoveryResult> {
    if (row.cancel_requested_at !== null) {
      // A user-requested stop outranks restart reconciliation: stop the Run
      // instead of adopting a snapshot claim that the intent was never seen.
      return this.reconcileCancelIntent(row);
    }

    const outcome = byRun.get(row.id);

    // A contract-compliant adapter returns exactly one outcome per run. A
    // missing outcome is treated as lost rather than assumed successful.
    if (outcome === undefined) {
      return this.applyLost(row, 'harness_unavailable');
    }

    if (outcome.kind === 'still_running') {
      return this.recordStillRunning(row, outcome);
    }

    if (outcome.kind === 'lost') {
      const dispatchState = lostDispatchState(outcome.dispatchState);

      return this.applyLost(
        row,
        dispatchState === 'not_dispatched'
          ? 'harness_unavailable'
          : 'transport_ambiguous',
        dispatchState,
      );
    }

    return this.applyConfirmedTerminal(row, outcome.snapshot);
  }

  /** Honours the outstanding intent and reports the Run's resulting state. */
  private async reconcileCancelIntent(row: RunRow): Promise<RunRecoveryResult> {
    const intent = await this.applyCancelIntent(row.owner_user_id, row.id);

    return {
      runId: row.id,
      outcome: isTerminalRunStatus(intent.run.status)
        ? 'confirmed_terminal'
        : 'still_running',
      status: intent.run.status,
      lastEventSeq: intent.run.lastEventSeq,
    };
  }

  /** Advances only the replay cursor for a Run the harness still owns. */
  private async recordStillRunning(
    row: RunRow,
    outcome: Extract<RecoveryOutcome, { kind: 'still_running' }>,
  ): Promise<RunRecoveryResult> {
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
      updated ?? (await this.repository.loadOwnedRun(row.owner_user_id, row.id));

    return {
      runId: row.id,
      outcome: 'still_running',
      status: finalRow.status,
      lastEventSeq: toSequence(finalRow.last_event_seq),
    };
  }

  /** Adopts an authoritative harness terminal snapshot exactly once. */
  private async applyConfirmedTerminal(
    row: RunRow,
    snapshot: RunSnapshot,
  ): Promise<RunRecoveryResult> {
    const terminal = mapTerminalSnapshot(snapshot);

    if (terminal === null) {
      return this.applyLost(row, 'harness_unavailable');
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
      lastEventSeq: snapshot.lastSeq,
      startExecution: true,
    });

    const finalRow =
      updated ?? (await this.repository.loadOwnedRun(row.owner_user_id, row.id));

    await this.applyEffects(finalRow);
    this.observeTerminal(finalRow);

    return {
      runId: row.id,
      outcome: 'confirmed_terminal',
      status: finalRow.status,
      lastEventSeq: toSequence(finalRow.last_event_seq),
    };
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
      this.observeProviderCall(reserved, 'failure', 'harness_unavailable', 'unknown', unknownUsage());
      this.observeTerminal(row);
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
      this.observeProviderCall(reserved, 'success', null, 'unknown', unknownUsage());
      this.observeTerminal(row);
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
      this.observeProviderCall(reserved, 'success', null, result.dispatchState, unknownUsage());
      this.observeTerminal(row);
    } else {
      this.observeProviderCall(reserved, 'success', null, result.dispatchState, unknownUsage());
      this.observeDispatchAccepted(reserved);
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
    this.observeProviderCall(
      reserved,
      'failure',
      error.code,
      error.dispatchState,
      usage,
    );
    this.observeTerminal(finalRow);

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
    this.observeTerminal(finalRow);

    return {
      runId: row.id,
      outcome: 'lost',
      status: finalRow.status,
      lastEventSeq: toSequence(finalRow.last_event_seq),
    };
  }

  /**
   * Final honest outcome when the cancellation bound is spent without an adapter
   * acknowledgement. The Run becomes terminal `execution_uncertain`, never
   * `cancelled`: Habi could not confirm the stop. Usage is read from the harness
   * when it can still answer, and the standard terminal side effects settle or
   * release the hold exactly once.
   */
  private async finishUnconfirmedCancel(
    row: RunRow,
    errorCode: string,
  ): Promise<CancelIntentOutcome> {
    if (row.dispatch_state === 'not_dispatched') {
      // Never sent, so there is nothing ambiguous to report: this is a real
      // cancellation and the hold is released by the standard side effects.
      const cancelled = await this.repository.terminalize({
        runId: row.id,
        ownerUserId: row.owner_user_id,
        status: 'cancelled',
        dispatchState: null,
        errorCode: null,
        usage: unknownUsage(),
        lastEventSeq: 0,
        startExecution: false,
        expectedDispatchState: 'not_dispatched',
      });

      const finalRow =
        cancelled ??
        (await this.repository.loadOwnedRun(row.owner_user_id, row.id));

      await this.applyEffects(finalRow);
      this.observeTerminal(finalRow);

      return { kind: 'exhausted', run: toRunView(finalRow), errorCode: null };
    }

    const usage = await this.readUsage(row.id, true);
    const updated = await this.repository.terminalize({
      runId: row.id,
      ownerUserId: row.owner_user_id,
      status: 'execution_uncertain',
      dispatchState: null,
      errorCode,
      usage,
      lastEventSeq: 0,
      startExecution: true,
    });

    const finalRow =
      updated ?? (await this.repository.loadOwnedRun(row.owner_user_id, row.id));

    await this.applyEffects(finalRow);
    this.observeTerminal(finalRow);

    return { kind: 'exhausted', run: toRunView(finalRow), errorCode };
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

  /**
   * Telemetry observers. Logging/metrics calls only: each one is guarded so a
   * throwing hook can never change a transition, and the metrics call is
   * issued before the log call so a broken sink still leaves the count.
   */
  private observeEnqueue(
    runId: string,
    conversationId: string | undefined,
    deduplicated: boolean,
  ): void {
    try {
      this.telemetry.metrics?.recordEnqueue(deduplicated);
    } catch {
      // Telemetry must never change a transition.
    }

    try {
      const correlation = correlateRun(runId, conversationId);
      this.telemetry.events?.info(
        deduplicated ? RUN_DUPLICATE_EVENT : RUN_ENQUEUED_EVENT,
        { ...correlation, deduplicated },
      );
      if (!deduplicated) {
        this.telemetry.events?.info(RUN_RESERVED_EVENT, {
          ...correlation,
          dispatchState: 'not_dispatched',
          status: 'queued',
        });
      }
    } catch {
      // Telemetry must never change a transition.
    }
  }

  private observeDispatchAccepted(reserved: RunRow): void {
    try {
      this.telemetry.metrics?.recordDispatchAccepted();
    } catch {
      // Telemetry must never change a transition.
    }

    try {
      this.telemetry.events?.info(RUN_DISPATCH_ACCEPTED_EVENT, {
        ...correlateRun(reserved.id, reserved.conversation_id),
        dispatchState: reserved.dispatch_state,
      });
    } catch {
      // Telemetry must never change a transition.
    }
  }

  private observeDispatchSkip(
    runId: string,
    conversationId: string | undefined,
    reason: string,
  ): void {
    try {
      this.telemetry.metrics?.recordDispatchSkip(reason);
    } catch {
      // Telemetry must never change a transition.
    }

    try {
      this.telemetry.events?.info(RUN_DISPATCH_SKIPPED_EVENT, {
        ...correlateRun(runId, conversationId),
        reason,
      });
    } catch {
      // Telemetry must never change a transition.
    }
  }

  private observeTerminal(row: RunRow): void {
    try {
      this.telemetry.metrics?.recordTerminal(row.status);
    } catch {
      // Telemetry must never change a transition.
    }

    try {
      this.telemetry.events?.info(RUN_TERMINAL_EVENT, {
        ...correlateRun(row.id, row.conversation_id),
        status: row.status,
        dispatchState: row.dispatch_state,
        ...(row.error_code === null ? {} : { errorCode: row.error_code }),
      });
    } catch {
      // Telemetry must never change a transition.
    }
  }

  private observeProviderCall(
    reserved: Pick<RunRow, 'id' | 'conversation_id'>,
    outcome: 'success' | 'failure',
    errorCode: string | null,
    dispatchState: string | null,
    usage: PersistedRunUsage,
  ): void {
    const retried = false;

    try {
      this.telemetry.metrics?.recordProviderCall(
        outcome,
        errorCode ?? undefined,
        retried,
      );
    } catch {
      // Telemetry must never change a transition.
    }

    try {
      this.telemetry.events?.info(
        PROVIDER_CALL_EVENT,
        providerCallFields(correlateRun(reserved.id, reserved.conversation_id), {
          outcome,
          errorCode,
          dispatchState,
          retried,
          usage: usageSummary(usage),
        }),
      );
    } catch {
      // Telemetry must never change a transition.
    }
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
