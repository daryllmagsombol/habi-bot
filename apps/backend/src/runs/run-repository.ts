/**
 * Owner-scoped Run persistence for the H-022 controller.
 *
 * Every statement binds `owner_user_id` in the query itself. A missing row, a
 * foreign row, and a malformed id all surface as the same persistence
 * `not_found`, so a guessed run id cannot be distinguished from another user's
 * run. Terminal transitions are single atomic UPDATEs guarded by the expected
 * non-terminal status, which makes cancel/recovery idempotent and keeps a late
 * writer from rewriting a terminal row.
 */
import type { Pool } from 'pg';
import type { DispatchState } from '../adapters/harness-adapter.js';
import { PersistenceNotFoundError } from '../persistence/errors.js';
import {
  requireActorUserId,
  requireResourceId,
} from '../persistence/rows.js';
import type { PersistedRunUsage } from './usage.js';
import type {
  PersistedRunStatus,
  RunFailureOutcome,
  RunView,
} from './types.js';

type Timestamp = Date | string;
type NullableTimestamp = Timestamp | null;

export interface RunRow {
  id: string;
  owner_user_id: string;
  conversation_id: string;
  idempotency_key: string;
  request_fingerprint: string;
  status: PersistedRunStatus;
  dispatch_state: DispatchState;
  harness_run_id: string | null;
  harness_session_id: string | null;
  error_code: string | null;
  usage_status: 'known' | 'partial' | 'unknown';
  usage_gross_prompt_tokens: string | null;
  usage_gross_completion_tokens: string | null;
  usage_cached_prompt_tokens: string | null;
  usage_reasoning_tokens: string | null;
  usage_total_tokens: string | null;
  usage_cost_status: 'known' | 'unknown';
  last_event_seq: string;
  created_at: Timestamp;
  updated_at: Timestamp;
  started_at: NullableTimestamp;
  finished_at: NullableTimestamp;
}

const RUN_COLUMNS = `id, owner_user_id, conversation_id, idempotency_key,
  request_fingerprint, status, dispatch_state, harness_run_id,
  harness_session_id, error_code, usage_status, usage_gross_prompt_tokens,
  usage_gross_completion_tokens, usage_cached_prompt_tokens,
  usage_reasoning_tokens, usage_total_tokens, usage_cost_status,
  last_event_seq, created_at, updated_at, started_at, finished_at`;

const RUN_BY_ID = `SELECT ${RUN_COLUMNS}
   FROM runs
  WHERE id = $1
    AND owner_user_id = $2`;

const RUN_BY_ID_FOR_UPDATE = `${RUN_BY_ID} FOR UPDATE`;

const RUN_BY_IDEMPOTENCY_KEY = `SELECT ${RUN_COLUMNS}
   FROM runs
  WHERE owner_user_id = $1
    AND idempotency_key = $2`;

const NON_TERMINAL_STATUSES = ['queued', 'running', 'retry_wait'] as const;

export interface InsertQueuedRunInput {
  ownerUserId: string;
  conversationId: string;
  idempotencyKey: string;
  requestFingerprint: string;
}

export interface TerminalizeRunInput {
  runId: string;
  ownerUserId: string;
  status: RunFailureOutcome;
  /** Incoming dispatch state; existing `dispatched`/`unknown` is never downgraded. */
  dispatchState: DispatchState | null;
  errorCode: string | null;
  usage: PersistedRunUsage;
  lastEventSeq: number;
  /** Whether the terminal state implies execution started. */
  startExecution: boolean;
  /**
   * Replace the stored dispatch state with the incoming value instead of only
   * upgrading `not_dispatched`. Used by `lost`, where the harness could not
   * confirm a possible dispatch and H-021 collapses the state to `unknown`.
   */
  replaceDispatchState?: boolean;
}

function toIso(value: Timestamp): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toNullableIso(value: NullableTimestamp): string | null {
  return value === null ? null : toIso(value);
}

function toBigInt(value: string | number | null): number | null {
  if (value === null) {
    return null;
  }

  const number = typeof value === 'number' ? value : Number(value);

  if (!Number.isSafeInteger(number) || number < 0) {
    throw new TypeError('Persisted run usage is outside the supported integer range.');
  }

  return number;
}

