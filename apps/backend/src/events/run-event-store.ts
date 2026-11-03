/**
 * H-020 (#20) RunEventStore: append-only, ordered persistence with owner-scoped
 * replay.
 *
 * Invariants:
 *   - Every read binds `owner_user_id` in SQL. A foreign or unknown Run, and a
 *     cursor bound to another Run, are the same `not_found`; the caller cannot
 *     enumerate Runs.
 *   - Append takes the Run row lock, verifies no terminal event exists, then
 *     advances `runs.last_event_seq` and inserts the event in one transaction.
 *     Concurrent writers therefore receive unique, contiguous `seq` values.
 *   - A caller-supplied `eventId` is the append idempotency key. A retry returns
 *     the stored event and allocates no new sequence.
 *   - `seq` is server-assigned. No method updates or deletes an event; the
 *     database trigger also rejects both except for a parent-Run cascade.
 *   - Replay pages are bounded, and a terminal event is reported so a stream
 *     can stop rather than waiting forever.
 *
 * This module has no HTTP transport, SSE encoder, Nest provider, or retention
 * sweep. The stream abstraction in `run-event-stream.ts` is process-local.
 */
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { withTransaction } from '../persistence/database.js';
import {
  PersistenceNotFoundError,
  PersistenceValidationError,
} from '../persistence/errors.js';
import {
  requireActorUserId,
  requireResourceId,
} from '../persistence/rows.js';
import { RunEventStreamClosedError } from './errors.js';
import { RunEventHub } from './run-event-hub.js';
import type {
  AppendRunEventInput,
  AppendRunEventResult,
  RunEventEnvelope,
  RunEventPosition,
  RunEventReplayOptions,
  RunEventReplayPage,
} from './types.js';
import { RUN_TERMINAL_EVENT_TYPES } from './types.js';
import {
  decodeRunEventCursor,
  normalizeEventId,
  normalizeEventType,
  normalizeAfterSeq,
  normalizeReplayLimit,
  serializeEventPayload,
} from './validation.js';

type Timestamp = Date | string;

interface RunEventRow {
  id: string;
  run_id: string;
  owner_user_id: string;
  conversation_id: string;
  seq: string;
  type: string;
  payload: unknown;
  created_at: Timestamp;
}

interface RunScopeRow {
  conversation_id: string;
}

interface EventIdRow {
  run_id: string;
  owner_user_id: string;
}

interface AllocatedSequenceRow {
  last_event_seq: string;
}

interface RunPositionRow {
  conversation_id: string;
  last_event_seq: string;
  terminal_seq: string | null;
}

const EVENT_COLUMNS = `id, run_id, owner_user_id, conversation_id, seq, type,
  payload, created_at`;

const RUN_FOR_APPEND = `SELECT conversation_id
   FROM runs
  WHERE id = $1
    AND owner_user_id = $2
  FOR UPDATE`;

const EVENT_BY_ID = `SELECT ${EVENT_COLUMNS}
   FROM run_events
  WHERE id = $1
    AND run_id = $2
    AND owner_user_id = $3`;

const EVENT_ID_OWNER = `SELECT run_id, owner_user_id
   FROM run_events
  WHERE id = $1`;

const TERMINAL_EXISTS = `SELECT 1
   FROM run_events
  WHERE run_id = $1
    AND type = ANY($2::text[])
  LIMIT 1`;

const ALLOCATE_SEQUENCE = `UPDATE runs
   SET last_event_seq = last_event_seq + 1,
       updated_at = now()
 WHERE id = $1
   AND owner_user_id = $2
 RETURNING last_event_seq`;

const INSERT_EVENT = `INSERT INTO run_events (
   id,
   run_id,
   owner_user_id,
   conversation_id,
   seq,
   type,
   payload
 )
 VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
 RETURNING ${EVENT_COLUMNS}`;

