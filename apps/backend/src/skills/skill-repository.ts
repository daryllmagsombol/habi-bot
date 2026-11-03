/**
 * H-031 (#31) owner-scoped SQL for skills and their immutable version history.
 *
 * Every statement binds the authenticated actor to `owner_user_id`. A foreign,
 * guessed, malformed, or tombstoned identifier produces the same
 * non-enumerating `not_found`; there is no client-supplied owner field.
 *
 * Lifecycle rules enforced here:
 *   - update/attach/detach require a live draft or active skill;
 *   - an archived skill stays readable but is read-only;
 *   - delete tombstones and is idempotent for its owner;
 *   - an archived/deleted Bot cannot receive an attachment.
 *
 * Version history is append-only: `insertVersion` is the only write, and the
 * migration trigger rejects UPDATE/DELETE on `skill_versions`.
 */
import type { Pool, PoolClient } from 'pg';
import { withTransaction } from '../persistence/database.js';
import type { Queryable } from '../persistence/database.js';
import {
  PersistenceConflictError,
  PersistenceNotFoundError,
  isUniqueViolation,
  uniqueViolationConstraint,
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
import { encodeSkillCursor } from './cursor.js';
import {
  SkillNameConflictError,
  SkillUnavailableError,
  SkillVersionConflictError,
} from './errors.js';
import type {
  CreateSkillInput,
  ListSkillVersionsOptions,
  ListSkillsOptions,
  Skill,
  SkillPage,
  SkillStatus,
  SkillVersion,
  SkillVersionPage,
  UpdateSkillInput,
} from './types.js';
import {
  normalizeCreateSkillInput,
  normalizeListSkillVersionsOptions,
  normalizeListSkillsOptions,
  normalizeUpdateSkillInput,
} from './validation.js';

interface SkillRow {
  id: string;
  bot_id: string | null;
  name: string;
  description: string;
  body_markdown: string;
  version: number;
  status: string;
  archived_at: NullableTimestamp;
  created_at: Timestamp;
  updated_at: Timestamp;
  deleted_at: NullableTimestamp;
  /** Present only on list rows; preserves PostgreSQL microseconds for cursors. */
  updated_at_text?: string;
}

interface SkillVersionRow {
  skill_id: string;
  version: number;
  name: string;
  description: string;
  body_markdown: string;
  created_at: Timestamp;
}

interface BotStateRow {
  status: string;
}

const SKILL_COLUMNS = `id, bot_id, name, description, body_markdown, version,
  status, archived_at, created_at, updated_at, deleted_at`;

/** Owner-scoped live row. A tombstone is visible only to `delete`. */
const SKILL_BY_ID_LIVE = `SELECT ${SKILL_COLUMNS}
   FROM skills
  WHERE id = $1
    AND owner_user_id = $2
    AND deleted_at IS NULL`;

/** Owner-scoped row including a tombstone; still never a foreign row. */
const SKILL_BY_ID_ANY = `SELECT ${SKILL_COLUMNS}
   FROM skills
  WHERE id = $1
    AND owner_user_id = $2`;

const SKILL_VERSION_COLUMNS = `v.skill_id, v.version, v.name, v.description,
  v.body_markdown, v.created_at`;

/** Both statuses are editable and attachable; archived/deleted are not. */
const LIVE_STATUSES = `('draft', 'active')`;

function toStatus(value: string): SkillStatus {
  if (
    value !== 'draft' &&
    value !== 'active' &&
    value !== 'archived' &&
    value !== 'deleted'
  ) {
    throw new Error('Persisted skill has an unexpected lifecycle status.');
  }

  return value;
}

function toSkill(row: SkillRow): Skill {
  return {
    id: row.id,
    botId: row.bot_id,
    name: row.name,
    description: row.description,
    bodyMarkdown: row.body_markdown,
    version: row.version,
    status: toStatus(row.status),
    archivedAt: toNullableIso(row.archived_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    deletedAt: toNullableIso(row.deleted_at),
  };
}

function toSkillVersion(row: SkillVersionRow): SkillVersion {
  return {
    skillId: row.skill_id,
    version: row.version,
    name: row.name,
    description: row.description,
    bodyMarkdown: row.body_markdown,
    createdAt: toIso(row.created_at),
  };
}

/**
 * Maps a unique violation to the owner-visible conflict it represents. Any
 * other error is returned unchanged and rethrown by the caller.
 */
function toSkillConflict(error: unknown): unknown {
  if (isUniqueViolation(error)) {
    const constraint = uniqueViolationConstraint(error);

    if (
      constraint === 'skills_owner_name_live_key' ||
      constraint === 'skills_owner_bot_name_live_key'
    ) {
      return new SkillNameConflictError();
    }

    // Defensive: the row lock serializes updates, but a future caller that
    // bypasses it must still see a conflict instead of a raw driver error.
    if (constraint === 'skill_versions_skill_version_key') {
      return new SkillVersionConflictError();
    }
  }

  return error;
}

/** Appends one immutable version snapshot. This is the only history write. */
async function insertVersion(
  client: Queryable,
  ownerUserId: string,
  skill: Pick<Skill, 'id' | 'version' | 'name' | 'description' | 'bodyMarkdown'>,
): Promise<void> {
  await client.query(
    `INSERT INTO skill_versions (
       skill_id, owner_user_id, version, name, description, body_markdown
     )
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      skill.id,
      ownerUserId,
      skill.version,
      skill.name,
      skill.description,
      skill.bodyMarkdown,
    ],
  );
}

/**
 * Loads and locks one owner-scoped skill. A missing, foreign, tombstoned, or
 * malformed id is the same not-found.
 */
async function loadForUpdate(
  client: PoolClient,
  ownerUserId: string,
  skillId: string,
): Promise<SkillRow> {
  return requireRow(
    await client.query<SkillRow>(`${SKILL_BY_ID_LIVE} FOR UPDATE`, [
      skillId,
      ownerUserId,
    ]),
  );
}

/**
 * Proves the target Bot exists, is live, is owned by the actor, and is active.
 * Deleted/missing/foreign Bots collapse to not-found; an archived Bot is an
 * owned but unavailable target.
 */
async function requireAttachableBot(
  client: Queryable,
  ownerUserId: string,
  botId: string,
): Promise<void> {
  const result = await client.query<BotStateRow>(
    `SELECT status
       FROM bots
      WHERE id = $1
        AND owner_user_id = $2
        AND deleted_at IS NULL`,
    [botId, ownerUserId],
  );

  const row = result.rows[0];
  if (row === undefined) {
    throw new PersistenceNotFoundError();
  }

  if (row.status !== 'active') {
    throw new PersistenceConflictError('bot_unavailable');
  }
}

function requireEditable(skill: SkillRow): void {
  if (skill.status !== 'draft' && skill.status !== 'active') {
    throw new SkillUnavailableError();
  }
}

export class SkillRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * Creates a skill and its version-1 snapshot in one transaction. A Bot
   * attachment is accepted only when that Bot is live, owned, and active.
   */
  async create(actorUserId: string, input: CreateSkillInput): Promise<Skill> {
    const ownerUserId = requireActorUserId(actorUserId);
    const record = normalizeCreateSkillInput(input);

    try {
      return await withTransaction(this.pool, async (client) => {
        if (record.botId !== null) {
          await requireAttachableBot(client, ownerUserId, record.botId);
        }

        const result = await client.query<SkillRow>(
          `INSERT INTO skills (
             owner_user_id, bot_id, name, description, body_markdown, version,
             status
           )
           VALUES ($1, $2, $3, $4, $5, 1, $6)
           RETURNING ${SKILL_COLUMNS}`,
          [
            ownerUserId,
            record.botId,
            record.name,
            record.description,
            record.bodyMarkdown,
            record.status,
          ],
        );

        const skill = toSkill(requireRow(result));
        await insertVersion(client, ownerUserId, {
          id: skill.id,
          version: 1,
          name: skill.name,
          description: skill.description,
          bodyMarkdown: skill.bodyMarkdown,
        });

        return skill;
      });
    } catch (error) {
      throw toSkillConflict(error);
    }
  }

  /** Reads one live (draft/active/archived) skill owned by the actor. */
  async get(actorUserId: string, skillId: string): Promise<Skill> {
    const ownerUserId = requireActorUserId(actorUserId);
    const id = requireResourceId(skillId);

    return toSkill(
      requireRow(
        await this.pool.query<SkillRow>(SKILL_BY_ID_LIVE, [id, ownerUserId]),
      ),
    );
  }

  /**
   * Lists the actor's live skills, newest updated first, keyset paginated.
   * Tombstones only appear when the caller explicitly filters `deleted`.
   */
  async list(
    actorUserId: string,
    options: ListSkillsOptions = {},
  ): Promise<SkillPage> {
    const ownerUserId = requireActorUserId(actorUserId);
    const normalized = normalizeListSkillsOptions(options);

    const values: unknown[] = [ownerUserId];
    const conditions = ['owner_user_id = $1'];

    if (normalized.status === null) {
      conditions.push('deleted_at IS NULL');
    } else if (normalized.status === 'deleted') {
      conditions.push("status = 'deleted'");
    } else {
      values.push(normalized.status);
      conditions.push(`status = $${values.length}`);
      conditions.push('deleted_at IS NULL');
    }

    if (normalized.botId === null) {
      conditions.push('bot_id IS NULL');
    } else if (normalized.botId !== undefined) {
      values.push(normalized.botId);
      conditions.push(`bot_id = $${values.length}`);
    }

    if (normalized.cursor !== null) {
      values.push(normalized.cursor.updatedAt);
      const timestampParameter = values.length;
      values.push(normalized.cursor.id);
      const idParameter = values.length;

      conditions.push(
        `(updated_at, id) < ($${timestampParameter}::timestamptz, $${idParameter}::uuid)`,
      );
    }

    values.push(normalized.limit + 1);

    const result = await this.pool.query<SkillRow>(
      `SELECT ${SKILL_COLUMNS}, updated_at::text AS updated_at_text
         FROM skills
        WHERE ${conditions.join('\n          AND ')}
        ORDER BY updated_at DESC, id DESC
        LIMIT $${values.length}`,
      values,
    );

    const hasMore = result.rows.length > normalized.limit;
    const rows = hasMore ? result.rows.slice(0, normalized.limit) : result.rows;
    const last = rows.at(-1);

    return {
      skills: rows.map(toSkill),
      nextCursor:
        hasMore && last !== undefined
          ? encodeSkillCursor({
              updatedAt: last.updated_at_text ?? toIso(last.updated_at),
              id: last.id,
            })
          : null,
    };
  }

  /**
   * Applies a patch as a new immutable version. An archived or deleted skill
   * is visible to its owner but not editable.
   */
  async update(
    actorUserId: string,
    skillId: string,
    input: UpdateSkillInput,
  ): Promise<Skill> {
    const ownerUserId = requireActorUserId(actorUserId);
    const id = requireResourceId(skillId);
    const patch = normalizeUpdateSkillInput(input);

    try {
      return await withTransaction(this.pool, async (client) => {
        const current = await loadForUpdate(client, ownerUserId, id);
        requireEditable(current);

        const nextVersion = current.version + 1;

        await insertVersion(client, ownerUserId, {
          id: current.id,
          version: nextVersion,
          name: patch.name ?? current.name,
          description: patch.description ?? current.description,
          bodyMarkdown: patch.bodyMarkdown ?? current.body_markdown,
        });

        const result = await client.query<SkillRow>(
          `UPDATE skills
              SET name = $3,
                  description = $4,
                  body_markdown = $5,
                  version = $6,
                  updated_at = now()
            WHERE id = $1
              AND owner_user_id = $2
              AND deleted_at IS NULL
              AND status IN ${LIVE_STATUSES}
            RETURNING ${SKILL_COLUMNS}`,
          [
            id,
            ownerUserId,
            patch.name ?? current.name,
            patch.description ?? current.description,
            patch.bodyMarkdown ?? current.body_markdown,
            nextVersion,
          ],
        );

        return toSkill(requireRow(result));
      });
    } catch (error) {
      throw toSkillConflict(error);
    }
  }

  /**
   * Archives a live skill. Repeat calls are idempotent and preserve the
   * original `archived_at`/`updated_at`. History stays readable.
   */
  async archive(actorUserId: string, skillId: string): Promise<Skill> {
    const ownerUserId = requireActorUserId(actorUserId);
    const id = requireResourceId(skillId);

    const result = await this.pool.query<SkillRow>(
      `UPDATE skills
          SET status = 'archived',
              archived_at = COALESCE(archived_at, now()),
              updated_at = CASE
                WHEN status = 'archived' THEN updated_at
                ELSE now()
              END
        WHERE id = $1
          AND owner_user_id = $2
          AND deleted_at IS NULL
        RETURNING ${SKILL_COLUMNS}`,
      [id, ownerUserId],
    );

    return toSkill(requireRow(result));
  }

  /**
   * Tombstones a skill. Repeat calls are idempotent and return the stored
   * tombstone without changing timestamps. History is retained.
   */
  async delete(actorUserId: string, skillId: string): Promise<Skill> {
    const ownerUserId = requireActorUserId(actorUserId);
    const id = requireResourceId(skillId);

    return withTransaction(this.pool, async (client) => {
      const current = requireRow(
        await client.query<SkillRow>(`${SKILL_BY_ID_ANY} FOR UPDATE`, [
          id,
          ownerUserId,
        ]),
      );

      if (current.status === 'deleted') {
        return toSkill(current);
      }

      const result = await client.query<SkillRow>(
        `UPDATE skills
            SET status = 'deleted',
                archived_at = NULL,
                deleted_at = now(),
                updated_at = now()
          WHERE id = $1
            AND owner_user_id = $2
            AND status <> 'deleted'
          RETURNING ${SKILL_COLUMNS}`,
        [id, ownerUserId],
      );

      return toSkill(requireRow(result));
    });
  }

  /**
   * Attaches a live skill to an active owned Bot. Repeating the same
   * attachment is a no-op; moving to another Bot replaces `bot_id`.
   */
  async attach(
    actorUserId: string,
    skillId: string,
    botId: string,
  ): Promise<Skill> {
    const ownerUserId = requireActorUserId(actorUserId);
    const id = requireResourceId(skillId);
    const targetBotId = requireResourceId(botId);

    try {
      return await withTransaction(this.pool, async (client) => {
        const current = await loadForUpdate(client, ownerUserId, id);
        requireEditable(current);

        // Check the Bot before the idempotent early return: an archived or
        // deleted Bot is not a valid attachment target even if the skill is
        // already attached to it.
        await requireAttachableBot(client, ownerUserId, targetBotId);

        if (current.bot_id === targetBotId) {
          return toSkill(current);
        }

        const result = await client.query<SkillRow>(
          `UPDATE skills
              SET bot_id = $3,
                  updated_at = now()
            WHERE id = $1
              AND owner_user_id = $2
              AND deleted_at IS NULL
              AND status IN ${LIVE_STATUSES}
            RETURNING ${SKILL_COLUMNS}`,
          [id, ownerUserId, targetBotId],
        );

        return toSkill(requireRow(result));
      });
    } catch (error) {
      throw toSkillConflict(error);
    }
  }

  /**
   * Detaches a live skill from its Bot. Repeating a detach is a no-op.
   * Archived/deleted skills are read-only and cannot be detached.
   */
  async detach(actorUserId: string, skillId: string): Promise<Skill> {
    const ownerUserId = requireActorUserId(actorUserId);
    const id = requireResourceId(skillId);

    return withTransaction(this.pool, async (client) => {
      const current = await loadForUpdate(client, ownerUserId, id);
      requireEditable(current);

      if (current.bot_id === null) {
        return toSkill(current);
      }

      const result = await client.query<SkillRow>(
        `UPDATE skills
            SET bot_id = NULL,
                updated_at = now()
          WHERE id = $1
            AND owner_user_id = $2
            AND deleted_at IS NULL
            AND status IN ${LIVE_STATUSES}
          RETURNING ${SKILL_COLUMNS}`,
        [id, ownerUserId],
      );

      return toSkill(requireRow(result));
    });
  }

  /**
   * Owner-scoped immutable version history, newest first. Archived skills keep
   * their history readable; tombstones do not resolve here.
   */
  async listVersions(
    actorUserId: string,
    skillId: string,
    options: ListSkillVersionsOptions = {},
  ): Promise<SkillVersionPage> {
    const ownerUserId = requireActorUserId(actorUserId);
    const id = requireResourceId(skillId);
    const normalized = normalizeListSkillVersionsOptions(options);

    requireRow(
      await this.pool.query<SkillRow>(
        `SELECT id FROM skills
          WHERE id = $1
            AND owner_user_id = $2
            AND deleted_at IS NULL`,
        [id, ownerUserId],
      ),
    );

    const values: unknown[] = [id, ownerUserId];
    let versionFilter = '';

    if (normalized.beforeVersion !== null) {
      values.push(normalized.beforeVersion);
      versionFilter = `\n          AND v.version < $${values.length}`;
    }

    values.push(normalized.limit + 1);

    const result = await this.pool.query<SkillVersionRow>(
      `SELECT ${SKILL_VERSION_COLUMNS}
         FROM skill_versions v
         JOIN skills s
           ON s.id = v.skill_id
          AND s.owner_user_id = v.owner_user_id
        WHERE v.skill_id = $1
          AND v.owner_user_id = $2
          AND s.deleted_at IS NULL${versionFilter}
        ORDER BY v.version DESC
        LIMIT $${values.length}`,
      values,
    );

    const hasMore = result.rows.length > normalized.limit;
    const rows = hasMore
      ? result.rows.slice(0, normalized.limit)
      : result.rows;
    const last = rows.at(-1);

    return {
      versions: rows.map(toSkillVersion),
      nextBeforeVersion: hasMore && last !== undefined ? last.version : null,
    };
  }

  /** Reads one immutable version of an owned live skill. */
  async getVersion(
    actorUserId: string,
    skillId: string,
    version: number,
  ): Promise<SkillVersion> {
    const ownerUserId = requireActorUserId(actorUserId);
    const id = requireResourceId(skillId);

    return toSkillVersion(
      requireRow(
        await this.pool.query<SkillVersionRow>(
          `SELECT ${SKILL_VERSION_COLUMNS}
             FROM skill_versions v
             JOIN skills s
               ON s.id = v.skill_id
              AND s.owner_user_id = v.owner_user_id
            WHERE v.skill_id = $1
              AND v.owner_user_id = $2
              AND v.version = $3
              AND s.deleted_at IS NULL`,
          [id, ownerUserId, version],
        ),
      ),
    );
  }
}
