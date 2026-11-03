import type { Pool } from 'pg';
import type { Queryable } from '../persistence/database.js';
import { withTransaction } from '../persistence/database.js';
import {
  PersistenceConflictError,
  PersistenceNotFoundError,
  PersistenceValidationError,
} from '../persistence/errors.js';
import { normalizeLimit } from '../persistence/pagination.js';
import { requireActorUserId, requireResourceId } from '../persistence/rows.js';
import { decodeBotCursor, encodeBotCursor } from './cursor.js';
import { normalizeCreateBotInput, normalizeUpdateBotInput } from './validation.js';
import type {
  BotPage,
  BotProfile,
  CreateBotInput,
  ListBotsOptions,
  UpdateBotInput,
} from './types.js';

type Timestamp = Date | string;
type NullableTimestamp = Timestamp | null;

interface BotRow {
  id: string;
  name: string;
  description: string;
  avatar_ref: string | null;
  instructions_markdown: string;
  status: string;
  archived_at: NullableTimestamp;
  created_at: Timestamp;
  updated_at: Timestamp;
  /** Present only on list rows; preserves PostgreSQL microseconds for cursors. */
  updated_at_text?: string;
}

const BOT_COLUMNS = `id, name, description, avatar_ref, instructions_markdown,
  status, archived_at, created_at, updated_at`;

const BOT_BY_ID = `SELECT ${BOT_COLUMNS}
   FROM bots
  WHERE id = $1
    AND owner_user_id = $2
    AND deleted_at IS NULL`;

const BOT_BY_ID_FOR_UPDATE = `${BOT_BY_ID} FOR UPDATE`;

function toIso(value: Timestamp): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toNullableIso(value: NullableTimestamp): string | null {
  return value === null ? null : toIso(value);
}

