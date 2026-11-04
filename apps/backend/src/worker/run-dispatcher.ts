/**
 * Run dispatcher: the worker-side half of the H-022 run lifecycle.
 *
 * Claim (in `run-claim-repository.ts`) already moved a reservation into
 * worker ownership. This module then:
 *
 *   1. rebuilds the request from the persisted conversation (`run-context.ts`);
 *   2. calls the same `HarnessAdapter.createRun` the controller contract
 *      defines, recording the accepted dispatch state exactly once;
 *   3. streams adapter events into `RunEventStore.append` *in adapter order*.
 *      The store allocates the server sequence and publishes the Run id on its
 *      hub after the append transaction commits, which is the existing replay
 *      contract; this module adds no second sequencing or fan-out;
 *   4. records exactly one terminal state and appends at most one terminal
 *      event whose type matches the stored status;
 *   5. settles or releases the H-023 allowance reservation for the Run.
 *
 * Safety rules mirrored from `RunService`:
 *   - `unknown` dispatch is terminal `execution_uncertain` and is never retried;
 *   - a proven `not_dispatched` failure is `failed` (a user retry is a new Run);
 *   - usage is `known`/`partial`/`unknown`, and unknown stays null;
 *   - terminal writes are single atomic updates guarded by the non-terminal
 *     status, so a concurrent cancel or recovery wins without a rewrite.
 *
 * `RunService` has no public entry point for dispatching an already-reserved
 * Run (`createRun` deduplicates and returns without dispatch, and `dispatchOnce`
 * is private), so this lane composes the same repository primitives. That gap is
 * reported rather than changing `runs/**`.
 */
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { HarnessAdapterError } from '../adapters/harness-adapter.js';
import type {
  DispatchState,
  HarnessAdapter,
  Id,
  RecoveryOutcome,
  RecoveryReport,
  RunEvent,
  RunSnapshot,
  RunSnapshotStatus,
} from '../adapters/harness-adapter.js';
import { lostDispatchState } from '../adapters/recovery.js';
import {
  RunEventStreamClosedError,
  isTerminalRunEventType,
} from '../events/index.js';
import type { RunEventStore } from '../events/index.js';
import type { UsageLimitService } from '../limits/index.js';
import type { SettleUsageInput } from '../limits/index.js';
import { RunRepository } from '../runs/run-repository.js';
import type { RunRow } from '../runs/run-repository.js';
import { normalizeUsage, unknownUsage } from '../runs/usage.js';
import type { PersistedRunUsage } from '../runs/usage.js';
import { isTerminalRunStatus } from '../runs/types.js';
import type { PersistedRunStatus, RunFailureOutcome } from '../runs/types.js';
import type { WorkerLogger } from './logger.js';
import { buildCreateRunRequest, RunContextError } from './run-context.js';
import type { WorkerRunRepository } from './run-claim-repository.js';

const UUID_LENGTH = 32;
const TERMINAL_EVENT_DISCRIMINATOR = 'terminal';
const USAGE_EVENT_DISCRIMINATOR = 'usage';

interface RunDecision {
  readonly status: RunFailureOutcome;
  readonly errorCode: string | null;
  readonly dispatchState: DispatchState | null;
  readonly usage: PersistedRunUsage;
  readonly startExecution: boolean;
  readonly replaceDispatchState?: boolean;
  readonly lastEventSeq?: number;
}

interface InFlightState {
  readonly controller: AbortController;
  phase: 'claimed' | 'dispatching' | 'streaming' | 'finished';
  leaseLost: boolean;
  shutdown: boolean;
}

export interface WorkerRecoveryOutcome {
  readonly runId: string;
  readonly outcome: 'confirmed_terminal' | 'still_running' | 'lost';
  readonly status: PersistedRunStatus;
}

export interface WorkerRecoverySummary {
  readonly outcomes: readonly WorkerRecoveryOutcome[];
}

