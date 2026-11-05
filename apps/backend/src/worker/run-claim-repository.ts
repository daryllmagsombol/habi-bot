/**
 * Worker-owned SQL for selecting claimable Runs and maintaining their lease.
 *
 * The `runs` table has no worker/lease columns in this slice, so:
 *
 *   - a claimable row is `status = 'queued' AND dispatch_state = 'not_dispatched'
 *     AND cancel_requested_at IS NULL`; a Run with a durable cancellation
 *     intent is never sent to the provider and is owned by the idle sweep;
 *   - selection is advisory. The single atomic `not_dispatched` -> `unknown`
 *     claim lives in `RunService.dispatchReserved`, so a second selector can
 *     pick the same row and still never produce a second provider call;
 *   - `updated_at` doubles as the lease timestamp. A heartbeat advances it while
 *     the dispatch is live; a stale timestamp marks the claim as abandoned for
 *     reconciliation (never for re-dispatch).
 *
 * A dedicated `claimed_by`/`claimed_until` schema would make lease ownership
 * explicit across replicas. That is a `runs` migration, which this lane does not
 * own, so the design is reported instead of silently altered.
 */
import type { Pool } from 'pg';
import type { CancelReason } from '../adapters/harness-adapter.js';

export interface ClaimedRunRef {
  readonly id: string;
  readonly ownerUserId: string;
}

export interface ClaimedRunRow {
  id: string;
  owner_user_id: string;
}

/** Durable cancellation intent as observed by the owning worker's heartbeat. */
export interface CancelIntentRef {
  readonly requestedAt: string;
  readonly reason: CancelReason | null;
  readonly attempts: number;
  readonly errorCode: string | null;
}

export interface HeartbeatResult {
  /** False once the Run left the non-terminal state; the lease is gone. */
  readonly alive: boolean;
  readonly cancel: CancelIntentRef | null;
}

/**
 * Selects at most `limit` queued, never-dispatched Runs. `SKIP LOCKED` keeps
 * concurrent selectors from blocking each other; the real single-dispatch
 * guarantee is the conditional claim inside `RunService`. A Run with a durable
 * cancellation intent is excluded: its claim would fail anyway, and the idle
 * cancel sweep owns it.
 */
const CLAIM_BATCH = `SELECT id, owner_user_id
   FROM runs
  WHERE status = 'queued'
    AND dispatch_state = 'not_dispatched'
    AND cancel_requested_at IS NULL
  ORDER BY created_at ASC, id ASC
  FOR UPDATE SKIP LOCKED
  LIMIT $1`;

/**
 * Extends the lease and returns the cancellation intent in the same round trip.
 * The heartbeat is the owning worker's observation point for a user-requested
 * stop, so the intent is read exactly where liveness is already proven.
 */
const HEARTBEAT = `UPDATE runs
   SET updated_at = now()
 WHERE id = $1
   AND owner_user_id = $2
   AND status IN ('queued', 'running')
 RETURNING cancel_requested_at, cancel_reason, cancel_attempts,
           cancel_error_code`;

/**
 * Gives an undispatched claim back on graceful shutdown. Only `queued` +
 * `unknown` is reverted, and the caller must only use it when the adapter
 * create call was never invoked.
 */
const RELEASE_CLAIM = `UPDATE runs
   SET dispatch_state = 'not_dispatched',
       updated_at = now()
 WHERE id = $1
   AND owner_user_id = $2
   AND status = 'queued'
   AND dispatch_state = 'unknown'
 RETURNING id`;

interface HeartbeatRow {
  cancel_requested_at: Date | string | null;
  cancel_reason: CancelReason | null;
  cancel_attempts: number;
  cancel_error_code: string | null;
}

export class WorkerRunRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * Selects queued, never-dispatched Runs. The caller must still dispatch
   * through `RunService.dispatchReserved`, which performs the atomic claim.
   */
  async claimBatch(limit: number): Promise<ClaimedRunRef[]> {
    const result = await this.pool.query<ClaimedRunRow>(CLAIM_BATCH, [limit]);

    return result.rows.map((row) => ({
      id: row.id,
      ownerUserId: row.owner_user_id,
    }));
  }

  /**
   * Extends the lease. False means the Run left the non-terminal state.
   * `cancel` is non-null while a durable cancellation intent is outstanding.
   */
  async heartbeat(runId: string, ownerUserId: string): Promise<HeartbeatResult> {
    const result = await this.pool.query<HeartbeatRow>(HEARTBEAT, [
      runId,
      ownerUserId,
    ]);
    const row = result.rows[0];

    if (row === undefined) {
      return { alive: false, cancel: null };
    }

    if (row.cancel_requested_at === null) {
      return { alive: true, cancel: null };
    }

    return {
      alive: true,
      cancel: {
        requestedAt:
          row.cancel_requested_at instanceof Date
            ? row.cancel_requested_at.toISOString()
            : new Date(row.cancel_requested_at).toISOString(),
        reason: row.cancel_reason,
        attempts: row.cancel_attempts,
        errorCode: row.cancel_error_code,
      },
    };
  }

  /** Reverts an undispatched claim so a restart can claim it immediately. */
  async releaseClaim(runId: string, ownerUserId: string): Promise<boolean> {
    const result = await this.pool.query(RELEASE_CLAIM, [runId, ownerUserId]);

    return result.rows.length > 0;
  }
}
