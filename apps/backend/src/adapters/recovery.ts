/**
 * H-021 (#21) restart reconciliation helpers.
 *
 * `recoverAfterRestart` in the Hermes adapter reuses `getRun`; there is no
 * dedicated recovery route (design §3, §6.4). This module holds the pure
 * classification rules so the terminal/still-running/lost decision is testable
 * and identical for any future adapter:
 *
 *   confirmed_terminal  harness reports a status Habi may finalize now
 *                       (`completed`, `failed`, `cancelled`, and the no-tool
 *                       policy outcome `waiting_for_approval` -> failed)
 *   still_running       harness reports a non-terminal status; resume from the
 *                       highest applied Habi seq
 *   lost                404, missing mapping, or ambiguous transport; Habi owns
 *                       the outcome and must not retry paid work
 *
 * `lost` deliberately collapses the dispatch state: once the harness cannot
 * confirm a run that may have been dispatched, Habi records `unknown` and
 * produces `execution_uncertain` rather than assuming nothing happened.
 */
import { isTerminalHarnessStatus } from './harness-adapter.js';
import type {
  DispatchState,
  HarnessRunStatus,
  Id,
  RecoveryOutcome,
  RunSnapshot,
} from './harness-adapter.js';

export type RecoveryClassification =
  | 'confirmed_terminal'
  | 'still_running'
  | 'lost';

/**
 * Classifies a harness status for reconciliation. `null` means the status was
 * absent or unrecognized and the caller must treat the run as `lost`.
 */
export function classifyHarnessStatus(
  status: HarnessRunStatus | null,
): Exclude<RecoveryClassification, 'lost'> | null {
  if (status === null) {
    return null;
  }

  if (status === 'waiting_for_approval' || isTerminalHarnessStatus(status)) {
    return 'confirmed_terminal';
  }

  return 'still_running';
}

/**
 * A lost run preserves `not_dispatched` only when that was already proven;
 * everything else becomes `unknown`, which is terminal for Habi but never
 * retried automatically.
 */
export function lostDispatchState(dispatchState: DispatchState): DispatchState {
  return dispatchState === 'not_dispatched' ? 'not_dispatched' : 'unknown';
}

export function lostOutcome(
  runId: Id<'Run'>,
  dispatchState: DispatchState,
): RecoveryOutcome {
  return {
    kind: 'lost',
    runId,
    dispatchState: lostDispatchState(dispatchState),
  };
}

export function confirmedTerminalOutcome(
  runId: Id<'Run'>,
  snapshot: RunSnapshot,
): RecoveryOutcome {
  return { kind: 'confirmed_terminal', runId, snapshot };
}

export function stillRunningOutcome(
  runId: Id<'Run'>,
  snapshot: RunSnapshot,
  resumeAfterSeq: number,
): RecoveryOutcome {
  return { kind: 'still_running', runId, snapshot, resumeAfterSeq };
}
