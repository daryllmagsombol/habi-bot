/**
 * Owner-scoped SQL for derived extraction chunks.
 *
 * Every statement binds the authenticated actor to `owner_user_id` and joins a
 * live, stored attachment in a live conversation. A foreign, unknown, malformed,
 * pending, or tombstoned attachment therefore has one outcome: not found.
 *
 * Re-extraction is one transaction: lock the owned source attachment, delete its
 * chunks, and insert the new deterministic set. A concurrent re-extraction
 * serializes on that lock, so readers never observe a mixed extraction and the
 * `(attachment_id, chunk_index)` unique constraint is never raced.
 */
import type { Pool } from 'pg';
import { withTransaction } from '../persistence/database.js';
import type { Queryable } from '../persistence/database.js';
import { PersistenceValidationError } from '../persistence/errors.js';
import { MAX_PAGE_SIZE, normalizeLimit } from '../persistence/pagination.js';
import {
  requireActorUserId,
  requireResourceId,
  requireRow,
  toIso,
  type Timestamp,
} from '../persistence/rows.js';
import type {
  ExtractedChunk,
  ListChunksOptions,
  SearchChunksOptions,
} from './types.js';

export interface ChunkInsert {
  text: string;
  startOffset: number;
  endOffset: number;
}

interface DocumentChunkRow {
  attachment_id: string;
  chunk_index: number;
  text: string;
  start_offset: number;
  end_offset: number;
}

interface ChunkAggregateRow {
  chunk_count: number;
  start_offset: number;
  end_offset: number;
  extracted_at: Timestamp | null;
}

export interface ChunkAggregate {
  chunkCount: number;
  startOffset: number;
  endOffset: number;
  extractedAt: string | null;
}

/** One live, stored attachment the actor owns. */
const VISIBLE_ATTACHMENT = `SELECT a.id, a.conversation_id
   FROM attachments a
   JOIN conversations c
     ON c.id = a.conversation_id
    AND c.owner_user_id = a.owner_user_id
  WHERE a.id = $1
    AND a.owner_user_id = $2
    AND a.status = 'stored'
    AND a.deleted_at IS NULL
    AND c.deleted_at IS NULL`;

const CHUNK_COLUMNS = `ch.attachment_id, ch.chunk_index, ch.text,
  ch.start_offset, ch.end_offset`;

function toChunk(row: DocumentChunkRow): ExtractedChunk {
  return {
    attachmentId: row.attachment_id,
    chunkIndex: row.chunk_index,
    text: row.text,
    startOffset: row.start_offset,
    endOffset: row.end_offset,
  };
}

function requireNonNegativeInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new PersistenceValidationError('invalid_input');
  }

  return value;
}

async function requireVisibleAttachment(
  queryable: Queryable,
  actorUserId: string,
  attachmentId: string,
): Promise<{ id: string; conversationId: string }> {
  const ownerUserId = requireActorUserId(actorUserId);
  const ownedAttachmentId = requireResourceId(attachmentId);
  const result = await queryable.query<{ id: string; conversation_id: string }>(
    VISIBLE_ATTACHMENT,
    [ownedAttachmentId, ownerUserId],
  );
  const row = requireRow(result);

  return { id: row.id, conversationId: row.conversation_id };
}

