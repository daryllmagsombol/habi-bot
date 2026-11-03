/**
 * H-028 (#28) owner-scoped SQL for artifacts and their immutable versions.
 *
 * Every statement binds the authenticated actor to `owner_user_id`. A foreign,
 * guessed, malformed, or tombstoned artifact id produces the same
 * non-enumerating `not_found`; there is no client-supplied owner field.
 *
 * Writes are transactional and append-only:
 *   - `create` inserts the artifact row and version 1 together;
 *   - `update` locks the artifact, appends `current_version + 1`, then moves the
 *     latest pointer; no earlier version row is touched;
 *   - `restoreVersion` copies one recorded version into a new appended version;
 *   - `delete` tombstones the artifact and keeps its history.
 *
 * The service verifies every returned body against its recorded SHA-256 and
 * byte length. Version bodies are never accepted from callers as already
 * hashed, and no value here becomes a filesystem path.
 */
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { withTransaction, type Queryable } from '../persistence/database.js';
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
import {
  encodeArtifactCursor,
  encodeArtifactVersionCursor,
} from './cursor.js';
import type {
  Artifact,
  ArtifactDetail,
  ArtifactKind,
  ArtifactPage,
  ArtifactStatus,
  ArtifactVersion,
  ArtifactVersionMetadata,
  ArtifactVersionPage,
  CreateArtifactRecord,
  UpdateArtifactRecord,
  WritableArtifactStatus,
} from './types.js';
import type {
  NormalizedListArtifactVersionsOptions,
  NormalizedListArtifactsOptions,
} from './validation.js';
import { hashArtifactContent, MAX_ARTIFACT_VERSION } from './validation.js';

interface ArtifactRow {
  id: string;
  owner_user_id: string;
  conversation_id: string | null;
  run_id: string | null;
  kind: string;
  title: string;
  current_version: number;
  status: string;
  created_at: Timestamp;
  updated_at: Timestamp;
  deleted_at: NullableTimestamp;
}

interface ArtifactListRow extends ArtifactRow {
  /** PostgreSQL's microsecond `updated_at` text, used for the keyset cursor. */
  updated_at_text: string;
}

interface ArtifactDetailRow extends ArtifactRow {
  version: number;
  content: string;
  content_sha256: string;
  byte_size: number;
  created_by: string;
  version_created_at: Timestamp;
}

interface ArtifactVersionRow {
  artifact_id: string;
  owner_user_id: string;
  version: number;
  content: string;
  content_sha256: string;
  byte_size: number;
  created_by: string;
  created_at: Timestamp;
}

interface ArtifactVersionMetadataRow {
  artifact_id: string;
  owner_user_id: string;
  version: number;
  content_sha256: string;
  byte_size: number;
  created_by: string;
  created_at: Timestamp;
}

const ARTIFACT_COLUMNS = `a.id, a.owner_user_id, a.conversation_id, a.run_id,
  a.kind, a.title, a.current_version, a.status, a.created_at, a.updated_at,
  a.deleted_at`;

const ARTIFACT_LIST_COLUMNS = `${ARTIFACT_COLUMNS},
  to_char(
    a.updated_at AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
  ) AS updated_at_text`;

const ARTIFACT_RETURNING = `id, owner_user_id, conversation_id, run_id, kind,
  title, current_version, status, created_at, updated_at, deleted_at`;

const VERSION_COLUMNS = `v.artifact_id, v.owner_user_id, v.version, v.content,
  v.content_sha256, v.byte_size, v.created_by, v.created_at`;

const VERSION_METADATA_COLUMNS = `v.artifact_id, v.owner_user_id, v.version,
  v.content_sha256, v.byte_size, v.created_by, v.created_at`;

const VERSION_RETURNING = `artifact_id, owner_user_id, version, content,
  content_sha256, byte_size, created_by, created_at`;