export interface RunDispatcherOptions {
  readonly pool: Pool;
  readonly adapter: HarnessAdapter;
  readonly workerRepository: WorkerRunRepository;
  readonly events: RunEventStore;
  readonly limits: UsageLimitService;
  readonly logger: WorkerLogger;
  readonly leaseMs: number;
  readonly now?: () => number;
}

const HEARTBEAT_FLOOR_MS = 250;

function asRunId(id: string): Id<'Run'> {
  return id as Id<'Run'>;
}

function toSequence(value: string | number): number {
  const sequence = typeof value === 'number' ? value : Number(value);

  return Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : 0;
}

function toNullableNumber(value: string | number | null): number | null {
  if (value === null) {
    return null;
  }

  const parsed = typeof value === 'number' ? value : Number(value);

  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Stable UUID-shaped idempotency key for an append. Adapter delivery is
 * at-least-once, so re-appending `(runId, adapterSeq)` must return the stored
 * event instead of allocating a second `seq`.
 */
function deterministicEventId(runId: string, discriminator: string): string {
  const hex = createHash('sha256')
    .update(`${runId}\u0000${discriminator}`, 'utf8')
    .digest('hex')
    .slice(0, UUID_LENGTH);

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

function terminalEventType(status: PersistedRunStatus): string {
  if (status === 'completed') {
    return 'run.completed';
  }

  if (status === 'cancelled') {
    return 'run.cancelled';
  }

  return 'run.failed';
}

function statusForTerminalEvent(type: string): RunFailureOutcome {
  if (type === 'run.completed') {
    return 'completed';
  }

  if (type === 'run.cancelled') {
    return 'cancelled';
  }

  return 'failed';
}

function mapSnapshotStatus(status: RunSnapshotStatus): RunDecision['status'] | null {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'timed_out':
      return 'failed';
    default:
      return null;
  }
}

function snapshotErrorCode(status: RunSnapshotStatus): string | null {
  if (status === 'failed') {
    return 'provider_error';
  }

  if (status === 'timed_out') {
    return 'timeout';
  }

  return null;
}

export class RunDispatcher {
  private readonly runs: RunRepository;
  private readonly now: () => number;

  constructor(private readonly options: RunDispatcherOptions) {
    this.runs = new RunRepository(options.pool);
    this.now = options.now ?? Date.now;
  }

  /**
   * Dispatches one claimed Run. Resolves for every expected outcome; only an
   * unexpected programming failure escapes, and the caller records it.
   */
  async dispatch(run: RunRow, shutdownSignal: AbortSignal): Promise<void> {
    const state: InFlightState = {
      controller: new AbortController(),
      phase: 'claimed',
      leaseLost: false,
      shutdown: false,
    };

    const onShutdown = (): void => {
      state.shutdown = true;
      state.controller.abort();
    };

    shutdownSignal.addEventListener('abort', onShutdown, { once: true });
    const timer = this.startHeartbeat(run, state);

    try {
      await this.runDispatch(run, state);
    } catch (error) {
      await this.handleUnexpected(run, state, error);
    } finally {
      state.phase = 'finished';
      clearInterval(timer);
      shutdownSignal.removeEventListener('abort', onShutdown);
    }
  }

  /**
   * Reconciles only abandoned claims: rows whose lease expired and that were
   * previously dispatched or claimed. Fresh `queued` / `not_dispatched`
   * reservations are deliberately excluded so a restart never fails work the
   * claim loop can still dispatch.
   *
   * The outcome application mirrors `RunService.recoverAfterRestart`; that
   * method scans *all* non-terminal rows, including fresh reservations, so it
   * cannot be used here without terminalizing dispatchable work.
   */
  async recoverAfterRestart(limit: number): Promise<WorkerRecoverySummary> {
    const refs = await this.options.workerRepository.listStaleNonTerminal(
      this.options.leaseMs,
      [],
      limit,
    );

    if (refs.length === 0) {
      return { outcomes: [] };
    }

    const rows: RunRow[] = [];

    for (const ref of refs) {
      try {
        rows.push(await this.runs.loadOwnedRun(ref.ownerUserId, ref.id));
      } catch {
        // Deleted between scan and load: nothing to reconcile.
      }
    }

    if (rows.length === 0) {
      return { outcomes: [] };
    }

    let report: RecoveryReport;

    try {
      report = await this.options.adapter.recoverAfterRestart({
        runIds: rows.map((row) => asRunId(row.id)),
      });
    } catch (error) {
      this.options.logger.log({
        event: 'worker.recovery_failed',
        message: error instanceof Error ? error.name : 'unknown_error',
      });

      return { outcomes: [] };
    }

    const byRun = new Map<string, RecoveryOutcome>(
      report.outcomes.map((outcome) => [outcome.runId as string, outcome]),
    );
    const outcomes: WorkerRecoveryOutcome[] = [];

    for (const row of rows) {
      try {
        outcomes.push(await this.applyRecoveryOutcome(row, byRun.get(row.id)));
      } catch (error) {
        this.options.logger.log({
          event: 'worker.recovery_apply_failed',
          runId: row.id,
          message: error instanceof Error ? error.name : 'unknown_error',
        });
      }
    }

    return { outcomes };
  }

  /** Reverts an undispatched claim on graceful shutdown (never a sent call). */
  async abandonClaim(runId: string, ownerUserId: string): Promise<void> {
    try {
      await this.options.workerRepository.releaseClaim(runId, ownerUserId);
    } catch (error) {
      this.options.logger.log({
        event: 'worker.claim_release_failed',
        runId,
        message: error instanceof Error ? error.name : 'unknown_error',
      });
    }
  }

  private async runDispatch(run: RunRow, state: InFlightState): Promise<void> {
    let request;

    try {
      request = await buildCreateRunRequest(
        this.options.workerRepository,
        run,
        this.now,
      );
    } catch (error) {
      if (error instanceof RunContextError) {
        this.options.logger.log({
          event: 'run.context_rejected',
          runId: run.id,
          reason: error.message,
        });
        await this.finalize(run, {
          status: 'failed',
          errorCode: 'invalid_request',
          dispatchState: 'not_dispatched',
          usage: unknownUsage(),
          startExecution: false,
          replaceDispatchState: true,
        });
        return;
      }

      // Nothing has been sent. Give the claim back so the loop can retry the
      // same Run instead of failing it on a transient database error.
      state.phase = 'finished';
      await this.abandonClaim(run.id, run.owner_user_id);
      throw error;
    }

    if (state.shutdown) {
      await this.abandonClaim(run.id, run.owner_user_id);
      return;
    }

    state.phase = 'dispatching';

    let created;

    try {
      created = await this.options.adapter.createRun(request);
    } catch (error) {
      if (error instanceof HarnessAdapterError) {
        await this.finalizeFromError(run, error);
        return;
      }

      // An unexpected adapter bug after the call may have produced an external
      // effect. Record ambiguity before surfacing it; never retry.
      await this.finalize(run, {
        status: 'execution_uncertain',
        errorCode: 'harness_unavailable',
        dispatchState: 'unknown',
        usage: unknownUsage(),
        startExecution: true,
      });
      throw error;
    }

    if (created.dispatchState === 'unknown') {
      await this.finalize(run, {
        status: 'execution_uncertain',
        errorCode: 'transport_ambiguous',
        dispatchState: 'unknown',
        usage: unknownUsage(),
        startExecution: true,
      });
      return;
    }

    const recorded = await this.runs.recordDispatch(
      run.id,
      run.owner_user_id,
      created.dispatchState,
      created.harnessRunId,
      created.harnessSessionId,
    );

    if (recorded === null) {
      // Cancellation or recovery terminalized the Run between claim and
      // acceptance. Do not stream into a finished Run.
      await this.finalizeFromStored(run);
      return;
    }

    if (state.shutdown) {
      // The dispatch is accepted and possibly paid. Leave the Run non-terminal
      // for restart reconciliation; ask the harness to stop best-effort.
      await this.cancelOnShutdown(run);
      return;
    }

    state.phase = 'streaming';
    await this.streamAndFinalize(run, state);
  }

  private async streamAndFinalize(
    run: RunRow,
    state: InFlightState,
  ): Promise<void> {
    let terminalOutcome: RunFailureOutcome | null = null;

    try {
      const stream = this.options.adapter.subscribe({
        runId: asRunId(run.id),
        afterSeq: 0,
        signal: state.controller.signal,
      });

      for await (const event of stream) {
        if (state.controller.signal.aborted) {
          break;
        }

        if (isTerminalRunEventType(event.type)) {
          // Persist after the DB outcome so the stored event type always
          // matches the stored status, even if a cancel won the race.
          terminalOutcome = statusForTerminalEvent(event.type);
          break;
        }

        await this.appendAdapterEvent(run, event);
      }
    } catch (error) {
      if (state.shutdown) {
        await this.cancelOnShutdown(run);
        return;
      }

      if (state.leaseLost || error instanceof RunEventStreamClosedError) {
        await this.finalizeFromStored(run);
        return;
      }

      if (error instanceof HarnessAdapterError) {
        await this.finalizeFromError(run, error);
        return;
      }

      throw error;
    }

    if (state.shutdown) {
      await this.cancelOnShutdown(run);
      return;
    }

    if (state.leaseLost) {
      await this.finalizeFromStored(run);
      return;
    }

    if (terminalOutcome !== null) {
      await this.finalizeFromTerminal(run, terminalOutcome);
      return;
    }

    await this.finalizeFromSnapshot(run);
  }

  private async finalizeFromTerminal(
    run: RunRow,
    status: RunFailureOutcome,
  ): Promise<void> {
    await this.finalize(run, {
      status,
      errorCode: status === 'failed' ? 'provider_error' : null,
      dispatchState: 'dispatched',
      usage: await this.readUsage(run.id),
      startExecution: true,
    });
  }

  private async finalizeFromSnapshot(run: RunRow): Promise<void> {
    let snapshot: RunSnapshot;

    try {
      snapshot = await this.options.adapter.getRun(asRunId(run.id));
    } catch (error) {
      if (error instanceof HarnessAdapterError) {
        await this.finalizeFromError(run, error);
        return;
      }

      throw error;
    }

    const status = mapSnapshotStatus(snapshot.status);
    const usage = await this.readUsage(run.id);

    if (status === null) {
      // The stream ended while the harness still reports a non-terminal run.
      // That is an ambiguous execution, not a retryable transport failure.
      await this.finalize(run, {
        status: 'execution_uncertain',
        errorCode: 'transport_ambiguous',
        dispatchState: 'dispatched',
        usage,
        startExecution: true,
        lastEventSeq: snapshot.lastSeq,
      });
      return;
    }

    if (snapshot.harnessStatus === 'waiting_for_approval') {
      await this.finalize(run, {
        status: 'failed',
        errorCode: 'policy_denied',
        dispatchState: 'dispatched',
        usage,
        startExecution: true,
        lastEventSeq: snapshot.lastSeq,
      });
      return;
    }

    await this.finalize(run, {
      status,
      errorCode: snapshotErrorCode(snapshot.status),
      dispatchState: 'dispatched',
      usage,
      startExecution: true,
      lastEventSeq: snapshot.lastSeq,
    });
  }

  private async finalizeFromError(
    run: RunRow,
    error: HarnessAdapterError,
  ): Promise<void> {
    const dispatchState = error.dispatchState;
    const status: RunFailureOutcome =
      dispatchState === 'unknown' ? 'execution_uncertain' : 'failed';
    const usage =
      dispatchState === 'dispatched' ? await this.readUsage(run.id) : unknownUsage();

    await this.finalize(run, {
      status,
      errorCode: error.code,
      dispatchState,
      usage,
      startExecution: dispatchState !== 'not_dispatched',
      replaceDispatchState: dispatchState === 'not_dispatched',
    });
  }

  /** Reloads the stored outcome and completes a Run another writer finalized. */
  private async finalizeFromStored(run: RunRow): Promise<void> {
    let current: RunRow;

    try {
      current = await this.runs.loadOwnedRun(run.owner_user_id, run.id);
    } catch (error) {
      this.options.logger.log({
        event: 'run.finalize_failed',
        runId: run.id,
        message: error instanceof Error ? error.name : 'unknown_error',
      });
      return;
    }

    if (!isTerminalRunStatus(current.status)) {
      await this.finalize(run, {
        status: 'execution_uncertain',
        errorCode: 'transport_ambiguous',
        dispatchState: 'dispatched',
        usage: unknownUsage(),
        startExecution: true,
      });
      return;
    }

    await this.appendTerminal(run, current);
    await this.settleReservation(run, current);
    this.options.logger.log({
      event: 'run.terminal',
      runId: run.id,
      status: current.status,
      errorCode: current.error_code,
      recordedBy: 'other_writer',
    });
  }

  /**
   * One atomic terminal write, then the matching terminal event. A losing writer
   * adopts the stored row and still appends the *stored* outcome, so replay ends
   * exactly once and never contradicts the Run row.
   */
  private async finalize(run: RunRow, decision: RunDecision): Promise<void> {
    let finalRow: RunRow;

    try {
      const updated = await this.runs.terminalize({
        runId: run.id,
        ownerUserId: run.owner_user_id,
        status: decision.status,
        dispatchState: decision.dispatchState,
        errorCode: decision.errorCode,
        usage: decision.usage,
        lastEventSeq: decision.lastEventSeq ?? 0,
        startExecution: decision.startExecution,
        ...(decision.replaceDispatchState === true
          ? { replaceDispatchState: true }
          : {}),
      });

      finalRow =
        updated ?? (await this.runs.loadOwnedRun(run.owner_user_id, run.id));
    } catch (error) {
      this.options.logger.log({
        event: 'run.finalize_failed',
        runId: run.id,
        message: error instanceof Error ? error.name : 'unknown_error',
      });
      return;
    }

    await this.settleReservation(run, finalRow);
    await this.appendTerminal(run, finalRow);

    this.options.logger.log({
      event: 'run.terminal',
      runId: run.id,
      status: finalRow.status,
      dispatchState: finalRow.dispatch_state,
      errorCode: finalRow.error_code,
    });
  }

  private async appendAdapterEvent(
    run: RunRow,
    event: Pick<RunEvent, 'type' | 'payload' | 'seq'>,
  ): Promise<void> {
    const payload =
      typeof event.payload === 'object' && event.payload !== null
        ? event.payload
        : {};

    await this.options.events.append(run.owner_user_id, {
      runId: run.id,
      type: event.type,
      payload,
      eventId: deterministicEventId(run.id, `event:${event.seq}`),
    });
  }

  private async appendTerminal(run: RunRow, finalRow: RunRow): Promise<void> {
    if (!isTerminalRunStatus(finalRow.status)) {
      return;
    }

    if (finalRow.usage_status !== 'unknown') {
      await this.appendSafely(run, {
        type: 'usage.recorded',
        payload: {
          usageStatus: finalRow.usage_status,
          grossPromptTokens: toNullableNumber(finalRow.usage_gross_prompt_tokens),
          grossCompletionTokens: toNullableNumber(
            finalRow.usage_gross_completion_tokens,
          ),
          cachedPromptTokens: toNullableNumber(finalRow.usage_cached_prompt_tokens),
          reasoningTokens: toNullableNumber(finalRow.usage_reasoning_tokens),
          totalTokens: toNullableNumber(finalRow.usage_total_tokens),
          costStatus: finalRow.usage_cost_status,
        },
        eventId: deterministicEventId(run.id, USAGE_EVENT_DISCRIMINATOR),
      });
    }

    await this.appendSafely(run, {
      type: terminalEventType(finalRow.status),
      payload: {
        errorCode: finalRow.error_code,
        usageStatus: finalRow.usage_status,
      },
      eventId: deterministicEventId(run.id, TERMINAL_EVENT_DISCRIMINATOR),
    });
  }

  private async appendSafely(
    run: RunRow,
    input: {
      type: string;
      payload: Readonly<Record<string, unknown>>;
      eventId: string;
    },
  ): Promise<void> {
    try {
      await this.options.events.append(run.owner_user_id, {
        runId: run.id,
        type: input.type,
        payload: input.payload,
        eventId: input.eventId,
      });
    } catch (error) {
      if (error instanceof RunEventStreamClosedError) {
        return;
      }

      this.options.logger.log({
        event: 'run.event_append_failed',
        runId: run.id,
        eventType: input.type,
        message: error instanceof Error ? error.name : 'unknown_error',
      });
    }
  }

  /**
   * Settles the H-023 reservation from the stored row. A proven pre-dispatch
   * failure releases the hold; anything that may have run settles with the
   * persisted usage, where `unknown` keeps the estimate held rather than zero.
   */
  private async settleReservation(run: RunRow, finalRow: RunRow): Promise<void> {
    let reservation;

    try {
      reservation = await this.options.workerRepository.findReservation(
        run.id,
        run.owner_user_id,
      );
    } catch (error) {
      this.options.logger.log({
        event: 'run.usage_lookup_failed',
        runId: run.id,
        message: error instanceof Error ? error.name : 'unknown_error',
      });
      return;
    }

    if (reservation === null || reservation.state !== 'reserved') {
      return;
    }

    try {
      if (finalRow.dispatch_state === 'not_dispatched') {
        await this.options.limits.release(reservation.id, {
          ownerUserId: run.owner_user_id,
        });
        return;
      }

      const usage: SettleUsageInput = {
        status: finalRow.usage_status,
        grossPromptTokens: toNullableNumber(finalRow.usage_gross_prompt_tokens),
        grossCompletionTokens: toNullableNumber(
          finalRow.usage_gross_completion_tokens,
        ),
        cachedPromptTokens: toNullableNumber(finalRow.usage_cached_prompt_tokens),
        reasoningTokens: toNullableNumber(finalRow.usage_reasoning_tokens),
        totalTokens: toNullableNumber(finalRow.usage_total_tokens),
      };

      await this.options.limits.settle(reservation.id, usage, {
        ownerUserId: run.owner_user_id,
      });
    } catch (error) {
      this.options.logger.log({
        event: 'run.usage_settlement_failed',
        runId: run.id,
        message: error instanceof Error ? error.name : 'unknown_error',
      });
    }
  }

  private async readUsage(runId: string): Promise<PersistedRunUsage> {
    try {
      return normalizeUsage(await this.options.adapter.getUsage(asRunId(runId)));
    } catch {
      return unknownUsage();
    }
  }

  /** Best-effort stop for an accepted dispatch during shutdown. */
  private async cancelOnShutdown(run: RunRow): Promise<void> {
    try {
      await this.options.adapter.cancel({
        runId: asRunId(run.id),
        reason: 'shutdown',
      });
    } catch (error) {
      this.options.logger.log({
        event: 'run.shutdown_cancel_failed',
        runId: run.id,
        message: error instanceof Error ? error.name : 'unknown_error',
      });
    }
  }

  private async handleUnexpected(
    run: RunRow,
    state: InFlightState,
    error: unknown,
  ): Promise<void> {
    if (state.shutdown) {
      return;
    }

    if (state.phase === 'claimed') {
      // Nothing was sent; the claim was already released or can be.
      await this.abandonClaim(run.id, run.owner_user_id);
      this.options.logger.log({
        event: 'run.dispatch_deferred',
        runId: run.id,
        message: error instanceof Error ? error.name : 'unknown_error',
      });
      return;
    }

    this.options.logger.log({
      event: 'run.dispatch_failed',
      runId: run.id,
      message: error instanceof Error ? error.name : 'unknown_error',
    });

    await this.finalize(run, {
      status: 'execution_uncertain',
      errorCode: 'harness_unavailable',
      dispatchState: 'unknown',
      usage: unknownUsage(),
      startExecution: true,
    });
  }

  private startHeartbeat(run: RunRow, state: InFlightState): NodeJS.Timeout {
    const intervalMs = Math.max(
      HEARTBEAT_FLOOR_MS,
      Math.floor(this.options.leaseMs / 3),
    );

    const timer = setInterval(() => {
      void this.options.workerRepository
        .heartbeat(run.id, run.owner_user_id)
        .then((alive) => {
          if (!alive && state.phase !== 'finished') {
            state.leaseLost = true;
            state.controller.abort();
          }
        })
        .catch((error: unknown) => {
          this.options.logger.log({
            event: 'run.heartbeat_failed',
            runId: run.id,
            message: error instanceof Error ? error.name : 'unknown_error',
          });
        });
    }, intervalMs);

    timer.unref();

    return timer;
  }

  private async applyRecoveryOutcome(
    row: RunRow,
    outcome: RecoveryOutcome | undefined,
  ): Promise<WorkerRecoveryOutcome> {
    if (outcome === undefined) {
      await this.applyLost(row, 'harness_unavailable');
      return { runId: row.id, outcome: 'lost', status: 'execution_uncertain' };
    }

    if (outcome.kind === 'still_running') {
      const resumeAfter = Math.max(
        outcome.resumeAfterSeq,
        outcome.snapshot.lastSeq,
        toSequence(row.last_event_seq),
      );
      const updated = await this.runs.recordStillRunning(
        row.id,
        row.owner_user_id,
        resumeAfter,
      );
      const finalRow =
        updated ?? (await this.runs.loadOwnedRun(row.owner_user_id, row.id));

      return {
        runId: row.id,
        outcome: 'still_running',
        status: finalRow.status,
      };
    }

    if (outcome.kind === 'lost') {
      const dispatchState = lostDispatchState(outcome.dispatchState);
      await this.applyLost(
        row,
        dispatchState === 'not_dispatched'
          ? 'harness_unavailable'
          : 'transport_ambiguous',
        dispatchState,
      );

      return { runId: row.id, outcome: 'lost', status: 'execution_uncertain' };
    }

    const snapshot = outcome.snapshot;
    const status = mapSnapshotStatus(snapshot.status);

    if (status === null) {
      await this.applyLost(row, 'harness_unavailable');
      return { runId: row.id, outcome: 'lost', status: 'execution_uncertain' };
    }

    if (snapshot.harnessStatus === 'waiting_for_approval') {
      await this.finalize(row, {
        status: 'failed',
        errorCode: 'policy_denied',
        dispatchState: 'dispatched',
        usage: await this.readUsage(row.id),
        startExecution: true,
        lastEventSeq: snapshot.lastSeq,
      });

      return {
        runId: row.id,
        outcome: 'confirmed_terminal',
        status: 'failed',
      };
    }

    await this.finalize(row, {
      status,
      errorCode: snapshotErrorCode(snapshot.status),
      dispatchState: 'dispatched',
      usage: await this.readUsage(row.id),
      startExecution: true,
      lastEventSeq: snapshot.lastSeq,
    });

    return {
      runId: row.id,
      outcome: 'confirmed_terminal',
      status,
    };
  }

  private async applyLost(
    row: RunRow,
    errorCode: string,
    dispatchState?: DispatchState,
  ): Promise<void> {
    const resolved = dispatchState ?? lostDispatchState(row.dispatch_state);
    const usage =
      resolved === 'not_dispatched'
        ? unknownUsage()
        : await this.readUsage(row.id);

    await this.finalize(row, {
      status: 'execution_uncertain',
      errorCode,
      dispatchState: resolved,
      usage,
      startExecution: resolved !== 'not_dispatched',
      replaceDispatchState: true,
    });
  }
}