export function toRunView(row: RunRow): RunView {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    status: row.status,
    dispatchState: row.dispatch_state,
    errorCode: row.error_code,
    lastEventSeq: toBigInt(row.last_event_seq) ?? 0,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    startedAt: toNullableIso(row.started_at),
    finishedAt: toNullableIso(row.finished_at),
    usage: {
      status: row.usage_status,
      grossPromptTokens: toBigInt(row.usage_gross_prompt_tokens),
      grossCompletionTokens: toBigInt(row.usage_gross_completion_tokens),
      cachedPromptTokens: toBigInt(row.usage_cached_prompt_tokens),
      reasoningTokens: toBigInt(row.usage_reasoning_tokens),
      totalTokens: toBigInt(row.usage_total_tokens),
      costStatus: row.usage_cost_status,
    },
  };
}

function serializeRaw(raw: Readonly<Record<string, unknown>>): string {
  try {
    return JSON.stringify(raw);
  } catch {
    // A circular or otherwise unserializable vendor payload is not worth
    // failing terminalization over; the usage status still records the truth.
    return '{}';
  }
}

export class RunRepository {
  constructor(private readonly pool: Pool) {}

  /** Loads one Run through the owner predicate; never returns a foreign row. */
  async loadOwnedRun(
    actorUserId: string,
    runId: string,
    forUpdate = false,
  ): Promise<RunRow> {
    const ownerUserId = requireActorUserId(actorUserId);
    const ownedRunId = requireResourceId(runId);

    const result = await this.pool.query<RunRow>(
      forUpdate ? RUN_BY_ID_FOR_UPDATE : RUN_BY_ID,
      [ownedRunId, ownerUserId],
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new PersistenceNotFoundError();
    }

    return row;
  }

  async findByIdempotencyKey(
    actorUserId: string,
    idempotencyKey: string,
  ): Promise<RunRow | null> {
    const ownerUserId = requireActorUserId(actorUserId);

    const result = await this.pool.query<RunRow>(RUN_BY_IDEMPOTENCY_KEY, [
      ownerUserId,
      idempotencyKey,
    ]);

    return result.rows[0] ?? null;
  }

  /**
   * Reserves one queued Run. The unique `(owner_user_id, idempotency_key)`
   * constraint is the dedupe authority; a concurrent submitter inserts nothing
   * and must read the winner instead of dispatching.
   */
  async insertQueued(input: InsertQueuedRunInput): Promise<RunRow | null> {
    const result = await this.pool.query<RunRow>(
      `INSERT INTO runs (
         owner_user_id,
         conversation_id,
         idempotency_key,
         request_fingerprint,
         status,
         dispatch_state,
         usage_status,
         usage_cost_status
       )
       VALUES ($1, $2, $3, $4, 'queued', 'not_dispatched', 'unknown', 'unknown')
       ON CONFLICT (owner_user_id, idempotency_key) DO NOTHING
       RETURNING ${RUN_COLUMNS}`,
      [
        requireActorUserId(input.ownerUserId),
        requireResourceId(input.conversationId),
        input.idempotencyKey,
        input.requestFingerprint,
      ],
    );

    return result.rows[0] ?? null;
  }

  /**
   * Records the adapter's accepted dispatch. Only a queued row can transition,
   * so a duplicate dispatch result cannot resurrect a terminal run.
   */
  async recordDispatch(
    runId: string,
    ownerUserId: string,
    dispatchState: DispatchState,
    harnessRunId: string | null,
    harnessSessionId: string | null,
  ): Promise<RunRow | null> {
    const result = await this.pool.query<RunRow>(
      `UPDATE runs
          SET dispatch_state = $3,
              harness_run_id = COALESCE($4, harness_run_id),
              harness_session_id = COALESCE($5, harness_session_id),
              status = CASE WHEN $3 = 'dispatched' THEN 'running' ELSE status END,
              started_at = CASE
                WHEN $3 = 'dispatched' THEN COALESCE(started_at, now())
                ELSE started_at
              END,
              updated_at = now()
        WHERE id = $1
          AND owner_user_id = $2
          AND status = 'queued'
        RETURNING ${RUN_COLUMNS}`,
      [
        requireResourceId(runId),
        requireActorUserId(ownerUserId),
        dispatchState,
        harnessRunId,
        harnessSessionId,
      ],
    );

    return result.rows[0] ?? null;
  }

