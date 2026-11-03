/**
 * H-021 (#21) harness adapter contract — Hermes first implementation.
 *
 * This file is framework-free TypeScript: no NestJS, no HTTP client, no
 * database. It mirrors
 * docs/superpowers/specs/2026-11-03-hermes-adapter-contract-design.md §2 and
 * fixes the vocabulary every adapter (Hermes now, direct-call later) must use:
 *
 *   - Habi identifiers are authoritative; harness identifiers are opaque and
 *     only ever looked up from a `runId` mapping.
 *   - Every dispatch records one of `not_dispatched`, `dispatched`, `unknown`.
 *     `unknown` is never retried automatically.
 *   - Failures carry a normalized code plus the dispatch state, so callers can
 *     decide without parsing vendor text or trusting an HTTP status alone.
 *   - Usage is `known`, `partial`, or `unknown`; `unknown` is represented by
 *     `null`, never `0`.
 *
 * Nothing here authorizes, selects context, reserves budget, or decides an
 * allowance. Callers must do that first.
 */

export type Id<T> = string & { readonly __brand: T };

export interface ChatMessage {
  readonly role: 'user' | 'assistant' | 'system';
  readonly content: string;
  readonly messageId: Id<'Message'>;
}

export interface CreateRunRequest {
  readonly runId: Id<'Run'>;
  /** Unique per `(ownerUserId, idempotencyKey)`; the caller owns dedupe truth. */
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly ownerUserId: Id<'User'>;
  readonly conversationId: Id<'Conversation'>;
  readonly botId: Id<'Bot'>;
  /** Habi-selected context. The adapter must not re-select memory. */
  readonly messages: readonly ChatMessage[];
  /** ISO-8601 UTC. Habi-enforced; adapter handling is best-effort. */
  readonly deadlineAt: string;
  readonly tokenBudget: {
    readonly maxInputTokens: number;
    readonly maxOutputTokens: number | null;
  };
  /** MUST be empty in the POC. A non-empty list is rejected before dispatch. */
  readonly allowedTools: readonly string[];
}

export type DispatchState = 'not_dispatched' | 'dispatched' | 'unknown';

export type HarnessRunStatus =
  | 'queued'
  | 'running'
  | 'waiting_for_approval'
  | 'stopping'
  | 'cancelled'
  | 'failed'
  | 'completed';

export interface CreateRunResult {
  readonly runId: Id<'Run'>;
  readonly harnessSessionId: string | null;
  readonly harnessRunId: string | null;
  readonly dispatchState: DispatchState;
  /** True when the same key returned the same run without a second dispatch. */
  readonly deduplicated: boolean;
  readonly acceptedAt: string;
}

export interface SubscribeRequest {
  readonly runId: Id<'Run'>;
  readonly afterSeq: number;
  readonly signal?: AbortSignal;
}

/**
 * H-002 envelope. The adapter emits at-least-once; consumers dedupe by
 * `(runId, seq)` before applying any UI or transcript effect.
 */
export type RunEventType =
  | 'run.created'
  | 'message.delta'
  | 'message.completed'
  | 'usage.recorded'
  | 'run.completed'
  | 'run.failed'
  | 'run.cancelled'
  | 'policy.denied'
  // Harness event names are passed through unchanged when they have no Habi
  // equivalent yet (for example `reasoning.available`).
  | (string & Record<never, never>);

