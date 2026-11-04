/**
 * H-022 (#22) run controller exports.
 *
 * Importing this barrel creates nothing and touches no database or network.
 * RunService is constructed explicitly by the composing lane with a Pool and a
 * HarnessAdapter. HTTP routing, Nest providers, queue workers, and deadline
 * scheduling are not part of this slice.
 */
export { RunIdempotencyConflictError, RunContextError } from './errors.js';
export {
  deterministicEventId,
  applyTerminalSideEffects,
  terminalEventType,
} from './finalization.js';
export type { RunSideEffectDeps, RunSideEffectLogger } from './finalization.js';
export {
  MAX_CONTEXT_MESSAGES,
  RunRepository,
  toRunView,
  triggerMessageId,
} from './run-repository.js';
export type {
  RecoveryScanFilter,
  RunContextMessageRow,
  RunReservationRef,
  RunRow,
} from './run-repository.js';
export { RunService } from './run-service.js';
export type { RunServiceOptions } from './run-service.js';
export { normalizeUsage, unknownUsage } from './usage.js';
export type { PersistedRunUsage } from './usage.js';
export {
  DEFAULT_DEADLINE_MS,
  DEFAULT_MAX_INPUT_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  fingerprintRunRequest,
} from './validation.js';
export {
  isTerminalRunStatus,
  RUN_NON_TERMINAL_STATUSES,
  RUN_TERMINAL_STATUSES,
} from './types.js';
export type {
  CreateRunInput,
  CreateRunOutcome,
  PersistedRunStatus,
  RunCancelReason,
  RunDispatchOutcome,
  RunFailureOutcome,
  RunMessageInput,
  RunRecoveryFilter,
  RunRecoveryKind,
  RunRecoveryLeaseFilter,
  RunRecoveryResult,
  RunRecoverySummary,
  RunStatus,
  RunTokenBudget,
  RunUsage,
  RunView,
} from './types.js';