const READ_PAGE = `SELECT ${EVENT_COLUMNS}
   FROM run_events
  WHERE run_id = $1
    AND owner_user_id = $2
    AND seq > $3
    -- A late write after the terminal event is discarded, not replayed.
    AND ($5::bigint IS NULL OR seq <= $5::bigint)
  ORDER BY seq ASC
  LIMIT $4`;

/**
 * One statement keeps position, terminal detection, and the replay cursor on
 * the same Run row. The partial terminal index serves the subquery.
 */
const LOAD_POSITION = `SELECT r.conversation_id,
       r.last_event_seq,
       (
         SELECT min(e.seq)
           FROM run_events e
          WHERE e.run_id = r.id
            AND e.owner_user_id = r.owner_user_id
            AND e.type = ANY($3::text[])
       ) AS terminal_seq
   FROM runs r
  WHERE r.id = $1
    AND r.owner_user_id = $2`;

function toSequence(value: string | number): number {
  const sequence = typeof value === 'number' ? value : Number(value);

  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new TypeError('Persisted event sequence is outside the supported integer range.');
  }

  return sequence;
}

function toNullableSequence(value: string | number | null): number | null {
  return value === null ? null : toSequence(value);
}

function toIso(value: Timestamp): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toPayload(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  throw new TypeError('Stored Run event payload is not a JSON object.');
}

function toEnvelope(row: RunEventRow): RunEventEnvelope {
  return {
    id: row.id,
    runId: row.run_id,
    ownerUserId: row.owner_user_id,
    conversationId: row.conversation_id,
    seq: toSequence(row.seq),
    type: row.type,
    payload: toPayload(row.payload),
    createdAt: toIso(row.created_at),
  };
}

export class RunEventStore {
  constructor(
    private readonly pool: Pool,
    readonly hub: RunEventHub = new RunEventHub(),
  ) {}

  /**
   * Appends one event for `ownerUserId`'s Run.
   *
   * `ownerUserId` is the Run owner recorded by the server, not an actor from
   * client input. A system writer obtains it from the loaded Run; the store
   * re-checks it in SQL so a wrong owner is an indistinguishable not-found.
   */
  async append(
    ownerUserId: string,
    input: AppendRunEventInput,
  ): Promise<AppendRunEventResult> {
    const owner = requireActorUserId(ownerUserId);
    const runId = requireResourceId(input.runId);
    const type = normalizeEventType(input.type);
    const payload = serializeEventPayload(input.payload);
    const eventId = normalizeEventId(input.eventId);

    const result = await withTransaction(this.pool, async (client) => {
      const run = await client.query<RunScopeRow>(RUN_FOR_APPEND, [runId, owner]);
      const runRow = run.rows[0];

      if (runRow === undefined) {
        throw new PersistenceNotFoundError();
      }

      if (eventId !== undefined) {
        const existing = await client.query<RunEventRow>(EVENT_BY_ID, [
          eventId,
          runId,
          owner,
        ]);
        const existingRow = existing.rows[0];

        if (existingRow !== undefined) {
          return {
            event: toEnvelope(existingRow),
            deduplicated: true,
          };
        }

        // A client id already used by another Run is a caller error. It is not
        // queried for content and reveals nothing about that Run.
        const collision = await client.query<EventIdRow>(EVENT_ID_OWNER, [eventId]);

        if (collision.rows[0] !== undefined) {
          throw new PersistenceValidationError('invalid_input');
        }
      }

      const terminal = await client.query(TERMINAL_EXISTS, [
        runId,
        RUN_TERMINAL_EVENT_TYPES,
      ]);

      if (terminal.rows.length > 0) {
        throw new RunEventStreamClosedError();
      }

      const allocated = await client.query<AllocatedSequenceRow>(
        ALLOCATE_SEQUENCE,
        [runId, owner],
      );
      const allocatedRow = allocated.rows[0];

      if (allocatedRow === undefined) {
        throw new PersistenceNotFoundError();
      }

      const inserted = await client.query<RunEventRow>(INSERT_EVENT, [
        eventId ?? randomUUID(),
        runId,
        owner,
        runRow.conversation_id,
        toSequence(allocatedRow.last_event_seq),
        type,
        payload,
      ]);
      const insertedRow = inserted.rows[0];

      if (insertedRow === undefined) {
        throw new Error('Run event append did not return the stored row.');
      }

      return {
        event: toEnvelope(insertedRow),
        deduplicated: false,
      };
    });

    if (!result.deduplicated) {
      this.hub.publish(runId);
    }

    return result;
  }