const ARTIFACT_LIVE_BY_ID = `SELECT ${ARTIFACT_COLUMNS}
   FROM artifacts a
  WHERE a.id = $1
    AND a.owner_user_id = $2
    AND a.deleted_at IS NULL`;

const ARTIFACT_ANY_BY_ID = `SELECT ${ARTIFACT_COLUMNS}
   FROM artifacts a
  WHERE a.id = $1
    AND a.owner_user_id = $2`;

const ARTIFACT_LOCK = 'FOR UPDATE OF a';

function toKind(value: string): ArtifactKind {
  if (value !== 'markdown' && value !== 'text' && value !== 'json') {
    throw new Error('Persisted artifact kind is unsupported.');
  }

  return value;
}

function toStatus(value: string): ArtifactStatus {
  if (value !== 'draft' && value !== 'final' && value !== 'deleted') {
    throw new Error('Persisted artifact has an unexpected status.');
  }

  return value;
}

function toWritableStatus(value: string): WritableArtifactStatus {
  if (value !== 'draft' && value !== 'final') {
    throw new Error('Persisted live artifact has a non-writable status.');
  }

  return value;
}

function toArtifact(row: ArtifactRow): Artifact {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    runId: row.run_id,
    kind: toKind(row.kind),
    title: row.title,
    currentVersion: row.current_version,
    status: toStatus(row.status),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    deletedAt: toNullableIso(row.deleted_at),
  };
}

function toVersion(row: ArtifactVersionRow): ArtifactVersion {
  return {
    artifactId: row.artifact_id,
    version: row.version,
    content: row.content,
    contentSha256: row.content_sha256,
    byteSize: row.byte_size,
    createdBy: row.created_by,
    createdAt: toIso(row.created_at),
  };
}

function toVersionMetadata(
  row: ArtifactVersionMetadataRow,
): ArtifactVersionMetadata {
  return {
    artifactId: row.artifact_id,
    version: row.version,
    contentSha256: row.content_sha256,
    byteSize: row.byte_size,
    createdBy: row.created_by,
    createdAt: toIso(row.created_at),
  };
}

function toDetail(row: ArtifactDetailRow): ArtifactDetail {
  return {
    artifact: toArtifact(row),
    version: {
      artifactId: row.id,
      version: row.version,
      content: row.content,
      contentSha256: row.content_sha256,
      byteSize: row.byte_size,
      createdBy: row.created_by,
      createdAt: toIso(row.version_created_at),
    },
  };
}

/**
 * Proves the requested conversation and run belong to the actor before the
 * insert. The composite foreign keys repeat the same rule in the database, but
 * this check turns a generic constraint violation into one not-found.
 */
async function assertCreateScope(
  queryable: Queryable,
  ownerUserId: string,
  conversationId: string | null,
  runId: string | null,
): Promise<void> {
  if (runId !== null) {
    if (conversationId === null) {
      throw new PersistenceValidationError('invalid_input');
    }

    const run = await queryable.query(
      `SELECT 1
         FROM runs r
         JOIN conversations c
           ON c.id = r.conversation_id
          AND c.owner_user_id = r.owner_user_id
        WHERE r.id = $1
          AND r.conversation_id = $2
          AND r.owner_user_id = $3
          AND c.deleted_at IS NULL`,
      [runId, conversationId, ownerUserId],
    );

    if (run.rows.length === 0) {
      throw new PersistenceNotFoundError();
    }

    return;
  }

  if (conversationId !== null) {
    const conversation = await queryable.query(
      `SELECT 1
         FROM conversations
        WHERE id = $1
          AND owner_user_id = $2
          AND deleted_at IS NULL`,
      [conversationId, ownerUserId],
    );

    if (conversation.rows.length === 0) {
      throw new PersistenceNotFoundError();
    }
  }
}