function toBotProfile(row: BotRow): BotProfile {
  if (row.status !== 'active' && row.status !== 'archived') {
    throw new Error('Owned Bot row has an unexpected lifecycle status.');
  }

  return {
    id: row.id,
    name: row.name,
    description: row.description,
    avatarRef: row.avatar_ref,
    instructionsMarkdown: row.instructions_markdown,
    status: row.status,
    archivedAt: toNullableIso(row.archived_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

/**
 * Loads a Bot through the owner predicate itself. Missing, foreign, and
 * tombstoned rows all produce the same not-found error.
 */
async function loadOwnedBot(
  queryable: Queryable,
  actorUserId: string,
  botId: string,
  forUpdate = false,
): Promise<BotRow> {
  const ownerUserId = requireActorUserId(actorUserId);
  const ownedBotId = requireResourceId(botId);

  const result = await queryable.query<BotRow>(
    forUpdate ? BOT_BY_ID_FOR_UPDATE : BOT_BY_ID,
    [ownedBotId, ownerUserId],
  );

  const row = result.rows[0];
  if (row === undefined) {
    throw new PersistenceNotFoundError();
  }

  return row;
}

/**
 * Owner-scoped Bot profile persistence. Every statement binds the actor to
 * `owner_user_id` in the query itself; no client-supplied owner field exists.
 * Foreign, unknown, and deleted ids are indistinguishable from not found.
 */
export class BotRepository {
  constructor(private readonly pool: Pool) {}

  /** Creates an active Bot owned by the actor. */
  async create(actorUserId: string, input: CreateBotInput): Promise<BotProfile> {
    const ownerUserId = requireActorUserId(actorUserId);
    const record = normalizeCreateBotInput(input);

    const result = await this.pool.query<BotRow>(
      `INSERT INTO bots (
         owner_user_id,
         name,
         description,
         avatar_ref,
         instructions_markdown
       )
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${BOT_COLUMNS}`,
      [
        ownerUserId,
        record.name,
        record.description,
        record.avatarRef,
        record.instructionsMarkdown,
      ],
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error('Bot insert returned no row.');
    }

    return toBotProfile(row);
  }

  /** Reads one active or archived Bot owned by the actor. */
  async get(actorUserId: string, botId: string): Promise<BotProfile> {
    return toBotProfile(await loadOwnedBot(this.pool, actorUserId, botId));
  }

  /** Lists the actor's active and archived Bots, newest updated first. */
  async list(
    actorUserId: string,
    options: ListBotsOptions = {},
  ): Promise<BotPage> {
    const ownerUserId = requireActorUserId(actorUserId);
    const status = options.status ?? null;

    if (status !== null && status !== 'active' && status !== 'archived') {
      throw new PersistenceValidationError('invalid_input');
    }

    const limit = normalizeLimit(options.limit);
    const cursor =
      options.cursor === undefined ? null : decodeBotCursor(options.cursor);

    const result = await this.pool.query<BotRow>(
      `SELECT ${BOT_COLUMNS}, updated_at::text AS updated_at_text
         FROM bots
        WHERE owner_user_id = $1
          AND deleted_at IS NULL
          AND ($2::text IS NULL OR status = $2)
          AND (
            $3::timestamptz IS NULL
            OR (updated_at, id) < ($3::timestamptz, $4::uuid)
          )
        ORDER BY updated_at DESC, id DESC
        LIMIT $5`,
      [ownerUserId, status, cursor?.updatedAt ?? null, cursor?.id ?? null, limit + 1],
    );

    const hasMore = result.rows.length > limit;
    const rows = hasMore ? result.rows.slice(0, limit) : result.rows;
    const last = rows[rows.length - 1];

    return {
      bots: rows.map(toBotProfile),
      nextCursor:
        hasMore && last !== undefined
          ? encodeBotCursor({
              updatedAt: last.updated_at_text ?? toIso(last.updated_at),
              id: last.id,
            })
          : null,
    };
  }

  /**
   * Applies a patch to a Bot the actor owns. Omitted fields are unchanged.
   * An archived Bot stays readable but is read-only (D1), so this reports
   * `bot_unavailable` only after ownership has been proven.
   */
  async update(
    actorUserId: string,
    botId: string,
    input: UpdateBotInput,
  ): Promise<BotProfile> {
    const ownerUserId = requireActorUserId(actorUserId);
    const ownedBotId = requireResourceId(botId);
    const patch = normalizeUpdateBotInput(input);

    return withTransaction(this.pool, async (client) => {
      const current = await loadOwnedBot(client, ownerUserId, ownedBotId, true);

      if (current.status !== 'active') {
        throw new PersistenceConflictError('bot_unavailable');
      }

      const result = await client.query<BotRow>(
        `UPDATE bots
            SET name = $3,
                description = $4,
                avatar_ref = $5,
                instructions_markdown = $6,
                updated_at = now()
          WHERE id = $1
            AND owner_user_id = $2
            AND deleted_at IS NULL
            AND status = 'active'
          RETURNING ${BOT_COLUMNS}`,
        [
          ownedBotId,
          ownerUserId,
          patch.name ?? current.name,
          patch.description ?? current.description,
          patch.avatarRef === undefined ? current.avatar_ref : patch.avatarRef,
          patch.instructionsMarkdown ?? current.instructions_markdown,
        ],
      );

      const row = result.rows[0];
      if (row === undefined) {
        // The row lock above makes this unreachable unless the row was
        // concurrently tombstoned outside this owner predicate.
        throw new PersistenceNotFoundError();
      }

      return toBotProfile(row);
    });
  }

  /**
   * Archives a Bot. Repeat calls are idempotent and preserve the original
   * `archived_at`/`updated_at`. History remains readable; D1 blocks new runs
   * elsewhere. Foreign, unknown, and deleted ids are not found.
   */
  async archive(actorUserId: string, botId: string): Promise<BotProfile> {
    const ownerUserId = requireActorUserId(actorUserId);
    const ownedBotId = requireResourceId(botId);

    const result = await this.pool.query<BotRow>(
      `UPDATE bots
          SET status = 'archived',
              archived_at = COALESCE(archived_at, now()),
              updated_at = CASE
                WHEN status = 'archived' THEN updated_at
                ELSE now()
              END
        WHERE id = $1
          AND owner_user_id = $2
          AND deleted_at IS NULL
        RETURNING ${BOT_COLUMNS}`,
      [ownedBotId, ownerUserId],
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new PersistenceNotFoundError();
    }

    return toBotProfile(row);
  }
}
