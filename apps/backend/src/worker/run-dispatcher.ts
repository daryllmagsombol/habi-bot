/**
 * Run dispatcher: the worker-side half of the H-022 run lifecycle.
 *
 * The worker selects queued reservations and hands each one to
 * `RunService.dispatchReserved`, which owns the single atomic
 * `not_dispatched` -> `unknown` claim and the provider call. This module then:
 *
 *   1. streams adapter events into `RunEventStore.append` *in adapter order*.
 *      The store allocates the server sequence and publishes the Run id on its
 *      hub after the append transaction commits, which is the existing replay
 *      contract; this module adds no second sequencing or fan-out;
 *   2. records exactly one terminal state and appends at most one terminal
 *      event whose type matches the stored status;
 *   3. settles or releases the H-023 allowance reservation for the Run.
 *
 * Safety rules are shared with the service rather than reimplemented:
 *   - `unknown` dispatch is terminal `execution_uncertain` and is never retried;
 *   - a proven `not_dispatched` failure is `failed` (a user retry is a new Run);
 *   - usage is `known`/`partial`/`unknown`, and unknown stays null;
 *   - terminal writes are single atomic updates guarded by the non-terminal
 *     status, so a concurrent cancel or recovery wins without a rewrite.
 *
 * Recovery is also delegate-only: `RunService.recoverAfterRestart({ lease })`
 * scans only expired claims, so a fresh queued reservation is never terminalized
 * by a running worker.
 */
import type { Pool } from 'pg';
import { HarnessAdapterError } from '../adapters/harness-adapter.js';
import type {
  DispatchState,
  HarnessAdapter,
  Id,
  RunEvent,
  RunSnapshot,
  RunSnapshotStatus,
} from '../adapters/harness-adapter.js';
import {
  RunEventStreamClosedError,
  isTerminalRunEventType,
} from '../events/index.js';
import type { RunEventStore } from '../events/index.js';
import type { UsageLimitService } from '../limits/index.js';
import {
  MAX_CANCEL_ATTEMPTS,
  RunRepository,
  RunService,
  applyTerminalSideEffects,
  deterministicEventId,
} from '../runs/index.js';
import type {
  CancelIntentKind,
  CancelIntentOutcome,
  RunDispatchOutcome,
  RunRecoverySummary,
  RunRow,
  RunFailureOutcome,
  RunSideEffectDeps,
} from '../runs/index.js';
import { normalizeUsage, unknownUsage } from '../runs/usage.js';
import type { PersistedRunUsage } from '../runs/usage.js';
import { isTerminalRunStatus } from '../runs/types.js';
import type { WorkerLogger } from './logger.js';
import type { WorkerRunRepository } from './run-claim-repository.js';

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
  controller: AbortController;
  phase: 'claimed' | 'dispatching' | 'streaming' | 'finished';
  leaseLost: boolean;
  shutdown: boolean;
  /**
   * Set when the heartbeat observed a durable cancellation intent. The stream is
   * aborted to hand control back to the cancel path; a recoverable adapter
   * failure clears it and resumes streaming under a fresh controller.
   */
  cancelRequested: boolean;
}

export interface RunDispatcherOptions {
  readonly pool: Pool;
  readonly adapter: HarnessAdapter;
  readonly workerRepository: WorkerRunRepository;
  readonly events: RunEventStore;
  readonly limits: UsageLimitService;
  readonly logger: WorkerLogger;
  readonly leaseMs: number;
}

const HEARTBEAT_FLOOR_MS = 250;

