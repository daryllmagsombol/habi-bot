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
 * Attempt bound for one durable cancellation intent. The first attempt plus two
 * retries covers a transient harness outage without turning "stop this Run" into
 * an unbounded loop against a provider.
 */
export const MAX_CANCEL_ATTEMPTS = 3;

/**
 * How long one claimed cancellation attempt blocks another processor from
 * starting its own. It only spans the adapter call; a recorded failure is
 * retryable immediately, and a crash makes the claim retryable after this bound.
 */
export const CANCEL_CLAIM_TTL_MS = 30_000;

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
  /**
   * Durable user intent to stop a Run that may already be dispatched. A
   * non-null value on a non-terminal Run means the request was accepted and the
   * owning worker has not confirmed the stop yet; `status` stays truthful.
   */
  cancelRequestedAt: string | null;
  /** Last recoverable adapter failure while honouring the intent, if any. */
  cancelErrorCode: string | null;
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

/**
 * Result of dispatching an already-reserved Run.
 *
 * `dispatched` is true only when this call won the single atomic claim and the
 * adapter accepted the dispatch. A terminal or already-claimed Run returns its
 * stored projection with `dispatched: false` and never reaches the provider.
 */
export interface RunDispatchOutcome {
  run: RunView;
  dispatched: boolean;
}

/**
 * Lease-scoped recovery filter. Only rows whose heartbeat/claim timestamp is
 * older than `staleAfterMs` and that may already have been claimed/dispatched
 * are selected, so a fresh queued reservation stays dispatchable.
 */
export interface RunRecoveryLeaseFilter {
  staleAfterMs: number;
  excludeRunIds?: readonly string[];
  limit?: number;
}

/**
 * Recovery scope. Omit it for the historical full sweep. A bare owner string is
 * accepted for compatibility with the original owner-scoped call.
 */
export interface RunRecoveryFilter {
  ownerUserId?: string;
  runIds?: readonly string[];
  lease?: RunRecoveryLeaseFilter;
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

/**
 * Outcome of honouring (or declining to honour) one durable cancellation
 * intent. `run` is always the stored projection, never a fabricated state.
 *
 *   - `none`:      no intent is outstanding (already handled or never set).
 *   - `terminal`:  the Run is terminal. Either this call confirmed `cancelled`,
 *                  or the harness reported a different authoritative outcome.
 *   - `deferred`:  another processor holds the current attempt; this caller did
 *                  nothing and keeps the Run non-terminal.
 *   - `failed`:    the adapter was not reached. The intent and its error code
 *                  are durable, the attempt count advanced, and a bounded retry
 *                  remains. The Run is NOT marked cancelled.
 *   - `exhausted`: the attempt bound is spent with no acknowledgement. The Run
 *                  is terminal `execution_uncertain` (never `cancelled`) and
 *                  the honest last error stays on the row.
 */
export type CancelIntentKind =
  | 'none'
  | 'terminal'
  | 'deferred'
  | 'failed'
  | 'exhausted';

export interface CancelIntentOutcome {
  kind: CancelIntentKind;
  run: RunView;
  errorCode: string | null;
}

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