export class ExtractionRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * Replaces every chunk for one owned attachment in a single transaction.
   * Returns the number of inserted chunks. The caller has already read and
   * verified the attachment bytes; this method re-proves visibility and scope,
   * so a concurrent tombstone cannot leave fresh derived rows behind.
   */
  async replace(
    actorUserId: string,
    attachmentId: string,
    chunks: readonly ChunkInsert[],
  ): Promise<number> {
    const ownerUserId = requireActorUserId(actorUserId);
    const ownedAttachmentId = requireResourceId(attachmentId);

    return withTransaction(this.pool, async (client) => {
      const attachment = await client.query<{ id: string; conversation_id: string }>(
        `${VISIBLE_ATTACHMENT}
         FOR UPDATE OF a`,
        [ownedAttachmentId, ownerUserId],
      );
      const source = requireRow(attachment);

      await client.query(
        `DELETE FROM document_chunks
          WHERE attachment_id = $1
            AND owner_user_id = $2`,
        [source.id, ownerUserId],
      );

      if (chunks.length === 0) {
        return 0;
      }

      const result = await client.query(
        `INSERT INTO document_chunks (
           attachment_id,
           owner_user_id,
           conversation_id,
           chunk_index,
           text,
           start_offset,
           end_offset
         )
         SELECT $1, $2, $3, batch.chunk_index, batch.text,
                batch.start_offset, batch.end_offset
           FROM unnest($4::int[], $5::text[], $6::int[], $7::int[])
             AS batch(chunk_index, text, start_offset, end_offset)`,
        [
          source.id,
          ownerUserId,
          source.conversation_id,
          chunks.map((_, index) => index),
          chunks.map((chunk) => chunk.text),
          chunks.map((chunk) => chunk.startOffset),
          chunks.map((chunk) => chunk.endOffset),
        ],
      );

      return result.rowCount ?? chunks.length;
    });
  }

  /** Ordered chunks for one owned attachment, bounded by one page. */
  async list(
    actorUserId: string,
    attachmentId: string,
    options: ListChunksOptions = {},
  ): Promise<ExtractedChunk[]> {
    const ownerUserId = requireActorUserId(actorUserId);
    const source = await requireVisibleAttachment(
      this.pool,
      actorUserId,
      attachmentId,
    );
    const limit =
      options.limit === undefined ? MAX_PAGE_SIZE : normalizeLimit(options.limit);
    const afterChunkIndex =
      options.afterChunkIndex === undefined
        ? -1
        : requireNonNegativeInteger(options.afterChunkIndex);

    const result = await this.pool.query<DocumentChunkRow>(
      `SELECT ${CHUNK_COLUMNS}
         FROM document_chunks ch
        WHERE ch.owner_user_id = $1
          AND ch.attachment_id = $2
          AND ch.chunk_index > $3
        ORDER BY ch.chunk_index ASC
        LIMIT $4`,
      [ownerUserId, source.id, afterChunkIndex, limit],
    );

    return result.rows.map(toChunk);
  }

  /**
   * Coverage of the current chunk set. A missing attachment is not found; an
   * attachment with no chunks returns zeroes, which the service maps to
   * `not_extracted` rather than to an empty successful document.
   */
  async aggregate(
    actorUserId: string,
    attachmentId: string,
  ): Promise<ChunkAggregate> {
    const ownerUserId = requireActorUserId(actorUserId);
    const ownedAttachmentId = requireResourceId(attachmentId);

    const result = await this.pool.query<ChunkAggregateRow>(
      `SELECT count(ch.id)::int AS chunk_count,
              coalesce(min(ch.start_offset), 0)::int AS start_offset,
              coalesce(max(ch.end_offset), 0)::int AS end_offset,
              max(ch.created_at) AS extracted_at
         FROM attachments a
         JOIN conversations c
           ON c.id = a.conversation_id
          AND c.owner_user_id = a.owner_user_id
         LEFT JOIN document_chunks ch
           ON ch.attachment_id = a.id
          AND ch.owner_user_id = a.owner_user_id
        WHERE a.id = $1
          AND a.owner_user_id = $2
          AND a.status = 'stored'
          AND a.deleted_at IS NULL
          AND c.deleted_at IS NULL
        GROUP BY a.id`,
      [ownedAttachmentId, ownerUserId],
    );
    const row = requireRow(result);

    return {
      chunkCount: row.chunk_count,
      startOffset: row.start_offset,
      endOffset: row.end_offset,
      extractedAt:
        row.extracted_at === null ? null : toIso(row.extracted_at),
    };
  }

  /**
   * Owner- and conversation-scoped substring search over chunk text. The query
   * is literal (`strpos`), never a pattern or an expression: document text
   * cannot become SQL. Case folding is PostgreSQL `lower`, applied to both
   * sides; no locale-specific collation or stemming is claimed.
   */
  async search(
    actorUserId: string,
    conversationId: string,
    term: string,
    options: SearchChunksOptions = {},
  ): Promise<ExtractedChunk[]> {
    const ownerUserId = requireActorUserId(actorUserId);
    const ownedConversationId = requireResourceId(conversationId);
    const limit =
      options.limit === undefined ? MAX_PAGE_SIZE : normalizeLimit(options.limit);

    const result = await this.pool.query<DocumentChunkRow>(
      `SELECT ${CHUNK_COLUMNS}
         FROM document_chunks ch
         JOIN attachments a
           ON a.id = ch.attachment_id
          AND a.owner_user_id = ch.owner_user_id
          AND a.conversation_id = ch.conversation_id
         JOIN conversations c
           ON c.id = a.conversation_id
          AND c.owner_user_id = a.owner_user_id
        WHERE ch.owner_user_id = $1
          AND ch.conversation_id = $2
          AND a.status = 'stored'
          AND a.deleted_at IS NULL
          AND c.deleted_at IS NULL
          AND strpos(lower(ch.text), lower($3)) > 0
        ORDER BY a.created_at DESC, ch.attachment_id DESC, ch.chunk_index ASC
        LIMIT $4`,
      [ownerUserId, ownedConversationId, term, limit],
    );

    return result.rows.map(toChunk);
  }
}