/** Appends exactly one version row and returns what was recorded. */
async function insertVersion(
  client: Queryable,
  artifactId: string,
  ownerUserId: string,
  version: number,
  content: string,
  contentSha256: string,
  byteSize: number,
  createdBy: string,
): Promise<ArtifactVersionRow> {
  return requireRow(
    await client.query<ArtifactVersionRow>(
      `INSERT INTO artifact_versions (
         artifact_id, owner_user_id, version, content, content_sha256,
         byte_size, created_by
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${VERSION_RETURNING}`,
      [
        artifactId,
        ownerUserId,
        version,
        content,
        contentSha256,
        byteSize,
        createdBy,
      ],
    ),
  );
}

export class ArtifactRepository {
  constructor(private readonly pool: Pool) {}

  /** Inserts an artifact and its first version in one transaction. */
  create(
    actorUserId: string,
    record: CreateArtifactRecord,
  ): Promise<ArtifactDetail> {
    const ownerUserId = requireActorUserId(actorUserId);
    const artifactId = randomUUID();
    const { contentSha256, byteSize } = hashArtifactContent(record.content);

    return withTransaction(this.pool, async (client) => {
      await assertCreateScope(
        client,
        ownerUserId,
        record.conversationId,
        record.runId,
      );

      const artifact = requireRow(
        await client.query<ArtifactRow>(
          `INSERT INTO artifacts (
             id, owner_user_id, conversation_id, run_id, kind, title,
             current_version, status
           )
           VALUES ($1, $2, $3, $4, $5, $6, 1, $7)
           RETURNING ${ARTIFACT_RETURNING}`,
          [
            artifactId,
            ownerUserId,
            record.conversationId,
            record.runId,
            record.kind,
            record.title,
            record.status,
          ],
        ),
      );

      const version = await insertVersion(
        client,
        artifactId,
        ownerUserId,
        1,
        record.content,
        contentSha256,
        byteSize,
        ownerUserId,
      );

      return { artifact: toArtifact(artifact), version: toVersion(version) };
    });
  }

  /**
   * Appends a new version and moves the latest pointer. The artifact row is
   * locked first so concurrent updates cannot choose the same version number.
   */
  update(
    actorUserId: string,
    artifactId: string,
    record: UpdateArtifactRecord,
  ): Promise<ArtifactDetail> {
    const ownerUserId = requireActorUserId(actorUserId);
    const id = requireResourceId(artifactId);
    const { contentSha256, byteSize } = hashArtifactContent(record.content);

    return withTransaction(this.pool, async (client) => {
      const current = await this.loadForUpdate(
        client,
        ARTIFACT_LIVE_BY_ID,
        id,
        ownerUserId,
      );
      const nextVersion = this.nextVersion(current.current_version);
      const nextTitle = record.title ?? current.title;
      const nextKind = record.kind ?? toKind(current.kind);
      const nextStatus =
        record.status ?? toWritableStatus(current.status);

      const version = await insertVersion(
        client,
        id,
        ownerUserId,
        nextVersion,
        record.content,
        contentSha256,
        byteSize,
        ownerUserId,
      );

      const updated = requireRow(
        await client.query<ArtifactRow>(
          `UPDATE artifacts
              SET title = $3,
                  kind = $4,
                  current_version = $5,
                  status = $6,
                  updated_at = now()
            WHERE id = $1
              AND owner_user_id = $2
              AND deleted_at IS NULL
            RETURNING ${ARTIFACT_RETURNING}`,
          [id, ownerUserId, nextTitle, nextKind, nextVersion, nextStatus],
        ),
      );

      return { artifact: toArtifact(updated), version: toVersion(version) };
    });
  }

