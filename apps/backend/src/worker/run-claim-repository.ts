/**
 * Worker-owned SQL for claiming Runs and rebuilding their dispatch context.
 *
 * The `runs` table has no worker/lease columns in this slice, so a claim is
 * expressed with the existing vocabulary:
 *
 *   - a claimable row is `status = 'queued' AND dispatch_state = 'not_dispatched'`;
 *   - the claim atomically moves it to `dispatch_state = 'unknown'` and stamps
 *     `updated_at`. `unknown` is the conservative "a provider call may be sent"
 *     state, so a second claimer can never pick the row up and a crash cannot
 *     cause a paid retry;
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

export interface RunMessageRow {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

export interface ReservationRef {
  id: string;
  state: 'reserved' | 'settled' | 'released' | 'unknown';
}

/**
 * One statement: lock candidate ids with `SKIP LOCKED`, then update exactly the
 * rows this statement selected. Two workers cannot claim the same Run because
 * the row lock is taken before the state transition, and a concurrent writer
 * re-evaluates the predicate against the committed new version.
 */
const CLAIM_BATCH = `WITH candidate AS (
    SELECT id
      FROM runs
     WHERE status = 'queued'
       AND dispatch_state = 'not_dispatched'
     ORDER BY created_at ASC, id ASC
     FOR UPDATE SKIP LOCKED
     LIMIT $1
  )
  UPDATE runs AS claimed
     SET dispatch_state = 'unknown',
         updated_at = now()
    FROM candidate
   WHERE claimed.id = candidate.id
  RETURNING claimed.id, claimed.owner_user_id`;

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

/**
 * Non-terminal rows whose lease expired: previously dispatched (`running`), or
 * claimed but never confirmed (`queued` + `dispatched`/`unknown`). A plain
 * queued/`not_dispatched` reservation is never here: the claim loop should
 * dispatch it, not fail it.
 */
const STALE_NON_TERMINAL = `SELECT id, owner_user_id
   FROM runs
  WHERE (
          status = 'running'
          OR status = 'retry_wait'
          OR (status = 'queued' AND dispatch_state <> 'not_dispatched')
        )
    AND updated_at <= now() - ($1::bigint * interval '1 millisecond')
    AND NOT (id = ANY($2::uuid[]))
  ORDER BY updated_at ASC, id ASC
  LIMIT $3`;

const CONVERSATION_BOT = `SELECT bot_id
   FROM conversations
  WHERE id = $1
    AND owner_user_id = $2
    AND deleted_at IS NULL`;

const MESSAGE_SEQ_BY_ID = `SELECT seq
   FROM messages
  WHERE id = $1
    AND conversation_id = $2
    AND owner_user_id = $3
    AND deleted_at IS NULL`;

const MESSAGE_SEQ_BEFORE_RUN = `SELECT max(seq) AS seq
   FROM messages
  WHERE conversation_id = $1
    AND owner_user_id = $2
    AND deleted_at IS NULL
    AND created_at <= (
      SELECT created_at
        FROM runs
       WHERE id = $3
         AND owner_user_id = $2
    )`;

const CONTEXT_MESSAGES = `SELECT id, role, content
   FROM messages
  WHERE owner_user_id = $1
    AND conversation_id = $2
    AND deleted_at IS NULL
    AND status <> 'deleted'
    AND seq <= $3
  ORDER BY seq ASC
  LIMIT $4`;

const RESERVATION_BY_RUN = `SELECT id, state
   FROM usage_reservations
  WHERE run_id = $1
    AND owner_user_id = $2`;

/** Hard ceiling matching the run-controller context bound. */
export const MAX_CONTEXT_MESSAGES = 200;

export class WorkerRunRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * Claims at most `limit` queued, never-dispatched Runs. This is the only path
   * that moves a Run from the reservation state into worker ownership.
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

  /** Expired claims and dispatched-but-unconfirmed Runs, bounded. */
  async listStaleNonTerminal(
    leaseMs: number,
    inFlightRunIds: readonly string[],
    limit: number,
  ): Promise<ClaimedRunRef[]> {
    const result = await this.pool.query<ClaimedRunRow>(STALE_NON_TERMINAL, [
      leaseMs,
      inFlightRunIds,
      limit,
    ]);

    return result.rows.map((row) => ({
      id: row.id,
      ownerUserId: row.owner_user_id,
    }));
  }

  async loadConversationBot(
    ownerUserId: string,
    conversationId: string,
  ): Promise<string | null> {
    const result = await this.pool.query<{ bot_id: string }>(CONVERSATION_BOT, [
      conversationId,
      ownerUserId,
    ]);

    return result.rows[0]?.bot_id ?? null;
  }

  /**
   * Rebuilds the Habi-selected context for a claimed Run. The bound is the
   * message that produced the Run when the API's `api-message:<id>` key is
   * present, otherwise the latest message written before the Run row. No
   * memory or Bot content is re-selected here.
   */
  async loadContextMessages(
    ownerUserId: string,
    conversationId: string,
    runId: string,
    idempotencyKey: string,
  ): Promise<RunMessageRow[]> {
    const triggerSeq = await this.loadTriggerSeq(
      ownerUserId,
      conversationId,
      runId,
      idempotencyKey,
    );

    if (triggerSeq === null) {
      return [];
    }

    const result = await this.pool.query<RunMessageRow>(CONTEXT_MESSAGES, [
      ownerUserId,
      conversationId,
      triggerSeq,
      MAX_CONTEXT_MESSAGES,
    ]);

    return result.rows;
  }

  async findReservation(
    runId: string,
    ownerUserId: string,
  ): Promise<ReservationRef | null> {
    const result = await this.pool.query<ReservationRef>(RESERVATION_BY_RUN, [
      runId,
      ownerUserId,
    ]);

    return result.rows[0] ?? null;
  }

  private async loadTriggerSeq(
    ownerUserId: string,
    conversationId: string,
    runId: string,
    idempotencyKey: string,
  ): Promise<number | null> {
    const messageId = triggerMessageId(idempotencyKey);

    if (messageId !== null) {
      const byId = await this.pool.query<{ seq: string }>(MESSAGE_SEQ_BY_ID, [
        messageId,
        conversationId,
        ownerUserId,
      ]);
      const row = byId.rows[0];

      if (row !== undefined) {
        return Number(row.seq);
      }
    }

    // Fallback: the conversation's last message at the Run's creation instant.
    // `$3` is the Run id, so a foreign Run cannot widen the bound.
    const byTime = await this.pool.query<{ seq: string | null }>(
      MESSAGE_SEQ_BEFORE_RUN,
      [conversationId, ownerUserId, runId],
    );

    const seq = byTime.rows[0]?.seq;

    return seq === null || seq === undefined ? null : Number(seq);
  }
}

const API_MESSAGE_KEY_PREFIX = 'api-message:';
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The H-018 API encodes the triggering message id in the Run's idempotency key.
 * Anything else falls back to the time bound; a malformed suffix is ignored.
 */
export function triggerMessageId(idempotencyKey: string): string | null {
  if (!idempotencyKey.startsWith(API_MESSAGE_KEY_PREFIX)) {
    return null;
  }

  const suffix = idempotencyKey.slice(API_MESSAGE_KEY_PREFIX.length);

  return UUID_PATTERN.test(suffix) ? suffix : null;
}
