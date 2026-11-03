/**
 * Owner-scoped SQL for attachments.
 *
 * Every statement binds the actor to `owner_user_id` and requires the owning
 * conversation to be live, so a foreign, guessed, malformed, or tombstoned
 * identifier produces the same `not_found` result. There is no client-supplied
 * owner field and no lookup that starts from `storage_key`.
 */
import type { Pool } from 'pg';
import { withTransaction } from '../persistence/database.js';
import type { Queryable } from '../persistence/database.js';
import {
  PersistenceNotFoundError,
  PersistenceValidationError,
} from '../persistence/errors.js';
import { isUuid } from '../persistence/cursor.js';
import { MAX_PAGE_SIZE, normalizeLimit } from '../persistence/pagination.js';
import { requireActorUserId, requireResourceId } from '../persistence/rows.js';
import type {
  AttachmentRecord,
  AttachmentStatus,
  ListAttachmentsOptions,
} from './types.js';

type Timestamp = Date | string;
type NullableTimestamp = Timestamp | null;

interface AttachmentRow {
  id: string;
  owner_user_id: string;
  conversation_id: string;
  message_id: string | null;
  original_filename: string;
  content_type: string;
  byte_size: string | number;
  sha256: string;
  storage_key: string;
  status: string;
  created_at: Timestamp;
  stored_at: NullableTimestamp;
  deleted_at: NullableTimestamp;
}

const ATTACHMENT_COLUMNS = `a.id, a.owner_user_id, a.conversation_id,
  a.message_id, a.original_filename, a.content_type, a.byte_size, a.sha256,
  a.storage_key, a.status, a.created_at, a.stored_at, a.deleted_at`;

const ATTACHMENT_RETURNING = `id, owner_user_id, conversation_id, message_id,
  original_filename, content_type, byte_size, sha256, storage_key, status,
  created_at, stored_at, deleted_at`;

const LIVE_SCOPE = `a.owner_user_id = $2
   AND c.deleted_at IS NULL`;

const ATTACHMENT_BY_ID = `SELECT ${ATTACHMENT_COLUMNS}
   FROM attachments a
   JOIN conversations c
     ON c.id = a.conversation_id
    AND c.owner_user_id = a.owner_user_id
  WHERE a.id = $1
    AND ${LIVE_SCOPE}
    AND a.deleted_at IS NULL`;

const ATTACHMENT_BY_ID_INCLUDING_DELETED = `SELECT ${ATTACHMENT_COLUMNS}
   FROM attachments a
   JOIN conversations c
     ON c.id = a.conversation_id
    AND c.owner_user_id = a.owner_user_id
  WHERE a.id = $1
    AND ${LIVE_SCOPE}`;

function toIso(value: Timestamp): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toNullableIso(value: NullableTimestamp): string | null {
  return value === null ? null : toIso(value);
}

function toByteSize(value: string | number): number {
  const byteSize = typeof value === 'number' ? value : Number(value);

  if (!Number.isSafeInteger(byteSize) || byteSize < 0) {
    throw new TypeError('Persisted attachment size is outside the supported range.');
  }

  return byteSize;
}

function toStatus(value: string): AttachmentStatus {
  if (
    value !== 'pending' &&
    value !== 'stored' &&
    value !== 'rejected' &&
    value !== 'deleted'
  ) {
    throw new Error('Persisted attachment has an unexpected lifecycle status.');
  }

  return value;
}

function toAttachmentRecord(row: AttachmentRow): AttachmentRecord {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    originalFilename: row.original_filename,
    contentType: row.content_type,
    byteSize: toByteSize(row.byte_size),
    sha256: row.sha256,
    storageKey: row.storage_key,
    status: toStatus(row.status),
    createdAt: toIso(row.created_at),
    storedAt: toNullableIso(row.stored_at),
    deletedAt: toNullableIso(row.deleted_at),
  };
}

function requireMessageId(value: string | null): string | null {
  if (value === null) {
    return null;
  }

  if (!isUuid(value)) {
    throw new PersistenceValidationError('invalid_input');
  }

  return value;
}

async function loadOwnedAttachment(
  queryable: Queryable,
  actorUserId: string,
  attachmentId: string,
  options: { includeDeleted?: boolean; forUpdate?: boolean } = {},
): Promise<AttachmentRow> {
  const ownerUserId = requireActorUserId(actorUserId);
  const ownedAttachmentId = requireResourceId(attachmentId);

  const base = options.includeDeleted === true
    ? ATTACHMENT_BY_ID_INCLUDING_DELETED
    : ATTACHMENT_BY_ID;
  const sql = options.forUpdate === true ? `${base} FOR UPDATE OF a` : base;

  const result = await queryable.query<AttachmentRow>(sql, [
    ownedAttachmentId,
    ownerUserId,
  ]);

  const row = result.rows[0];
  if (row === undefined) {
    throw new PersistenceNotFoundError();
  }

  return row;
}

export interface InsertAttachmentRecord {
  id: string;
  messageId: string | null;
  originalFilename: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  storageKey: string;
}

/**
 * Attachment persistence. `ownerUserId` is always the authenticated actor; the
 * conversation is resolved and proven live in the same statement, so a
 * concurrently tombstoned conversation cannot receive a new row.
 */
export class AttachmentRepository {
  constructor(private readonly pool: Pool) {}

