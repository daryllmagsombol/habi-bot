/**
 * Run/provider correlation helpers for H-013 (#13) run observability.
 *
 * Every run log line carries the same three correlation handles:
 *
 *   - `requestId`: the inbound `x-request-id` when the Run was created inside
 *     an HTTP request (via AsyncLocalStorage), otherwise absent. Worker-only
 *     transitions (recovery, idle sweeps) have no request context, and must
 *     not fabricate one.
 *   - `runId` (the correlationId on the adapter request): the Habi Run id,
 *     authoritatively identifying the reservation from enqueue to terminal.
 *   - `conversationId`: the owning conversation, present only when the caller
 *     already holds it. It is a reference handle for grouping, never message
 *     content.
 *
 * What is never logged from here: prompts, message bodies, payloads, raw usage
 * records, cookies, headers, tokens, or the harness gateway key. Provider
 * outcomes log the normalized failure code, dispatch state, and usage numbers
 * only. Queue job ids are not invented: a Run has no job id in this slice, so
 * none is logged.
 */
import { currentRequestId } from './request-context.js';
import type {
  PersistedRunUsage,
} from '../runs/usage.js';

export const RUN_ENQUEUED_EVENT = 'run.enqueued';
export const RUN_RESERVED_EVENT = 'run.reserved';
export const RUN_DUPLICATE_EVENT = 'run.duplicate';
export const RUN_DISPATCH_ACCEPTED_EVENT = 'run.dispatch_accepted';
export const RUN_DISPATCH_SKIPPED_EVENT = 'run.dispatch_skipped';
export const RUN_TERMINAL_EVENT = 'run.observed_terminal';
export const PROVIDER_CALL_EVENT = 'provider.call';
export const QUEUE_HEALTH_EVENT = 'queue.health';

export type TelemetryUsageSummary = Pick<
  PersistedRunUsage,
  | 'status'
  | 'grossPromptTokens'
  | 'grossCompletionTokens'
  | 'cachedPromptTokens'
  | 'reasoningTokens'
  | 'totalTokens'
  | 'costStatus'
>;

/** Correlation envelope for one run transition. Never carries user content. */
export interface RunCorrelation {
  readonly runId: string;
  readonly conversationId?: string;
  readonly requestId?: string;
  readonly [field: string]: unknown;
}

/** Builds the correlation envelope; omits `requestId` outside HTTP context. */
export function correlateRun(runId: string, conversationId?: string): RunCorrelation {
  const requestId = currentRequestId();
  return {
    runId,
    ...(conversationId === undefined ? {} : { conversationId }),
    ...(requestId === undefined ? {} : { requestId }),
  };
}

/**
 * Provider outcome fields. `errorCode` is the normalized adapter failure code;
 * `dispatchState` is the recorded dispatch state; `retried` records whether
 * the caller scheduled another provider attempt (always false in this slice
 * for ambiguous work). Usage is numbers only, never the raw vendor record.
 */
export interface ProviderCallFields extends RunCorrelation {
  readonly outcome: 'success' | 'failure';
  readonly errorCode?: string;
  readonly dispatchState?: string;
  readonly retried: boolean;
  readonly usageStatus?: string;
  readonly grossPromptTokens?: number | null;
  readonly grossCompletionTokens?: number | null;
  readonly totalTokens?: number | null;
}

export function providerCallFields(
  correlation: RunCorrelation,
  input: {
    readonly outcome: 'success' | 'failure';
    readonly errorCode?: string | null;
    readonly dispatchState?: string | null;
    readonly retried?: boolean;
    readonly usage?: TelemetryUsageSummary | null;
  },
): ProviderCallFields {
  const usage = input.usage ?? undefined;
  return {
    ...correlation,
    outcome: input.outcome,
    ...(input.errorCode === undefined || input.errorCode === null
      ? {}
      : { errorCode: input.errorCode }),
    ...(input.dispatchState === undefined || input.dispatchState === null
      ? {}
      : { dispatchState: input.dispatchState }),
    retried: input.retried ?? false,
    ...(usage === undefined
      ? {}
      : {
          usageStatus: usage.status,
          grossPromptTokens: usage.grossPromptTokens,
          grossCompletionTokens: usage.grossCompletionTokens,
          totalTokens: usage.totalTokens,
        }),
  };
}

/** Numbers-only usage summary for log lines; drops the raw vendor record. */
export function usageSummary(usage: TelemetryUsageSummary): TelemetryUsageSummary {
  return {
    status: usage.status,
    grossPromptTokens: usage.grossPromptTokens,
    grossCompletionTokens: usage.grossCompletionTokens,
    cachedPromptTokens: usage.cachedPromptTokens,
    reasoningTokens: usage.reasoningTokens,
    totalTokens: usage.totalTokens,
    costStatus: usage.costStatus,
  };
}