  /** Reads the current version, or one exact historical version. */
  async get(
    actorUserId: string,
    artifactId: string,
    version: number | null,
  ): Promise<ArtifactDetail> {
    const ownerUserId = requireActorUserId(actorUserId);
    const id = requireResourceId(artifactId);
    const values: unknown[] = [id, ownerUserId];
    let versionPredicate = 'v.version = a.current_version';

    if (version !== null) {
      values.push(version);
      versionPredicate = `v.version = $${values.length}`;
    }

    const result = await this.pool.query<ArtifactDetailRow>(
      `SELECT ${ARTIFACT_COLUMNS},
              v.version,
              v.content,
              v.content_sha256,
              v.byte_size,
              v.created_by,
              v.created_at AS version_created_at
         FROM artifacts a
         JOIN artifact_versions v
           ON v.artifact_id = a.id
          AND v.owner_user_id = a.owner_user_id
          AND ${versionPredicate}
        WHERE a.id = $1
          AND a.owner_user_id = $2
          AND a.deleted_at IS NULL`,
      values,
    );

    return toDetail(requireRow(result));
  }

  /** One bounded page of owned artifacts, newest first, keyset paginated. */
  async list(
    actorUserId: string,
    options: NormalizedListArtifactsOptions,
  ): Promise<ArtifactPage> {
    const ownerUserId = requireActorUserId(actorUserId);
    const values: unknown[] = [ownerUserId];
    const conditions = ['a.owner_user_id = $1', 'a.deleted_at IS NULL'];

    if (options.conversationId !== null) {
      values.push(options.conversationId);
      conditions.push(`a.conversation_id = $${values.length}`);
    }

    if (options.cursor !== null) {
      values.push(options.cursor.updatedAt);
      const updatedAtParameter = `$${values.length}::timestamptz`;
      values.push(options.cursor.id);

      conditions.push(
        `(a.updated_at, a.id) < (${updatedAtParameter}, $${values.length}::uuid)`,
      );
    }

    values.push(options.limit + 1);

    const result = await this.pool.query<ArtifactListRow>(
      `SELECT ${ARTIFACT_LIST_COLUMNS}
         FROM artifacts a
        WHERE ${conditions.join('\n          AND ')}
        ORDER BY a.updated_at DESC, a.id DESC
        LIMIT $${values.length}`,
      values,
    );

    const hasMore = result.rows.length > options.limit;
    const rows = hasMore ? result.rows.slice(0, options.limit) : result.rows;
    const last = rows[rows.length - 1];

    return {
      artifacts: rows.map(toArtifact),
      nextCursor:
        hasMore && last !== undefined
          ? encodeArtifactCursor({
              updatedAt: last.updated_at_text,
              id: last.id,
              conversationId: options.conversationId,
            })
          : null,
    };
  }

  /**
   * Owner-scoped version metadata, newest first, without selecting the body.
   * A tombstoned or foreign artifact is the same not-found as a missing one.
   */
  async listVersions(
    actorUserId: string,
    artifactId: string,
    options: NormalizedListArtifactVersionsOptions,
  ): Promise<ArtifactVersionPage> {
    const ownerUserId = requireActorUserId(actorUserId);
    const id = requireResourceId(artifactId);

    await this.requireLiveArtifact(id, ownerUserId);

    const values: unknown[] = [id, ownerUserId];
    const conditions = ['v.artifact_id = $1', 'v.owner_user_id = $2'];

    if (options.beforeVersion !== null) {
      values.push(options.beforeVersion);
      conditions.push(`v.version < $${values.length}`);
    }

    values.push(options.limit + 1);

    const result = await this.pool.query<ArtifactVersionMetadataRow>(
      `SELECT ${VERSION_METADATA_COLUMNS}
         FROM artifact_versions v
        WHERE ${conditions.join('\n          AND ')}
        ORDER BY v.version DESC
        LIMIT $${values.length}`,
      values,
    );

    const hasMore = result.rows.length > options.limit;
    const rows = hasMore ? result.rows.slice(0, options.limit) : result.rows;
    const last = rows[rows.length - 1];

    return {
      versions: rows.map(toVersionMetadata),
      nextCursor:
        hasMore && last !== undefined
          ? encodeArtifactVersionCursor(last.version)
          : null,
    };
  }