  async insert(
    actorUserId: string,
    conversationId: string,
    record: InsertAttachmentRecord,
  ): Promise<AttachmentRecord> {
    const ownerUserId = requireActorUserId(actorUserId);
    const ownedConversationId = requireResourceId(conversationId);
    const attachmentId = requireResourceId(record.id);
    const messageId = requireMessageId(record.messageId);

    const result = await this.pool.query<AttachmentRow>(
      `INSERT INTO attachments (
         id,
         owner_user_id,
         conversation_id,
         message_id,
         original_filename,
         content_type,
         byte_size,
         sha256,
         storage_key
       )
       SELECT $1, c.owner_user_id, c.id, $3, $4, $5, $6, $7, $8
         FROM conversations c
        WHERE c.id = $2
          AND c.owner_user_id = $9
          AND c.deleted_at IS NULL
       RETURNING ${ATTACHMENT_RETURNING}`,
      [
        attachmentId,
        ownedConversationId,
        messageId,
        record.originalFilename,
        record.contentType,
        record.byteSize,
        record.sha256,
        record.storageKey,
        ownerUserId,
      ],
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new PersistenceNotFoundError();
    }

    return toAttachmentRecord(row);
  }

  /** Reads live (pending or stored) metadata the actor owns. */
  async get(actorUserId: string, attachmentId: string): Promise<AttachmentRecord> {
    return toAttachmentRecord(
      await loadOwnedAttachment(this.pool, actorUserId, attachmentId),
    );
  }

  /** Publishes a pending upload. An already-stored row is returned unchanged. */
  async markStored(
    actorUserId: string,
    attachmentId: string,
  ): Promise<AttachmentRecord> {
    return withTransaction(this.pool, async (client) => {
      const current = await loadOwnedAttachment(client, actorUserId, attachmentId, {
        forUpdate: true,
      });

      if (current.status === 'stored') {
        return toAttachmentRecord(current);
      }

      if (current.status !== 'pending') {
        throw new PersistenceNotFoundError();
      }

      const result = await client.query<AttachmentRow>(
        `UPDATE attachments
            SET status = 'stored',
                stored_at = now()
          WHERE id = $1
            AND owner_user_id = $2
            AND status = 'pending'
            AND deleted_at IS NULL
          RETURNING ${ATTACHMENT_RETURNING}`,
        [current.id, current.owner_user_id],
      );

      const row = result.rows[0];
      if (row === undefined) {
        throw new PersistenceNotFoundError();
      }

      return toAttachmentRecord(row);
    });
  }

  /** Records a policy rejection. Idempotent for an already-rejected row. */
  async markRejected(
    actorUserId: string,
    attachmentId: string,
  ): Promise<AttachmentRecord> {
    return withTransaction(this.pool, async (client) => {
      const current = await loadOwnedAttachment(client, actorUserId, attachmentId, {
        forUpdate: true,
      });

      if (current.status === 'rejected') {
        return toAttachmentRecord(current);
      }

      if (current.status !== 'pending') {
        throw new PersistenceNotFoundError();
      }

      const result = await client.query<AttachmentRow>(
        `UPDATE attachments
            SET status = 'rejected'
          WHERE id = $1
            AND owner_user_id = $2
            AND status = 'pending'
            AND deleted_at IS NULL
          RETURNING ${ATTACHMENT_RETURNING}`,
        [current.id, current.owner_user_id],
      );

      const row = result.rows[0];
      if (row === undefined) {
        throw new PersistenceNotFoundError();
      }

      return toAttachmentRecord(row);
    });
  }

  /** Lists stored attachments in one owned conversation, newest first. */
  async listStored(
    actorUserId: string,
    conversationId: string,
    options: ListAttachmentsOptions = {},
  ): Promise<AttachmentRecord[]> {
    const ownerUserId = requireActorUserId(actorUserId);
    const ownedConversationId = requireResourceId(conversationId);
    const limit =
      options.limit === undefined
        ? MAX_PAGE_SIZE
        : normalizeLimit(options.limit);

    const result = await this.pool.query<AttachmentRow>(
      `SELECT ${ATTACHMENT_COLUMNS}
         FROM attachments a
         JOIN conversations c
           ON c.id = a.conversation_id
          AND c.owner_user_id = a.owner_user_id
        WHERE a.owner_user_id = $1
          AND a.conversation_id = $2
          AND c.deleted_at IS NULL
          AND a.deleted_at IS NULL
          AND a.status = 'stored'
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT $3`,
      [ownerUserId, ownedConversationId, limit],
    );

    return result.rows.map(toAttachmentRecord);
  }

  /**
   * Tombstones a live attachment and returns the object key that must be
   * removed. A repeated delete returns `alreadyDeleted` instead of failing, and
   * a foreign id throws not-found before any key is returned.
   */
  async tombstone(
    actorUserId: string,
    attachmentId: string,
  ): Promise<{ record: AttachmentRecord; alreadyDeleted: boolean }> {
    const ownerUserId = requireActorUserId(actorUserId);
    const ownedAttachmentId = requireResourceId(attachmentId);

    return withTransaction(this.pool, async (client) => {
      const current = await loadOwnedAttachment(
        client,
        ownerUserId,
        ownedAttachmentId,
        { includeDeleted: true, forUpdate: true },
      );

      if (current.status === 'deleted') {
        return {
          record: toAttachmentRecord(current),
          alreadyDeleted: true,
        };
      }

      const result = await client.query<AttachmentRow>(
        `UPDATE attachments
            SET status = 'deleted',
                deleted_at = COALESCE(deleted_at, now())
          WHERE id = $1
            AND owner_user_id = $2
            AND status <> 'deleted'
          RETURNING ${ATTACHMENT_RETURNING}`,
        [current.id, current.owner_user_id],
      );

      const row = result.rows[0];
      if (row === undefined) {
        // A concurrent delete committed first; the object is already handled.
        return {
          record: toAttachmentRecord(current),
          alreadyDeleted: true,
        };
      }

      return { record: toAttachmentRecord(row), alreadyDeleted: false };
    });
  }
}
