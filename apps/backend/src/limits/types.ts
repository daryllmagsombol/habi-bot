/**
 * H-023 (#23) usage-limit types.
 *
 * The allowance is counted in units of `gross input tokens + gross output
 * tokens` per Habi user per Asia/Manila day, per the accepted provider-access
 * design. `unknown` usage is never zero: it stays held in `reservedTokens`
 * until an owner reconciliation records a real number.
 */

/** Owner-approved daily shared-key allowance: 100,000 input + output tokens. */
export const DAILY_ALLOWANCE_TOKENS = 100_000;

export type UsageBucketState = 'known' | 'partial' | 'unknown';

export type ReservationState = 'reserved' | 'settled' | 'released' | 'unknown';

export interface UsageBucket {
  readonly ownerUserId: string;
  readonly dayBucket: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reservedTokens: number;
  readonly state: UsageBucketState;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface UsageReservation {
  readonly id: string;
  readonly ownerUserId: string;
  readonly runId: string;
  readonly dayBucket: string;
  readonly estimatedTokens: number;
  readonly chargedTokens: number;
  readonly state: ReservationState;
  readonly usageStatus: UsageBucketState | null;
  readonly createdAt: string;
  readonly settledAt: string | null;
  readonly releasedAt: string | null;
  readonly reconciledAt: string | null;
  readonly reconciledBy: string | null;
}

/** Caller input for one atomic pre-dispatch reservation. */
export interface ReserveUsageInput {
  readonly ownerUserId: string;
  readonly runId: string;
  /** Upper bound for this request. Must be a positive safe integer. */
  readonly estimateTokens: number;
}

/**
 * Reported provider usage handed to `settle`. Counts are nullable because the
 * adapter must be able to say "reported unknown" without inventing zeros.
 */
export interface SettleUsageInput {
  readonly status: UsageBucketState;
  readonly grossPromptTokens?: number | null;
  readonly grossCompletionTokens?: number | null;
  readonly totalTokens?: number | null;
  readonly cachedPromptTokens?: number | null;
  readonly reasoningTokens?: number | null;
}

export interface SettleUsageOptions {
  /**
   * When supplied, settlement is restricted in SQL to this owner. The worker
   * finalizing a Run already knows the owner; passing it is defense in depth so
   * a guessed reservation id cannot be settled across users.
   */
  readonly ownerUserId?: string;
}

export interface ReservationSettlement {
  readonly reservationId: string;
  readonly runId: string;
  readonly dayBucket: string;
  readonly state: 'settled' | 'unknown';
  readonly usageStatus: UsageBucketState;
  /**
   * Units committed for a `settled` reservation, or the held upper bound for an
   * `unknown` one. Never zero for `unknown`.
   */
  readonly chargedTokens: number;
}

export interface ReconcileUsageOptions {
  /** The owner resolving the bucket. Must equal `ownerUserId` on the bucket. */
  readonly actorUserId: string;
  /**
   * Total units the owner resolved for the bucket's unknown holds. Zero is
   * allowed only as an explicit, audited decision; it is never inferred.
   */
  readonly resolvedTokens: number;
  /** Optional attribution; when omitted the whole total is recorded as input. */
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  /** Human note retained in the append-only audit row. */
  readonly note: string;
}

export interface ReconcileUsageResult {
  readonly ownerUserId: string;
  readonly dayBucket: string;
  readonly state: Exclude<UsageBucketState, 'unknown'>;
  readonly resolvedTokens: number;
  readonly provisionalTokens: number;
  /** Signed change applied to committed usage: resolved - provisional. */
  readonly deltaTokens: number;
  readonly reconciledReservations: number;
  readonly auditedAt: string;
}

/** Owner-visible allowance snapshot. It never includes another user's data. */
export interface UsageSnapshot {
  readonly ownerUserId: string;
  readonly dayBucket: string;
  readonly limitTokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reservedTokens: number;
  /** Committed plus outstanding holds, i.e. what counts against the limit. */
  readonly usedTokens: number;
  readonly remainingTokens: number;
  readonly state: UsageBucketState;
  /** True while an unreconciled `unknown` hold blocks new reservations. */
  readonly blocked: boolean;
  /** First instant of the next Asia/Manila day, as an ISO timestamp. */
  readonly resetsAt: string;
}
