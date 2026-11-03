/**
 * H-022 (#22) durable run controller types.
 *
 * Habi identifiers are authoritative. Harness ids are opaque metadata written
 * only from an adapter result and never accepted from a client. Usage is
 * `known`, `partial`, or `unknown`; unknown is `null` in every token field,
 * never `0`.
 */
import type {
  CancelReason,
  DispatchState,
  UsageStatus,
} from '../adapters/harness-adapter.js';

/**
 * Outcomes this controller writes. `retry_wait` and `timed_out` remain legal in
 * the schema for the H-002 state machine and legacy rows, but are not produced
 * by this slice (there is no retry or deadline scheduler here).
 */
export type RunStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'execution_uncertain';

export type LegacyRunStatus = 'retry_wait' | 'timed_out';

/** Every status an existing row may carry, including H-002 states not written here. */
export type PersistedRunStatus = RunStatus | LegacyRunStatus;

export type RunFailureOutcome =
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'execution_uncertain';

/** Server-owned usage snapshot. `unknown` always has null token counts. */
export interface RunUsage {
  status: UsageStatus;
  grossPromptTokens: number | null;
  grossCompletionTokens: number | null;
  cachedPromptTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  costStatus: 'known' | 'unknown';
}

/** Owner-visible Run projection. Harness ids and raw usage stay server-side. */
export interface RunView {
  id: string;
  conversationId: string;
  status: PersistedRunStatus;
  dispatchState: DispatchState;
  errorCode: string | null;
  lastEventSeq: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  usage: RunUsage;
}

/** One Habi-selected context message handed to the adapter. */
export interface RunMessageInput {
  role: 'user' | 'assistant' | 'system';
  content: string;
  messageId: string;
}

export interface RunTokenBudget {
  maxInputTokens: number;
  maxOutputTokens: number | null;
}

/**
 * Caller input for reserving and dispatching a Run. The controller resolves the
 * Bot from the owned conversation; `botId` is accepted only as a consistency
 * assertion. Budget/deadline overrides exist because the authorization and
 * allowance layers are not wired in this slice.
 */
export interface CreateRunInput {
  ownerUserId: string;
  conversationId: string;
  botId?: string;
  idempotencyKey: string;
  messages?: readonly RunMessageInput[];
  deadlineAt?: string;
  tokenBudget?: RunTokenBudget;
  allowedTools?: readonly string[];
}

export interface CreateRunOutcome {
  run: RunView;
  /** True when the same key and fingerprint returned the existing Run. */
  deduplicated: boolean;
}

export type RunRecoveryKind =
  | 'confirmed_terminal'
  | 'still_running'
  | 'lost';

export interface RunRecoveryResult {
  runId: string;
  outcome: RunRecoveryKind;
  status: PersistedRunStatus;
  lastEventSeq: number;
}

export interface RunRecoverySummary {
  outcomes: RunRecoveryResult[];
}

export type RunCancelReason = CancelReason;

export const RUN_TERMINAL_STATUSES: ReadonlySet<PersistedRunStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
  'timed_out',
  'execution_uncertain',
]);

/** Statuses a worker/controller may still transition out of. */
export const RUN_NON_TERMINAL_STATUSES: readonly PersistedRunStatus[] = [
  'queued',
  'running',
  'retry_wait',
];

export function isTerminalRunStatus(status: PersistedRunStatus): boolean {
  return RUN_TERMINAL_STATUSES.has(status);
}
