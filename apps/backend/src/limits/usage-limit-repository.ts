/**
 * SQL for the H-023 allowance. Every statement binds `owner_user_id`; a
 * reservation id alone is never enough to read or move another user's row.
 *
 * `day_bucket` is always selected as text. node-postgres would otherwise parse
 * a `date` into a JS `Date` at the process's local timezone, which is exactly
 * the timezone bug this design avoids. The plain `YYYY-MM-DD` string is the
 * only representation that crosses this boundary.
 */
import type { Pool } from 'pg';
import type { Queryable } from '../persistence/database.js';
import type { UsageBucket, UsageBucketState, UsageReservation, ReservationState } from './types.js';

type Timestamp = Date | string;
type NullableTimestamp = Timestamp | null;

export interface UsageBucketRow {
  owner_user_id: string;
  day_bucket: string;
  input_tokens: string;
  output_tokens: string;
  reserved_tokens: string;
  state: UsageBucketState;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface UsageReservationRow {
  id: string;
  owner_user_id: string;
  run_id: string;
  day_bucket: string;
  estimated_tokens: string;
  charged_tokens: string;
  state: ReservationState;
  usage_status: UsageBucketState | null;
  created_at: Timestamp;
  settled_at: NullableTimestamp;
  released_at: NullableTimestamp;
  reconciled_at: NullableTimestamp;
  reconciled_by: string | null;
}

export interface UsageAuditRow {
  id: string;
  owner_user_id: string;
  day_bucket: string;
  actor_user_id: string;
  action: 'reconcile';
  tokens_delta: string;
  note: string;
  created_at: Timestamp;
}

export const BUCKET_COLUMNS = `owner_user_id, day_bucket::text AS day_bucket,
  input_tokens, output_tokens, reserved_tokens, state, created_at, updated_at`;

export const RESERVATION_COLUMNS = `id, owner_user_id, run_id, day_bucket::text AS day_bucket,
  estimated_tokens, charged_tokens, state, usage_status, created_at, settled_at,
  released_at, reconciled_at, reconciled_by`;

function toIso(value: Timestamp): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toNullableIso(value: NullableTimestamp): string | null {
  return value === null ? null : toIso(value);
}

function toCount(value: string | number, field: string): number {
  const count = typeof value === 'number' ? value : Number(value);

  if (!Number.isSafeInteger(count) || count < 0) {
    throw new TypeError(`Persisted ${field} is outside the supported integer range.`);
  }

  return count;
}

export function toUsageBucket(row: UsageBucketRow): UsageBucket {
  return {
    ownerUserId: row.owner_user_id,
    dayBucket: row.day_bucket,
    inputTokens: toCount(row.input_tokens, 'bucket input tokens'),
    outputTokens: toCount(row.output_tokens, 'bucket output tokens'),
    reservedTokens: toCount(row.reserved_tokens, 'bucket reserved tokens'),
    state: row.state,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export function toUsageReservation(row: UsageReservationRow): UsageReservation {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    runId: row.run_id,
    dayBucket: row.day_bucket,
    estimatedTokens: toCount(row.estimated_tokens, 'reservation estimate'),
    chargedTokens: toCount(row.charged_tokens, 'reservation charge'),
    state: row.state,
    usageStatus: row.usage_status,
    createdAt: toIso(row.created_at),
    settledAt: toNullableIso(row.settled_at),
    releasedAt: toNullableIso(row.released_at),
    reconciledAt: toNullableIso(row.reconciled_at),
    reconciledBy: row.reconciled_by,
  };
}

export interface InsertReservationInput {
  ownerUserId: string;
  runId: string;
  dayBucket: string;
  estimatedTokens: number;
  at: Date;
}

export interface SettlementInput {
  ownerUserId: string;
  dayBucket: string;
  reservationId: string;
  estimatedTokens: number;
  inputTokens: number;
  outputTokens: number;
  state: 'settled' | 'unknown';
  usageStatus: UsageBucketState;
  at: Date;
}

export interface ReconciliationInput {
  ownerUserId: string;
  dayBucket: string;
  provisionalTokens: number;
  resolvedInputTokens: number;
  resolvedOutputTokens: number;
  markPartial: boolean;
  at: Date;
}

export interface AuditInput {
  ownerUserId: string;
  dayBucket: string;
  actorUserId: string;
  tokensDelta: number;
  note: string;
  at: Date;
}

export class UsageLimitRepository {
  constructor(private readonly pool: Pool) {}

  async findBucket(ownerUserId: string, dayBucket: string): Promise<UsageBucketRow | null> {
    const result = await this.pool.query<UsageBucketRow>(
      `SELECT ${BUCKET_COLUMNS}
         FROM usage_buckets
        WHERE owner_user_id = $1
          AND day_bucket = $2`,
      [ownerUserId, dayBucket],
    );

    return result.rows[0] ?? null;
  }

  /** Locks an existing bucket without creating one. */
  async lockBucket(
    client: Queryable,
    ownerUserId: string,
    dayBucket: string,
  ): Promise<UsageBucketRow | null> {
    const result = await client.query<UsageBucketRow>(
      `SELECT ${BUCKET_COLUMNS}
         FROM usage_buckets
        WHERE owner_user_id = $1
          AND day_bucket = $2
          FOR UPDATE`,
      [ownerUserId, dayBucket],
    );

    return result.rows[0] ?? null;
  }

  /**
   * Creates the day's bucket if it does not exist and then locks it. The
   * insert-or-ignore plus `FOR UPDATE` serializes concurrent admissions for one
   * owner/day, which is what makes the capacity check and reservation insert
   * atomic together.
   */
  async lockOrCreateBucket(
    client: Queryable,
    ownerUserId: string,
    dayBucket: string,
    at: Date,
  ): Promise<UsageBucketRow> {
    await client.query(
      `INSERT INTO usage_buckets (owner_user_id, day_bucket, created_at, updated_at)
       VALUES ($1, $2, $3, $3)
       ON CONFLICT (owner_user_id, day_bucket) DO NOTHING`,
      [ownerUserId, dayBucket, at],
    );

    const result = await client.query<UsageBucketRow>(
      `SELECT ${BUCKET_COLUMNS}
         FROM usage_buckets
        WHERE owner_user_id = $1
          AND day_bucket = $2
          FOR UPDATE`,
      [ownerUserId, dayBucket],
    );

    const row = result.rows[0];

    if (row === undefined) {
      throw new Error('Allowance bucket disappeared while locked.');
    }

    return row;
  }

  async findReservationByRun(
    client: Queryable,
    ownerUserId: string,
    runId: string,
    forUpdate: boolean,
  ): Promise<UsageReservationRow | null> {
    const result = await client.query<UsageReservationRow>(
      `SELECT ${RESERVATION_COLUMNS}
         FROM usage_reservations
        WHERE owner_user_id = $1
          AND run_id = $2${forUpdate ? ' FOR UPDATE' : ''}`,
      [ownerUserId, runId],
    );

    return result.rows[0] ?? null;
  }

  async findReservationById(
    client: Queryable,
    reservationId: string,
    ownerUserId: string | null,
    forUpdate: boolean,
  ): Promise<UsageReservationRow | null> {
    const result = await client.query<UsageReservationRow>(
      `SELECT ${RESERVATION_COLUMNS}
         FROM usage_reservations
        WHERE id = $1
          AND ($2::uuid IS NULL OR owner_user_id = $2::uuid)${forUpdate ? ' FOR UPDATE' : ''}`,
      [reservationId, ownerUserId],
    );

    return result.rows[0] ?? null;
  }

  async insertReservation(
    client: Queryable,
    input: InsertReservationInput,
  ): Promise<UsageReservationRow> {
    const result = await client.query<UsageReservationRow>(
      `INSERT INTO usage_reservations (
         owner_user_id, run_id, day_bucket, estimated_tokens, created_at
       )
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (owner_user_id, run_id) DO NOTHING
       RETURNING ${RESERVATION_COLUMNS}`,
      [input.ownerUserId, input.runId, input.dayBucket, input.estimatedTokens, input.at],
    );

    const row = result.rows[0];

    if (row === undefined) {
      throw new Error('Reservation insert conflicted despite the bucket lock.');
    }

    return row;
  }

  async addReservedTokens(
    client: Queryable,
    ownerUserId: string,
    dayBucket: string,
    delta: number,
    at: Date,
  ): Promise<UsageBucketRow> {
    const result = await client.query<UsageBucketRow>(
      `UPDATE usage_buckets
          SET reserved_tokens = reserved_tokens + $3,
              updated_at = $4
        WHERE owner_user_id = $1
          AND day_bucket = $2
        RETURNING ${BUCKET_COLUMNS}`,
      [ownerUserId, dayBucket, delta, at],
    );

    return requireBucket(result.rows[0]);
  }

  /**
   * Applies one terminal settlement. For `settled` the committed counts are
   * added and the hold is released; the `unknown` state is written separately
   * because it keeps the hold in place.
   */
  async settleReservation(
    client: Queryable,
    input: SettlementInput,
  ): Promise<UsageBucketRow> {
    const updated = await client.query<UsageReservationRow>(
      `UPDATE usage_reservations
          SET state = $3,
              usage_status = $4,
              charged_tokens = $5,
              settled_at = $6
        WHERE id = $1
          AND owner_user_id = $2
          AND state = 'reserved'
        RETURNING ${RESERVATION_COLUMNS}`,
      [
        input.reservationId,
        input.ownerUserId,
        input.state,
        input.usageStatus,
        input.state === 'unknown' ? input.estimatedTokens : input.inputTokens + input.outputTokens,
        input.at,
      ],
    );

    if (updated.rows[0] === undefined) {
      throw new Error('Reservation changed while locked.');
    }

    if (input.state === 'unknown') {
      // The estimate stays in `reserved_tokens`: unknown is not zero and the
      // bucket must not silently free the only bound it has.
      const result = await client.query<UsageBucketRow>(
        `UPDATE usage_buckets
            SET state = 'unknown',
                updated_at = $3
          WHERE owner_user_id = $1
            AND day_bucket = $2
          RETURNING ${BUCKET_COLUMNS}`,
        [input.ownerUserId, input.dayBucket, input.at],
      );

      return requireBucket(result.rows[0]);
    }

    const result = await client.query<UsageBucketRow>(
      `UPDATE usage_buckets
          SET input_tokens = input_tokens + $3,
              output_tokens = output_tokens + $4,
              reserved_tokens = reserved_tokens - $5,
              state = CASE
                WHEN state = 'unknown' THEN state
                WHEN $6::boolean THEN 'partial'
                ELSE state
              END,
              updated_at = $7
        WHERE owner_user_id = $1
          AND day_bucket = $2
        RETURNING ${BUCKET_COLUMNS}`,
      [
        input.ownerUserId,
        input.dayBucket,
        input.inputTokens,
        input.outputTokens,
        input.estimatedTokens,
        input.usageStatus === 'partial',
        input.at,
      ],
    );

    return requireBucket(result.rows[0]);
  }

  async releaseReservation(
    client: Queryable,
    ownerUserId: string,
    dayBucket: string,
    reservationId: string,
    estimatedTokens: number,
    at: Date,
  ): Promise<UsageReservationRow> {
    const updated = await client.query<UsageReservationRow>(
      `UPDATE usage_reservations
          SET state = 'released',
              released_at = $3
        WHERE id = $1
          AND owner_user_id = $2
          AND state = 'reserved'
        RETURNING ${RESERVATION_COLUMNS}`,
      [reservationId, ownerUserId, at],
    );

    const row = updated.rows[0];

    if (row === undefined) {
      throw new Error('Reservation changed while locked.');
    }

    await client.query(
      `UPDATE usage_buckets
          SET reserved_tokens = reserved_tokens - $3,
              updated_at = $4
        WHERE owner_user_id = $1
          AND day_bucket = $2`,
      [ownerUserId, dayBucket, estimatedTokens, at],
    );

    return row;
  }

  async listUnknownReservationsForUpdate(
    client: Queryable,
    ownerUserId: string,
    dayBucket: string,
  ): Promise<UsageReservationRow[]> {
    const result = await client.query<UsageReservationRow>(
      `SELECT ${RESERVATION_COLUMNS}
         FROM usage_reservations
        WHERE owner_user_id = $1
          AND day_bucket = $2
          AND state = 'unknown'
          AND reconciled_at IS NULL
        ORDER BY created_at ASC, id ASC
        FOR UPDATE`,
      [ownerUserId, dayBucket],
    );

    return result.rows;
  }

  async hasSettledPartial(
    client: Queryable,
    ownerUserId: string,
    dayBucket: string,
  ): Promise<boolean> {
    const result = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM usage_reservations
          WHERE owner_user_id = $1
            AND day_bucket = $2
            AND state = 'settled'
            AND usage_status = 'partial'
       ) AS exists`,
      [ownerUserId, dayBucket],
    );

    return result.rows[0]?.exists === true;
  }

  async applyReconciliation(
    client: Queryable,
    input: ReconciliationInput,
  ): Promise<UsageBucketRow | null> {
    const result = await client.query<UsageBucketRow>(
      `UPDATE usage_buckets
          SET input_tokens = input_tokens + $3,
              output_tokens = output_tokens + $4,
              reserved_tokens = reserved_tokens - $5,
              state = CASE WHEN $6::boolean THEN 'partial' ELSE 'known' END,
              updated_at = $7
        WHERE owner_user_id = $1
          AND day_bucket = $2
          AND state = 'unknown'
        RETURNING ${BUCKET_COLUMNS}`,
      [
        input.ownerUserId,
        input.dayBucket,
        input.resolvedInputTokens,
        input.resolvedOutputTokens,
        input.provisionalTokens,
        input.markPartial,
        input.at,
      ],
    );

    return result.rows[0] ?? null;
  }

  async markReservationsReconciled(
    client: Queryable,
    ownerUserId: string,
    dayBucket: string,
    actorUserId: string,
    note: string,
    at: Date,
  ): Promise<number> {
    const result = await client.query<{ id: string }>(
      `UPDATE usage_reservations
          SET reconciled_at = $3,
              reconciled_by = $4,
              reconcile_note = $5
        WHERE owner_user_id = $1
          AND day_bucket = $2
          AND state = 'unknown'
          AND reconciled_at IS NULL
        RETURNING id`,
      [ownerUserId, dayBucket, at, actorUserId, note],
    );

    return result.rowCount ?? result.rows.length;
  }

  async insertAudit(client: Queryable, input: AuditInput): Promise<UsageAuditRow> {
    const result = await client.query<UsageAuditRow>(
      `INSERT INTO usage_limit_audit (
         owner_user_id, day_bucket, actor_user_id, action, tokens_delta, note, created_at
       )
       VALUES ($1, $2, $3, 'reconcile', $4, $5, $6)
       RETURNING id, owner_user_id, day_bucket::text AS day_bucket, actor_user_id,
                 action, tokens_delta, note, created_at`,
      [
        input.ownerUserId,
        input.dayBucket,
        input.actorUserId,
        input.tokensDelta,
        input.note,
        input.at,
      ],
    );

    const row = result.rows[0];

    if (row === undefined) {
      throw new Error('Allowance audit insert returned no row.');
    }

    return row;
  }

  async listAudit(
    ownerUserId: string,
    dayBucket: string,
  ): Promise<UsageAuditRow[]> {
    const result = await this.pool.query<UsageAuditRow>(
      `SELECT id, owner_user_id, day_bucket::text AS day_bucket, actor_user_id,
              action, tokens_delta, note, created_at
         FROM usage_limit_audit
        WHERE owner_user_id = $1
          AND day_bucket = $2
        ORDER BY created_at ASC, id ASC`,
      [ownerUserId, dayBucket],
    );

    return result.rows;
  }
}

function requireBucket(row: UsageBucketRow | undefined): UsageBucketRow {
  if (row === undefined) {
    throw new Error('Allowance bucket update matched no row.');
  }

  return row;
}