function asRunId(id: string): Id<'Run'> {
  return id as Id<'Run'>;
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

function cancelLogEvent(kind: CancelIntentKind): string {
  switch (kind) {
    case 'terminal':
      return 'run.cancel_confirmed';
    case 'failed':
      return 'run.cancel_failed';
    case 'exhausted':
      return 'run.cancel_exhausted';
    case 'deferred':
      return 'run.cancel_deferred';
    default:
      return 'run.cancel_observed';
  }
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
  private readonly service: RunService;
  private readonly effects: RunSideEffectDeps;

  constructor(private readonly options: RunDispatcherOptions) {
    this.runs = new RunRepository(options.pool);
    this.service = new RunService(options.pool, options.adapter, {
      events: options.events,
      limits: options.limits,
      logger: options.logger,
    });
    this.effects = {
      repository: this.runs,
      events: options.events,
      limits: options.limits,
      logger: options.logger,
    };
  }

  /**
   * Dispatches one selected Run. Resolves for every expected outcome; only an
   * unexpected programming failure escapes, and the caller records it.
   */
  async dispatch(run: RunRow, shutdownSignal: AbortSignal): Promise<void> {
    const state: InFlightState = {
      controller: new AbortController(),
      phase: 'claimed',
      leaseLost: false,
      shutdown: false,
      cancelRequested: false,
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
   */
  async recoverAfterRestart(limit: number): Promise<RunRecoverySummary> {
    try {
      return await this.service.recoverAfterRestart({
        lease: { staleAfterMs: this.options.leaseMs, limit },
      });
    } catch (error) {
      this.options.logger.log({
        event: 'worker.recovery_failed',
        message: error instanceof Error ? error.name : 'unknown_error',
      });

      return { outcomes: [] };
    }
  }

  /**
   * Handles durable cancellation intents for Runs this process is not streaming.
   * A Run cancelled while still queued, or one orphaned by a worker restart, has
   * no live heartbeat, so the idle loop is its observation point. Runs with a
   * local in-flight task are excluded: their own heartbeat owns the attempt.
   */
  async processCancelIntents(
    limit: number,
    excludeRunIds: readonly string[],
  ): Promise<number> {
    try {
      const outcomes = await this.service.processCancelIntents(
        limit,
        excludeRunIds,
      );

      for (const outcome of outcomes) {
        this.options.logger.log({
          event: cancelLogEvent(outcome.kind),
          runId: outcome.run.id,
          outcome: outcome.kind,
          status: outcome.run.status,
          errorCode: outcome.errorCode,
        });
      }

      return outcomes.length;
    } catch (error) {
      this.options.logger.log({
        event: 'worker.cancel_sweep_failed',
        message: error instanceof Error ? error.name : 'unknown_error',
      });

      return 0;
    }
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
    if (state.shutdown) {
      return;
    }

    const outcome: RunDispatchOutcome = await this.service.dispatchReserved(
      run.owner_user_id,
      run.id,
    );

    if (!outcome.dispatched) {
      // A terminal outcome already has its allowance/event side effects (or was
      // terminalized by another writer); applying them again is idempotent.
      if (isTerminalRunStatus(outcome.run.status)) {
        await this.finalizeFromStored(run);
      }

      return;
    }

    if (state.shutdown) {
      // The dispatch is accepted and possibly paid. Leave the Run non-terminal
      // for restart reconciliation; ask the harness to stop best-effort.
      await this.cancelOnShutdown(run);
      return;
    }

    state.phase = 'streaming';

    if (state.cancelRequested) {
      // The intent arrived while the create call was in flight. The dispatch is
      // now accepted, so it is safe to stop it.
      if (!(await this.processCancel(run, state))) {
        return;
      }
    }

    await this.streamAndFinalize(run, state);
  }

  private async streamAndFinalize(
    run: RunRow,
    state: InFlightState,
  ): Promise<void> {
    for (;;) {
      let terminalOutcome: RunFailureOutcome | null = null;

      try {
        const stream = this.options.adapter.subscribe({
          runId: asRunId(run.id),
          afterSeq: 0,
          signal: state.controller.signal,
        });

        for await (const event of stream) {
          if (state.cancelRequested || state.controller.signal.aborted) {
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
        if (state.cancelRequested) {
          // The abort was ours; the cancel path owns the outcome.
        } else if (state.shutdown) {
          await this.cancelOnShutdown(run);
          return;
        } else if (
          state.leaseLost ||
          error instanceof RunEventStreamClosedError
        ) {
          await this.finalizeFromStored(run);
          return;
        } else if (error instanceof HarnessAdapterError) {
          await this.finalizeFromError(run, error);
          return;
        } else {
          throw error;
        }
      }

      if (state.cancelRequested) {
        if (!(await this.processCancel(run, state))) {
          return;
        }

        // The adapter was not reached or another processor holds the attempt.
        // Keep the Run alive by resuming the stream under a fresh controller;
        // the next heartbeat retries the intent.
        continue;
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
      return;
    }
  }

  /**
   * Honours the outstanding cancellation intent. Returns true when the Run is
   * still live (the attempt failed or was deferred) and streaming must resume;
   * false when the Run reached a terminal state or the worker is shutting down.
   */
  private async processCancel(
    run: RunRow,
    state: InFlightState,
  ): Promise<boolean> {
    state.cancelRequested = false;
    state.controller = new AbortController();

    let outcome: CancelIntentOutcome;

    try {
      outcome = await this.service.applyCancelIntent(run.owner_user_id, run.id);
    } catch (error) {
      this.options.logger.log({
        event: 'run.cancel_failed',
        runId: run.id,
        message: error instanceof Error ? error.name : 'unknown_error',
      });

      // A database/transport failure while honouring the intent must not
      // terminalize the Run. Resume streaming; the intent is durable.
      return !(state.shutdown || state.leaseLost);
    }

    this.options.logger.log({
      event: cancelLogEvent(outcome.kind),
      runId: run.id,
      outcome: outcome.kind,
      status: outcome.run.status,
      errorCode: outcome.errorCode,
    });

    if (outcome.kind === 'terminal' || outcome.kind === 'exhausted') {
      // `exhausted` is terminal `execution_uncertain`: the stop could not be
      // confirmed, so the Run is not left streaming.
      return false;
    }

    if (state.shutdown || state.leaseLost) {
      // Leave a non-terminal Run for restart reconciliation rather than
      // resuming a stream this process is about to abandon.
      return false;
    }

    return outcome.kind !== 'none';
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

    await applyTerminalSideEffects(this.effects, current);
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

    await applyTerminalSideEffects(this.effects, finalRow);

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
      // Nothing was sent; the claim, if any, was already released or can be.
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
        .then((result) => {
          if (state.phase === 'finished') {
            return;
          }

          if (!result.alive) {
            state.leaseLost = true;
            state.controller.abort();
            return;
          }

          if (
            result.cancel !== null &&
            result.cancel.attempts < MAX_CANCEL_ATTEMPTS &&
            !state.cancelRequested
          ) {
            // A durable intent is observed on the first heartbeat tick after it
            // commits. Once the Run is streaming the subscription is aborted so
            // the cancel path runs immediately instead of waiting for the next
            // event; a failed attempt resumes the stream.
            state.cancelRequested = true;

            if (state.phase === 'streaming') {
              state.controller.abort();
            }
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
}
