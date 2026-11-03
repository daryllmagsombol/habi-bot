/**
 * H-030 (#30) owner-scoped SQL for memories.
 *
 * Every statement binds the authenticated actor to `owner_user_id`. A foreign,
 * guessed, malformed, tombstoned, or archived-scope identifier produces the
 * same non-enumerating `not_found`; there is no client-supplied owner field.
 *
 * Recall is deliberately narrower than "readable": it requires an explicitly
 * accepted row, both D2 gates, a live own conversation under an active own Bot,
 * and that same conversation id. Memory is never recalled across Bots or
 * conversations, and never becomes recallable merely because it exists.
 *
 * `memory_audit` is written only by `insertAudit`. No statement in this module
 * updates or deletes an audit row.
 */
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { withTransaction } from '../persistence/database.js';
import type { Queryable } from '../persistence/database.js';
import {
  PersistenceNotFoundError,
  PersistenceValidationError,
} from '../persistence/errors.js';
import {
  requireActorUserId,
  requireResourceId,
  requireRow,
  toIso,
  toNullableIso,
  type NullableTimestamp,
  type Timestamp,
} from '../persistence/rows.js';
import type {
  ListMemoriesOptions,
  Memory,
  MemoryAuditAction,
  MemoryProvenanceState,
  MemoryStatus,
  ProposeMemoryRecord,
  SourceDeletionResult,
  SourceDeletedInput,
} from './types.js';
import {
  normalizeApprovalFlag,
  normalizeListMemoriesOptions,
  normalizeRecallMemoriesOptions,
  normalizeSourceDeletedInput,
} from './validation.js';

type ApprovalGate = 'bot' | 'conversation';

interface MemoryRow {
  id: string;
  owner_user_id: string;
  bot_id: string;
  conversation_id: string | null;
  content: string;
  source_message_id: string | null;
  status: string;
  bot_approved: boolean;
  conversation_approved: boolean;
  provenance_state: string;
  provenance_tombstoned_at: NullableTimestamp;
  created_at: Timestamp;
  updated_at: Timestamp;
  deleted_at: NullableTimestamp;
}

const MEMORY_COLUMNS = `m.id, m.owner_user_id, m.bot_id, m.conversation_id,
  m.content, m.source_message_id, m.status, m.bot_approved,
  m.conversation_approved, m.provenance_state, m.provenance_tombstoned_at,
  m.created_at, m.updated_at, m.deleted_at`;

const MEMORY_RETURNING = `id, owner_user_id, bot_id, conversation_id, content,
  source_message_id, status, bot_approved, conversation_approved,
  provenance_state, provenance_tombstoned_at, created_at, updated_at,
  deleted_at`;

/** Owner-scoped live row. A tombstone is visible only to `delete`. */
const MEMORY_BY_ID_LIVE = `SELECT ${MEMORY_COLUMNS}
   FROM memories m
  WHERE m.id = $1
    AND m.owner_user_id = $2
    AND m.deleted_at IS NULL`;

/** Owner-scoped row including a tombstone; still never a foreign row. */
const MEMORY_BY_ID_ANY = `SELECT ${MEMORY_COLUMNS}
   FROM memories m
  WHERE m.id = $1
    AND m.owner_user_id = $2`;

const MEMORY_LOCK = 'FOR UPDATE OF m';

function toStatus(value: string): MemoryStatus {
  if (value !== 'proposed' && value !== 'accepted' && value !== 'deleted') {
    throw new Error('Persisted memory has an unexpected lifecycle status.');
  }

  return value;
}

function toProvenanceState(value: string): MemoryProvenanceState {
  if (value !== 'live' && value !== 'tombstoned') {
    throw new Error('Persisted memory has an unexpected provenance state.');
  }

  return value;
}

/** Maps an internal row to the public shape, dropping the owner column. */
function toMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    botId: row.bot_id,
    conversationId: row.conversation_id,
    content: row.content,
    sourceMessageId: row.source_message_id,
    status: toStatus(row.status),
    botApproved: row.bot_approved,
    conversationApproved: row.conversation_approved,
    provenanceState: toProvenanceState(row.provenance_state),
    provenanceTombstonedAt: toNullableIso(row.provenance_tombstoned_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    deletedAt: toNullableIso(row.deleted_at),
  };
}

/**
 * Audit action for one D2 gate transition. The gate and the direction together
 * select the recorded action, so approval and revocation stay distinguishable.
 */
function toApprovalAuditAction(
  gate: ApprovalGate,
  approved: boolean,
): MemoryAuditAction {
  if (gate === 'bot') {
    return approved ? 'approve_bot' : 'revoke_bot';
  }

  return approved ? 'approve_conversation' : 'revoke_conversation';
}