  /**
   * Atomically applies one terminal outcome. Returns null when another writer
   * already terminalized the row; the caller then returns the stored terminal
   * row unchanged rather than rewriting its finish time.
   */
  async terminalize(input: TerminalizeRunInput): Promise<RunRow | null> {
    const usage = input.usage;

    const result = await this.pool.query<RunRow>(
      `UPDATE runs
          SET status = $3,
              dispatch_state = CASE
                WHEN $4::text IS NULL THEN dispatch_state
                WHEN $17::boolean THEN $4::text
                WHEN dispatch_state = 'not_dispatched' THEN $4::text
                ELSE dispatch_state
              END,
              error_code = $5,
              usage_status = $6,
              usage_gross_prompt_tokens = $7,
              usage_gross_completion_tokens = $8,
              usage_cached_prompt_tokens = $9,
              usage_reasoning_tokens = $10,
              usage_total_tokens = $11,
              usage_cost_status = $12,
              usage_raw = $13::jsonb,
              last_event_seq = GREATEST(last_event_seq, $14::bigint),
              started_at = CASE
                WHEN $15::boolean THEN COALESCE(started_at, now())
                ELSE started_at
              END,
              finished_at = COALESCE(finished_at, now()),
              updated_at = now()
        WHERE id = $1
          AND owner_user_id = $2
          AND status = ANY($16::text[])
        RETURNING ${RUN_COLUMNS}`,
      [
        requireResourceId(input.runId),
        requireActorUserId(input.ownerUserId),
        input.status,
        input.dispatchState,
        input.errorCode,
        usage.status,
        usage.grossPromptTokens,
        usage.grossCompletionTokens,
        usage.cachedPromptTokens,
        usage.reasoningTokens,
        usage.totalTokens,
        usage.costStatus,
        serializeRaw(usage.raw),
        input.lastEventSeq,
        input.startExecution,
        NON_TERMINAL_STATUSES,
        input.replaceDispatchState ?? false,
      ],
    );

    return result.rows[0] ?? null;
  }

  /**
   * Reconciliation confirmed the harness is still running: adopt the highest
   * applied seq and never claim more than one live run per Habi run.
   */
  async recordStillRunning(
    runId: string,
    ownerUserId: string,
    lastEventSeq: number,
  ): Promise<RunRow | null> {
    const result = await this.pool.query<RunRow>(
      `UPDATE runs
          SET status = CASE WHEN status = 'queued' THEN 'running' ELSE status END,
              dispatch_state = CASE
                WHEN dispatch_state = 'not_dispatched' THEN 'dispatched'
                ELSE dispatch_state
              END,
              last_event_seq = GREATEST(last_event_seq, $3::bigint),
              started_at = COALESCE(started_at, now()),
              updated_at = now()
        WHERE id = $1
          AND owner_user_id = $2
          AND status = ANY($4::text[])
        RETURNING ${RUN_COLUMNS}`,
      [
        requireResourceId(runId),
        requireActorUserId(ownerUserId),
        lastEventSeq,
        NON_TERMINAL_STATUSES,
      ],
    );

    return result.rows[0] ?? null;
  }

  /**
   * Non-terminal rows for restart reconciliation. Passing an owner narrows the
   * scan to that user; the caller never derives ownership from a payload id.
   */
  async listNonTerminal(actorUserId: string | null): Promise<RunRow[]> {
    const ownerUserId =
      actorUserId === null ? null : requireActorUserId(actorUserId);

    const result = await this.pool.query<RunRow>(
      `SELECT ${RUN_COLUMNS}
         FROM runs
        WHERE status = ANY($1::text[])
          AND ($2::uuid IS NULL OR owner_user_id = $2::uuid)
        ORDER BY created_at ASC, id ASC`,
      [NON_TERMINAL_STATUSES, ownerUserId],
    );

    return result.rows;
  }
}