  /**
   * Explicit tombstone. Idempotent for the owner: a repeated delete returns the
   * stored tombstone without a second write. Foreign and guessed ids are not
   * found, so they cannot be used to confirm existence.
   */
  delete(actorUserId: string, artifactId: string): Promise<Artifact> {
    const ownerUserId = requireActorUserId(actorUserId);
    const id = requireResourceId(artifactId);

    return withTransaction(this.pool, async (client) => {
      const current = await this.loadForUpdate(
        client,
        ARTIFACT_ANY_BY_ID,
        id,
        ownerUserId,
      );

      if (current.status === 'deleted') {
        return toArtifact(current);
      }

      const updated = requireRow(
        await client.query<ArtifactRow>(
          `UPDATE artifacts
              SET status = 'deleted',
                  deleted_at = now(),
                  updated_at = now()
            WHERE id = $1
              AND owner_user_id = $2
              AND status <> 'deleted'
            RETURNING ${ARTIFACT_RETURNING}`,
          [id, ownerUserId],
        ),
      );

      return toArtifact(updated);
    });
  }

  /**
   * Appends a copy of a recorded version as the new latest. The source row is
   * read, never updated, so stale references keep resolving to their own body.
   */
  restoreVersion(
    actorUserId: string,
    artifactId: string,
    sourceVersion: number,
  ): Promise<ArtifactDetail> {
    const ownerUserId = requireActorUserId(actorUserId);
    const id = requireResourceId(artifactId);

    return withTransaction(this.pool, async (client) => {
      const current = await this.loadForUpdate(
        client,
        ARTIFACT_LIVE_BY_ID,
        id,
        ownerUserId,
      );
      const source = requireRow(
        await client.query<ArtifactVersionRow>(
          `SELECT ${VERSION_COLUMNS}
             FROM artifact_versions v
            WHERE v.artifact_id = $1
              AND v.owner_user_id = $2
              AND v.version = $3`,
          [id, ownerUserId, sourceVersion],
        ),
      );
      const nextVersion = this.nextVersion(current.current_version);

      const copy = await insertVersion(
        client,
        id,
        ownerUserId,
        nextVersion,
        source.content,
        source.content_sha256,
        source.byte_size,
        ownerUserId,
      );

      const updated = requireRow(
        await client.query<ArtifactRow>(
          `UPDATE artifacts
              SET current_version = $3,
                  updated_at = now()
            WHERE id = $1
              AND owner_user_id = $2
              AND deleted_at IS NULL
            RETURNING ${ARTIFACT_RETURNING}`,
          [id, ownerUserId, nextVersion],
        ),
      );

      return { artifact: toArtifact(updated), version: toVersion(copy) };
    });
  }

  /** Advances the latest pointer by exactly one, bounded by int4. */
  private nextVersion(current: number): number {
    const next = current + 1;

    if (!Number.isSafeInteger(next) || next > MAX_ARTIFACT_VERSION) {
      throw new PersistenceValidationError('invalid_input');
    }

    return next;
  }

  /** Proves an owned live artifact exists before listing its versions. */
  private async requireLiveArtifact(
    artifactId: string,
    ownerUserId: string,
  ): Promise<void> {
    const result = await this.pool.query(
      `SELECT 1
         FROM artifacts a
        WHERE a.id = $1
          AND a.owner_user_id = $2
          AND a.deleted_at IS NULL`,
      [artifactId, ownerUserId],
    );

    if (result.rows.length === 0) {
      throw new PersistenceNotFoundError();
    }
  }

  /** Loads and locks one owner-scoped artifact row. */
  private async loadForUpdate(
    client: Queryable,
    sql: string,
    artifactId: string,
    ownerUserId: string,
  ): Promise<ArtifactRow> {
    return requireRow(
      await client.query<ArtifactRow>(`${sql}\n    ${ARTIFACT_LOCK}`, [
        artifactId,
        ownerUserId,
      ]),
    );
  }
}