/**
 * Appends one audit row. This is the only audit write in the module, so the
 * convention is enforced by construction rather than by a database trigger.
 */
async function insertAudit(
  client: Queryable,
  ownerUserId: string,
  memoryId: string,
  action: MemoryAuditAction,
  actorUserId: string,
  note: string,
): Promise<void> {
  await client.query(
    `INSERT INTO memory_audit (
       id, owner_user_id, memory_id, action, actor_user_id, note
     )
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [randomUUID(), ownerUserId, memoryId, action, actorUserId, note],
  );
}

export class MemoryRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * Inserts a proposed Memory only when the source conversation is live and
   * owned, belongs to the named active owned Bot, and the optional source
   * message is in that same conversation. Gates start off and status starts
   * `proposed`; acceptance is a separate explicit call.
   */
  async propose(
    actorUserId: string,
    record: ProposeMemoryRecord,
  ): Promise<Memory> {
    const ownerUserId = requireActorUserId(actorUserId);
    const conversationId = requireResourceId(record.conversationId);
    const botId = requireResourceId(record.botId);
    const sourceMessageId =
      record.sourceMessageId === null
        ? null
        : requireResourceId(record.sourceMessageId);
    const memoryId = randomUUID();

    return withTransaction(this.pool, async (client) => {
      if (sourceMessageId !== null) {
        const message = await client.query(
          `SELECT 1
             FROM messages
            WHERE id = $1
              AND conversation_id = $2
              AND owner_user_id = $3
              AND deleted_at IS NULL
              AND status <> 'deleted'`,
          [sourceMessageId, conversationId, ownerUserId],
        );

        if (message.rows[0] === undefined) {
          throw new PersistenceNotFoundError();
        }
      }

      const result = await client.query<MemoryRow>(
        `INSERT INTO memories (
           id, owner_user_id, bot_id, conversation_id, content,
           source_message_id
         )
         SELECT $1, c.owner_user_id, c.bot_id, c.id, $3, $4
           FROM conversations c
           JOIN bots b
             ON b.id = c.bot_id
            AND b.owner_user_id = c.owner_user_id
          WHERE c.id = $2
            AND c.owner_user_id = $5
            AND c.bot_id = $6
            AND c.deleted_at IS NULL
            AND b.status = 'active'
            AND b.deleted_at IS NULL
         RETURNING ${MEMORY_RETURNING}`,
        [memoryId, conversationId, record.content, sourceMessageId, ownerUserId, botId],
      );

      const row = requireRow(result);
      await insertAudit(
        client,
        ownerUserId,
        row.id,
        'propose',
        ownerUserId,
        'memory proposed; both recall gates default off',
      );

      return toMemory(row);
    });
  }

  /** Owner-scoped inspect of one live Memory. Tombstones are not returned. */
  async get(actorUserId: string, memoryId: string): Promise<Memory> {
    const ownerUserId = requireActorUserId(actorUserId);
    const id = requireResourceId(memoryId);

    return toMemory(
      requireRow(await this.pool.query<MemoryRow>(MEMORY_BY_ID_LIVE, [id, ownerUserId])),
    );
  }

  /** Owner-scoped listing. Deleted rows only list when explicitly filtered. */
  async list(
    actorUserId: string,
    options: ListMemoriesOptions = {},
  ): Promise<Memory[]> {
    const ownerUserId = requireActorUserId(actorUserId);
    const normalized = normalizeListMemoriesOptions(options);
    const values: unknown[] = [ownerUserId];
    const conditions = ['m.owner_user_id = $1'];

    if (normalized.status === null) {
      conditions.push('m.deleted_at IS NULL');
    } else {
      values.push(normalized.status);
      conditions.push(`m.status = $${values.length}`);
    }

    if (normalized.botId !== null) {
      values.push(normalized.botId);
      conditions.push(`m.bot_id = $${values.length}`);
    }

    if (normalized.conversationId !== null) {
      values.push(normalized.conversationId);
      conditions.push(`m.conversation_id = $${values.length}`);
    }

    values.push(normalized.limit);
    const limitParameter = `$${values.length}`;
    values.push(normalized.offset);
    const offsetParameter = `$${values.length}`;

    const result = await this.pool.query<MemoryRow>(
      `SELECT ${MEMORY_COLUMNS}
         FROM memories m
        WHERE ${conditions.join('\n          AND ')}
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT ${limitParameter} OFFSET ${offsetParameter}`,
      values,
    );

    return result.rows.map(toMemory);
  }

  /**
   * D2 recall. The row must be accepted, both gates must be on, its provenance
   * must still be live, and its conversation/Bot must be the exact live scope
   * supplied by the caller. An archived or tombstoned ancestor denies recall.
   */
  async recall(
    actorUserId: string,
    options: { botId: string; conversationId: string; limit?: number },
  ): Promise<Memory[]> {
    const ownerUserId = requireActorUserId(actorUserId);
    const normalized = normalizeRecallMemoriesOptions(options);

    const result = await this.pool.query<MemoryRow>(
      `SELECT ${MEMORY_COLUMNS}
         FROM memories m
         JOIN conversations c
           ON c.id = m.conversation_id
          AND c.owner_user_id = m.owner_user_id
         JOIN bots b
           ON b.id = m.bot_id
          AND b.owner_user_id = m.owner_user_id
        WHERE m.owner_user_id = $1
          AND m.bot_id = $2
          AND m.conversation_id = $3
          AND c.deleted_at IS NULL
          AND b.status = 'active'
          AND b.deleted_at IS NULL
          AND m.status = 'accepted'
          AND m.bot_approved
          AND m.conversation_approved
          AND m.provenance_state = 'live'
          AND m.deleted_at IS NULL
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT $4`,
      [ownerUserId, normalized.botId, normalized.conversationId, normalized.limit],
    );

    return result.rows.map(toMemory);
  }

  /**
   * Sets or clears one D2 gate. A missing argument means the off default.
   * Revoking either gate demotes an accepted Memory to `proposed`, so recall
   * stops immediately and acceptance must be repeated explicitly.
   */
  async setApproval(
    actorUserId: string,
    memoryId: string,
    gate: ApprovalGate,
    approved: boolean,
  ): Promise<Memory> {
    const ownerUserId = requireActorUserId(actorUserId);
    const id = requireResourceId(memoryId);
    const nextApproval = normalizeApprovalFlag(approved);

    return withTransaction(this.pool, async (client) => {
      const current = await this.loadForUpdate(
        client,
        MEMORY_BY_ID_LIVE,
        id,
        ownerUserId,
      );
      const nextBotApproved =
        gate === 'bot' ? nextApproval : current.bot_approved;
      const nextConversationApproved =
        gate === 'conversation' ? nextApproval : current.conversation_approved;

      if (
        nextBotApproved === current.bot_approved &&
        nextConversationApproved === current.conversation_approved
      ) {
        return toMemory(current);
      }

      if (
        gate === 'conversation' &&
        nextApproval &&
        current.conversation_id === null
      ) {
        throw new PersistenceValidationError('invalid_input');
      }

      const nextStatus: MemoryStatus =
        current.status === 'accepted' &&
        !(nextBotApproved && nextConversationApproved)
          ? 'proposed'
          : toStatus(current.status);

      const result = await client.query<MemoryRow>(
        `UPDATE memories
            SET bot_approved = $3,
                conversation_approved = $4,
                status = $5,
                updated_at = now()
          WHERE id = $1
            AND owner_user_id = $2
            AND deleted_at IS NULL
          RETURNING ${MEMORY_RETURNING}`,
        [id, ownerUserId, nextBotApproved, nextConversationApproved, nextStatus],
      );

      const row = requireRow(result);
      const action = toApprovalAuditAction(gate, nextApproval);

      await insertAudit(
        client,
        ownerUserId,
        row.id,
        action,
        ownerUserId,
        nextApproval
          ? `${gate} recall gate approved`
          : `${gate} recall gate revoked`,
      );

      return toMemory(row);
    });
  }

  /**
   * Explicit acceptance. Both gates must already be on; the row stays
   * `proposed` otherwise, so acceptance can never be inferred from a proposal.
   */
  async accept(actorUserId: string, memoryId: string): Promise<Memory> {
    const ownerUserId = requireActorUserId(actorUserId);
    const id = requireResourceId(memoryId);

    return withTransaction(this.pool, async (client) => {
      const current = await this.loadForUpdate(
        client,
        MEMORY_BY_ID_LIVE,
        id,
        ownerUserId,
      );

      if (current.status === 'accepted') {
        return toMemory(current);
      }

      if (
        !current.bot_approved ||
        !current.conversation_approved ||
        current.conversation_id === null ||
        current.provenance_state !== 'live'
      ) {
        throw new PersistenceValidationError('invalid_input');
      }

      const result = await client.query<MemoryRow>(
        `UPDATE memories
            SET status = 'accepted',
                updated_at = now()
          WHERE id = $1
            AND owner_user_id = $2
            AND status = 'proposed'
            AND deleted_at IS NULL
          RETURNING ${MEMORY_RETURNING}`,
        [id, ownerUserId],
      );

      const row = requireRow(result);
      await insertAudit(
        client,
        ownerUserId,
        row.id,
        'accept',
        ownerUserId,
        'memory explicitly accepted',
      );

      return toMemory(row);
    });
  }

  /**
   * Explicit tombstone. Idempotent for the owner: a repeated delete returns the
   * stored row without writing a second audit row. Foreign and guessed ids are
   * not found.
   */
  async delete(actorUserId: string, memoryId: string): Promise<Memory> {
    const ownerUserId = requireActorUserId(actorUserId);
    const id = requireResourceId(memoryId);

    return withTransaction(this.pool, async (client) => {
      const current = await this.loadForUpdate(
        client,
        MEMORY_BY_ID_ANY,
        id,
        ownerUserId,
      );

      if (current.status === 'deleted') {
        return toMemory(current);
      }

      const result = await client.query<MemoryRow>(
        `UPDATE memories
            SET status = 'deleted',
                deleted_at = now(),
                updated_at = now()
          WHERE id = $1
            AND owner_user_id = $2
            AND status <> 'deleted'
          RETURNING ${MEMORY_RETURNING}`,
        [id, ownerUserId],
      );

      const row = requireRow(result);
      await insertAudit(
        client,
        ownerUserId,
        row.id,
        'delete',
        ownerUserId,
        'memory deleted explicitly',
      );

      return toMemory(row);
    });
  }

  /**
   * D3 source-deletion handler. Accepted memories survive with provenance
   * nulled and tombstoned plus an audit row; unaccepted proposals are removed
   * (tombstoned) because they were never accepted facts. The caller is the
   * owner whose conversation/message is being deleted.
   */
  async onSourceDeleted(
    actorUserId: string,
    input: SourceDeletedInput,
  ): Promise<SourceDeletionResult> {
    const ownerUserId = requireActorUserId(actorUserId);
    const source = normalizeSourceDeletedInput(input);

    return withTransaction(this.pool, async (client) => {
      const values: unknown[] = [ownerUserId, source.conversationId];
      let messageFilter = '';

      if (source.sourceMessageId !== null) {
        values.push(source.sourceMessageId);
        messageFilter = `\n          AND m.source_message_id = $${values.length}`;
      }

      const affected = await client.query<MemoryRow>(
        `SELECT ${MEMORY_COLUMNS}
           FROM memories m
          WHERE m.owner_user_id = $1
            AND m.conversation_id = $2
            AND m.provenance_state = 'live'
            AND m.deleted_at IS NULL${messageFilter}
          ORDER BY m.created_at ASC, m.id ASC
          FOR UPDATE OF m`,
        values,
      );

      const retainedMemoryIds: string[] = [];
      const removedMemoryIds: string[] = [];
      const note =
        source.sourceMessageId === null
          ? `source conversation ${source.conversationId} deleted`
          : `source message ${source.sourceMessageId} deleted`;

      for (const row of affected.rows) {
        const memoryId = row.id;

        if (row.status === 'accepted') {
          const updated = await client.query<MemoryRow>(
            `UPDATE memories
                SET conversation_id = NULL,
                    source_message_id = NULL,
                    provenance_state = 'tombstoned',
                    provenance_tombstoned_at = now(),
                    updated_at = now()
              WHERE id = $1
                AND owner_user_id = $2
              RETURNING ${MEMORY_RETURNING}`,
            [memoryId, ownerUserId],
          );

          requireRow(updated);
          retainedMemoryIds.push(memoryId);
        } else {
          const updated = await client.query<MemoryRow>(
            `UPDATE memories
                SET status = 'deleted',
                    deleted_at = now(),
                    conversation_id = NULL,
                    source_message_id = NULL,
                    provenance_state = 'tombstoned',
                    provenance_tombstoned_at = now(),
                    updated_at = now()
              WHERE id = $1
                AND owner_user_id = $2
                AND status <> 'deleted'
              RETURNING ${MEMORY_RETURNING}`,
            [memoryId, ownerUserId],
          );

          requireRow(updated);
          removedMemoryIds.push(memoryId);
        }

        await insertAudit(
          client,
          ownerUserId,
          memoryId,
          'source_delete',
          ownerUserId,
          note,
        );
      }

      return { retainedMemoryIds, removedMemoryIds };
    });
  }

  /**
   * Loads and locks one owner-scoped row. A missing, foreign, tombstoned
   * (`liveSql` only), or malformed id is the same not-found.
   */
  private async loadForUpdate(
    client: PoolClient,
    sql: string,
    memoryId: string,
    ownerUserId: string,
  ): Promise<MemoryRow> {
    return requireRow(
      await client.query<MemoryRow>(`${sql}\n    ${MEMORY_LOCK}`, [
        memoryId,
        ownerUserId,
      ]),
    );
  }
}