export interface RunEvent {
  readonly id: string;
  readonly runId: Id<'Run'>;
  readonly ownerUserId: Id<'User'>;
  readonly conversationId: Id<'Conversation'>;
  readonly seq: number;
  readonly type: RunEventType;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export type SubscribeResult = AsyncIterable<RunEvent>;

export type CancelReason = 'user' | 'deadline' | 'shutdown' | 'policy';

export type TerminalStatus = 'completed' | 'failed' | 'cancelled';

export interface CancelRequest {
  readonly runId: Id<'Run'>;
  readonly reason: CancelReason;
}

export interface CancelResult {
  readonly runId: Id<'Run'>;
  readonly status: TerminalStatus | 'cancelling';
  readonly dispatchState: DispatchState;
}

export interface SteerRequest {
  readonly runId: Id<'Run'>;
  readonly text: string;
  readonly clientSteerId: string;
}

export type SteerRejection = 'already_terminal' | 'not_running' | 'rejected_by_harness';

export interface SteerResult {
  readonly accepted: boolean;
  readonly reason?: SteerRejection;
}

export type RunSnapshotStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed_out';

export interface RunSnapshot {
  readonly runId: Id<'Run'>;
  readonly status: RunSnapshotStatus;
  readonly harnessStatus: HarnessRunStatus | null;
  readonly lastSeq: number;
  readonly version: number;
}

export type UsageStatus = 'known' | 'partial' | 'unknown';

export interface UsageRecord {
  readonly runId: Id<'Run'>;
  readonly usageStatus: UsageStatus;
  readonly grossPromptTokens: number | null;
  readonly grossCompletionTokens: number | null;
  readonly cachedPromptTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly totalTokens: number | null;
  readonly costStatus: 'known' | 'unknown';
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface RecoverAfterRestartInput {
  readonly runIds: readonly Id<'Run'>[];
}

/**
 * Exactly one outcome per Run on restart. `lost` is terminal for Habi
 * (`failed` / `execution_uncertain`) and is never retried automatically.
 */
export type RecoveryOutcome =
  | {
      readonly kind: 'confirmed_terminal';
      readonly runId: Id<'Run'>;
      readonly snapshot: RunSnapshot;
    }
  | {
      readonly kind: 'still_running';
      readonly runId: Id<'Run'>;
      readonly snapshot: RunSnapshot;
      /** Highest applied Habi seq; resume the stream after this value. */
      readonly resumeAfterSeq: number;
    }
  | {
      readonly kind: 'lost';
      readonly runId: Id<'Run'>;
      readonly dispatchState: DispatchState;
    };

export interface RecoveryReport {
  readonly recoveredAt: string;
  readonly outcomes: readonly RecoveryOutcome[];
}

/**
 * The replaceable boundary. A direct-call implementation must satisfy the same
 * interface so product code does not change when the harness is swapped.
 */
export interface HarnessAdapter {
  createRun(req: CreateRunRequest): Promise<CreateRunResult>;
  subscribe(req: SubscribeRequest): SubscribeResult;
  cancel(req: CancelRequest): Promise<CancelResult>;
  steer(req: SteerRequest): Promise<SteerResult>;
  getRun(runId: Id<'Run'>): Promise<RunSnapshot>;
  getUsage(runId: Id<'Run'>): Promise<UsageRecord>;
  recoverAfterRestart(input: RecoverAfterRestartInput): Promise<RecoveryReport>;
  /** Releases transport. Must not silently terminate live runs. */
  close(): Promise<void>;
}

/** Normalized failure vocabulary from design §7. */
export type FailureCode =
  | 'auth_rejected'
  | 'invalid_request'
  | 'policy_denied'
  | 'idempotency_conflict'
  | 'transport_ambiguous'
  | 'provider_error'
  | 'provider_rate_limited'
  | 'provider_exhausted'
  | 'timeout'
  | 'harness_unavailable';

export interface HarnessAdapterErrorOptions {
  readonly message?: string;
  readonly httpStatus?: number;
}

/**
 * The only failure shape an adapter throws. Messages contain no credential,
 * no harness token, and no request/response body: callers branch on `code`
 * and `dispatchState`, never on vendor error copy.
 */
export class HarnessAdapterError extends Error {
  readonly code: FailureCode;
  readonly dispatchState: DispatchState;
  /** Adapters never auto-retry; a user retry is a new Run with a new key. */
  readonly retryable = false;
  readonly httpStatus: number | null;

  constructor(
    code: FailureCode,
    dispatchState: DispatchState,
    options: HarnessAdapterErrorOptions = {},
  ) {
    super(options.message ?? code);
    this.name = 'HarnessAdapterError';
    this.code = code;
    this.dispatchState = dispatchState;
    this.httpStatus = options.httpStatus ?? null;
  }
}

export const TERMINAL_HARNESS_STATUSES: ReadonlySet<HarnessRunStatus> = new Set([
  'cancelled',
  'failed',
  'completed',
]);

export function isTerminalHarnessStatus(status: HarnessRunStatus): boolean {
  return TERMINAL_HARNESS_STATUSES.has(status);
}

/** HTTP status to terminal failure mapping for callers that render errors. */
export function failureForHttpStatus(
  status: number,
  dispatchState: DispatchState,
): HarnessAdapterError {
  if (status === 401 || status === 403) {
    return new HarnessAdapterError('auth_rejected', 'not_dispatched', {
      message: 'harness rejected the gateway credential',
      httpStatus: status,
    });
  }

  if (status === 408) {
    return new HarnessAdapterError('transport_ambiguous', 'unknown', {
      message: 'harness request timed out after being written',
      httpStatus: status,
    });
  }

  if (status === 409) {
    return new HarnessAdapterError('idempotency_conflict', 'not_dispatched', {
      message: 'idempotency key conflicts with an earlier dispatch',
      httpStatus: status,
    });
  }

  if (status === 402) {
    return new HarnessAdapterError('provider_exhausted', dispatchState, {
      message: 'provider reported exhausted capacity or credit',
      httpStatus: status,
    });
  }

  if (status === 429) {
    return new HarnessAdapterError('provider_rate_limited', dispatchState, {
      message: 'provider rate limited the request',
      httpStatus: status,
    });
  }

  if (status >= 500) {
    return new HarnessAdapterError('provider_error', 'unknown', {
      message: 'harness or provider returned a server error',
      httpStatus: status,
    });
  }

  return new HarnessAdapterError('invalid_request', 'not_dispatched', {
    message: 'harness rejected the request as invalid',
    httpStatus: status,
  });
}