  /** Owner-scoped replay page from an exclusive `afterSeq` cursor. */
  async read(
    actorUserId: string,
    runId: string,
    options: RunEventReplayOptions = {},
  ): Promise<RunEventReplayPage> {
    const actor = requireActorUserId(actorUserId);
    const ownedRunId = requireResourceId(runId);
    const afterSeq = normalizeAfterSeq(options.afterSeq ?? 0);
    const limit = normalizeReplayLimit(options.limit);

    const position = await this.loadPosition(actor, ownedRunId);

    // A cursor beyond the stored stream cannot come from this Run. Treat it as
    // the same not-found used for a foreign Run rather than leaking a bound.
    if (afterSeq > position.lastEventSeq) {
      throw new PersistenceNotFoundError();
    }

    const effectiveLastSeq =
      position.terminalEventSeq ?? position.lastEventSeq;

    // The terminal event is already applied; there is nothing left to replay,
    // even if a late row was written after it.
    if (position.terminalEventSeq !== null && afterSeq >= position.terminalEventSeq) {
      return {
        runId: ownedRunId,
        afterSeq,
        events: [],
        hasMore: false,
        lastEventSeq: effectiveLastSeq,
        terminalEventSeq: position.terminalEventSeq,
      };
    }

    const result = await this.pool.query<RunEventRow>(READ_PAGE, [
      ownedRunId,
      actor,
      afterSeq,
      limit + 1,
      position.terminalEventSeq,
    ]);
    const hasMore = result.rows.length > limit;
    const rows = hasMore ? result.rows.slice(0, limit) : result.rows;

    return {
      runId: ownedRunId,
      afterSeq,
      events: rows.map(toEnvelope),
      hasMore,
      lastEventSeq: effectiveLastSeq,
      terminalEventSeq: position.terminalEventSeq,
    };
  }

  /**
   * Replay from an encoded cursor. A cursor that names a different Run is
   * rejected with the same not-found as a foreign Run; the cursor never grants
   * access on its own.
   */
  async readAfterCursor(
    actorUserId: string,
    runId: string,
    cursor: string,
    options: Pick<RunEventReplayOptions, 'limit'> = {},
  ): Promise<RunEventReplayPage> {
    const ownedRunId = requireResourceId(runId);
    const decoded = decodeRunEventCursor(cursor);

    if (decoded.runId !== ownedRunId) {
      throw new PersistenceNotFoundError();
    }

    return this.read(actorUserId, ownedRunId, {
      afterSeq: decoded.afterSeq,
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    });
  }

  /**
   * Owner-scoped Run position. Also verifies the Run exists for this actor and
   * exposes the terminal sequence so a subscriber can stop cleanly.
   */
  async loadPosition(
    actorUserId: string,
    runId: string,
  ): Promise<RunEventPosition> {
    const actor = requireActorUserId(actorUserId);
    const ownedRunId = requireResourceId(runId);
    const result = await this.pool.query<RunPositionRow>(LOAD_POSITION, [
      ownedRunId,
      actor,
      RUN_TERMINAL_EVENT_TYPES,
    ]);
    const row = result.rows[0];

    if (row === undefined) {
      throw new PersistenceNotFoundError();
    }

    return {
      runId: ownedRunId,
      conversationId: row.conversation_id,
      lastEventSeq: toSequence(row.last_event_seq),
      terminalEventSeq: toNullableSequence(row.terminal_seq),
    };
  }
}
