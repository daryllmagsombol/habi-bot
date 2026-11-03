/**
 * H-026 (#26) AttachmentService: private, owner- and conversation-scoped
 * uploads.
 *
 * Invariants:
 *   - Every method takes the authenticated actor id from the session boundary.
 *     No method accepts an owner, a storage key, a path, or a filesystem name.
 *   - Owner and conversation are enforced in SQL; the storage key repeats the
 *     same server-generated ids, so an object cannot be reached through a
 *     different conversation even if a caller guesses its identifier.
 *   - Foreign, unknown, malformed, rejected, and tombstoned attachments all map
 *     to one `not_found`, with no id or reason in the error.
 *   - Bytes are written through the storage abstraction with a 10 MiB ceiling
 *     and a SHA-256 digest computed in the same single streaming pass.
 *   - Reads re-hash the stored object and fail closed on any disagreement.
 *   - A delete is idempotent for the owner and never removes a foreign object.
 *
 * HTTP endpoints, Nest providers, quotas, retention sweeps, extraction, and
 * malware scanning are not implemented in this slice.
 */
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { PersistenceNotFoundError } from '../persistence/errors.js';
import { loadOwnedConversation } from '../persistence/rows.js';
import { AttachmentRepository } from './attachment-repository.js';
import { AttachmentRejectedError } from './errors.js';
import type { AttachmentScanner, AttachmentStorage } from './storage.js';
import { buildAttachmentStorageKey } from './storage.js';
import type {
  AttachmentContent,
  AttachmentMetadata,
  AttachmentRecord,
  CreateAttachmentUploadInput,
  ListAttachmentsOptions,
} from './types.js';
import {
  MAX_ATTACHMENT_BYTES,
  normalizeCreateAttachmentUpload,
} from './validation.js';

function toMetadata(record: AttachmentRecord): AttachmentMetadata {
  return {
    id: record.id,
    conversationId: record.conversationId,
    messageId: record.messageId,
    originalFilename: record.originalFilename,
    contentType: record.contentType,
    byteSize: record.byteSize,
    sha256: record.sha256,
    status: record.status,
    createdAt: record.createdAt,
    storedAt: record.storedAt,
    deletedAt: record.deletedAt,
  };
}

export class AttachmentService {
  private readonly repository: AttachmentRepository;
  private readonly storage: AttachmentStorage;
  private readonly scanner: AttachmentScanner | undefined;
  private readonly pool: Pool;

  constructor(pool: Pool, storage: AttachmentStorage, scanner?: AttachmentScanner) {
    this.pool = pool;
    this.repository = new AttachmentRepository(pool);
    this.storage = storage;
    this.scanner = scanner;
  }

  /**
   * Streams one upload into private storage and records a `pending` row.
   * The row becomes downloadable only after `finalize`.
   */
  async createUpload(
    actorUserId: string,
    conversationId: string,
    input: CreateAttachmentUploadInput,
  ): Promise<AttachmentMetadata> {
    // Resolve the live, owned conversation before consuming any bytes.
    const conversation = await loadOwnedConversation(
      this.pool,
      actorUserId,
      conversationId,
    );
    const upload = normalizeCreateAttachmentUpload(input);

    const attachmentId = randomUUID();
    const locator = {
      ownerUserId: actorUserId,
      conversationId: conversation.id,
      attachmentId,
    };

    const stored = await this.storage.putObject(
      locator,
      upload.source,
      MAX_ATTACHMENT_BYTES,
    );

    try {
      const pending = await this.repository.insert(actorUserId, conversation.id, {
        id: attachmentId,
        messageId: null,
        originalFilename: upload.filename,
        contentType: upload.contentType,
        byteSize: stored.byteSize,
        sha256: stored.sha256,
        storageKey: buildAttachmentStorageKey(locator),
      });

      if (this.scanner !== undefined) {
        const decision = await this.scanner.scan({
          filename: pending.originalFilename,
          contentType: pending.contentType,
          byteSize: pending.byteSize,
          sha256: pending.sha256,
        });

        if (decision.verdict === 'reject') {
          await this.repository.markRejected(actorUserId, pending.id);
          await this.storage.deleteObject(locator);
          throw new AttachmentRejectedError();
        }
      }

      return toMetadata(pending);
    } catch (error) {
      // No row (or a rejected row) must never leave downloadable bytes behind.
      if (!(error instanceof AttachmentRejectedError)) {
        await this.storage.deleteObject(locator).catch(() => {});
      }
      throw error;
    }
  }

  /** Publishes a pending upload. Idempotent for an already-stored attachment. */
  async finalize(
    actorUserId: string,
    attachmentId: string,
  ): Promise<AttachmentMetadata> {
    return toMetadata(await this.repository.markStored(actorUserId, attachmentId));
  }

  /** Owner-only metadata for a live (pending or stored) attachment. */
  async getMetadata(
    actorUserId: string,
    attachmentId: string,
  ): Promise<AttachmentMetadata> {
    const record = await this.repository.get(actorUserId, attachmentId);

    if (record.status !== 'pending' && record.status !== 'stored') {
      throw new PersistenceNotFoundError();
    }

    return toMetadata(record);
  }

  /** Returns verified bytes for one stored attachment the actor owns. */
  async readContent(
    actorUserId: string,
    attachmentId: string,
  ): Promise<AttachmentContent> {
    const record = await this.repository.get(actorUserId, attachmentId);

    // Pending, rejected, and tombstoned rows are not downloadable, and the
    // answer is the same not-found a foreign id produces.
    if (record.status !== 'stored') {
      throw new PersistenceNotFoundError();
    }

    const content = await this.storage.getObject(
      {
        ownerUserId: record.ownerUserId,
        conversationId: record.conversationId,
        attachmentId: record.id,
      },
      { byteSize: record.byteSize, sha256: record.sha256 },
    );

    return { metadata: toMetadata(record), content };
  }

  /**
   * Tombstones the row and removes the stored object. A repeated owner delete
   * succeeds without touching the object again; a foreign delete throws
   * not-found before the object is addressed.
   */
  async delete(actorUserId: string, attachmentId: string): Promise<void> {
    const { record } = await this.repository.tombstone(actorUserId, attachmentId);

    // The row is already tombstoned at this point, so a retry converges even if
    // object removal failed previously. Removing an absent object is a no-op,
    // and a foreign id never reaches this line.
    await this.storage.deleteObject({
      ownerUserId: record.ownerUserId,
      conversationId: record.conversationId,
      attachmentId: record.id,
    });
  }

  /** Lists stored attachments in one owned conversation, newest first. */
  async listForConversation(
    actorUserId: string,
    conversationId: string,
    options: ListAttachmentsOptions = {},
  ): Promise<AttachmentMetadata[]> {
    const conversation = await loadOwnedConversation(
      this.pool,
      actorUserId,
      conversationId,
    );

    const records = await this.repository.listStored(
      actorUserId,
      conversation.id,
      options,
    );

    return records.map(toMetadata);
  }
}
