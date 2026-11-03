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
import { RunIdempotencyConflictError } from './errors.js';
import { RunRepository, toRunView, type RunRow } from './run-repository.js';
import {
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
  RunFailureOutcome,
  RunRecoveryResult,
  RunRecoverySummary,
  RunView,
} from './types.js';

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

export class RunService {
  private readonly repository: RunRepository;

  constructor(
    private readonly pool: Pool,
    private readonly adapter: HarnessAdapter,
  ) {
    this.repository = new RunRepository(pool);
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

    return this.dispatchOnce(reserved, request);
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

    return toRunView(finalRow);
  }

  /**
   * Reconciles non-terminal Runs after a restart. `lost` becomes terminal
   * `execution_uncertain` with no dispatch retry; `confirmed_terminal` adopts
   * the harness outcome and usage; `still_running` only advances the replay
   * cursor. An already-terminal row is never rewritten.
   */
  async recoverAfterRestart(ownerUserId?: string): Promise<RunRecoverySummary> {
    const rows = await this.repository.listNonTerminal(ownerUserId ?? null);

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
  ): Promise<CreateRunOutcome> {
    let result;

    try {
      result = await this.adapter.createRun(request);
    } catch (error) {
      if (error instanceof HarnessAdapterError) {
        const row = await this.finishDispatchFailure(reserved, error);
        return { run: toRunView(row), deduplicated: false };
      }

      // An unexpected controller/adapter bug is still an ambiguous external
      // effect: persist the safe outcome before surfacing the error.
      await this.repository.terminalize({
        runId: reserved.id,
        ownerUserId: reserved.owner_user_id,
        status: 'execution_uncertain',
        dispatchState: 'unknown',
        errorCode: 'harness_unavailable',
        usage: unknownUsage(),
        lastEventSeq: 0,
        startExecution: true,
      });
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
      return { run: toRunView(row), deduplicated: false };
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

    return { run: toRunView(row), deduplicated: false };
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
    });

    return (
      updated ??
      (await this.repository.loadOwnedRun(reserved.owner_user_id, reserved.id))
    );
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

    return {
      runId: row.id,
      outcome: 'lost',
      status: finalRow.status,
      lastEventSeq: toSequence(finalRow.last_event_seq),
    };
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
