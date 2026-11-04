/**
 * Worker-owned SQL for selecting claimable Runs and maintaining their lease.
 *
 * The `runs` table has no worker/lease columns in this slice, so:
 *
 *   - a claimable row is `status = 'queued' AND dispatch_state = 'not_dispatched'`;
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

export interface ClaimedRunRef {
  readonly id: string;
  readonly ownerUserId: string;
}

export interface ClaimedRunRow {
  id: string;
  owner_user_id: string;
}

/**
 * Selects at most `limit` queued, never-dispatched Runs. `SKIP LOCKED` keeps
 * concurrent selectors from blocking each other; the real single-dispatch
 * guarantee is the conditional claim inside `RunService`.
 */
const CLAIM_BATCH = `SELECT id, owner_user_id
   FROM runs
  WHERE status = 'queued'
    AND dispatch_state = 'not_dispatched'
  ORDER BY created_at ASC, id ASC
  FOR UPDATE SKIP LOCKED
  LIMIT $1`;

const HEARTBEAT = `UPDATE runs
   SET updated_at = now()
 WHERE id = $1
   AND owner_user_id = $2
   AND status IN ('queued', 'running')
 RETURNING id`;

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

  /** Extends the lease. False means the Run left the non-terminal state. */
  async heartbeat(runId: string, ownerUserId: string): Promise<boolean> {
    const result = await this.pool.query(HEARTBEAT, [runId, ownerUserId]);

    return result.rows.length > 0;
  }

  /** Reverts an undispatched claim so a restart can claim it immediately. */
  async releaseClaim(runId: string, ownerUserId: string): Promise<boolean> {
    const result = await this.pool.query(RELEASE_CLAIM, [runId, ownerUserId]);

    return result.rows.length > 0;
  }
}
