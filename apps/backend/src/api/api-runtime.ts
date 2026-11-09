/**
 * Lazy composition root for the P1 chat surface.
 *
 * The pool is opened on the first route call, not at module import, so a process
 * that merely loads `ApiModule` behind an unset flag cannot fail startup or
 * idle a database connection. `DATABASE_URL` is read here; it is never logged
 * or returned. A flag-on deployment with no database answers `503
 * api_unavailable` instead of exposing half a surface.
 *
 * Attachment bytes need a private storage root. Metadata routes do not. The
 * root is resolved on the first storage operation, so an unconfigured process
 * still serves attachment metadata and refuses only the byte read with the same
 * `503 api_unavailable` vocabulary.
 */
import { Injectable } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import { isAbsolute } from 'node:path';
import type { Pool } from 'pg';
import { AttachmentService } from '../attachments/attachment-service.js';
import { LocalAttachmentStorage } from '../attachments/storage.js';
import type {
  AttachmentObjectInfo,
  AttachmentObjectLocator,
  AttachmentStorage,
} from '../attachments/storage.js';
import { createPersistencePool } from '../persistence/database.js';
import { ATTACHMENT_STORAGE_ROOT_ENV } from './api-config.js';
import { ApiError } from './api-errors.js';
import { ApiService } from './api-service.js';

/**
 * Defers reading the storage root until an operation actually needs bytes, so
 * constructing the attachment service cannot fail a metadata-only process.
 */
class ConfiguredAttachmentStorage implements AttachmentStorage {
  private storage: LocalAttachmentStorage | undefined;

  private resolve(): LocalAttachmentStorage {
    if (this.storage !== undefined) {
      return this.storage;
    }

    const root = process.env[ATTACHMENT_STORAGE_ROOT_ENV]?.trim();

    if (root === undefined || root.length === 0 || !isAbsolute(root)) {
      throw new ApiError('api_unavailable');
    }

    this.storage = new LocalAttachmentStorage(root);

    return this.storage;
  }

  putObject(
    locator: AttachmentObjectLocator,
    source: AsyncIterable<Uint8Array>,
    maxBytes: number,
  ): Promise<AttachmentObjectInfo> {
    return this.resolve().putObject(locator, source, maxBytes);
  }

  getObject(
    locator: AttachmentObjectLocator,
    expected: AttachmentObjectInfo,
  ): Promise<Buffer> {
    return this.resolve().getObject(locator, expected);
  }

  deleteObject(locator: AttachmentObjectLocator): Promise<void> {
    return this.resolve().deleteObject(locator);
  }
}

@Injectable()
export class ApiRuntime implements OnModuleDestroy {
  private pool: Pool | undefined;
  private service: ApiService | undefined;
  private attachments: AttachmentService | undefined;

  getService(): ApiService {
    if (this.service !== undefined) {
      return this.service;
    }

    this.service = new ApiService(this.getPool());

    return this.service;
  }

  /** Attachment metadata and verified bytes; storage is resolved on demand. */
  getAttachments(): AttachmentService {
    if (this.attachments !== undefined) {
      return this.attachments;
    }

    this.attachments = new AttachmentService(
      this.getPool(),
      new ConfiguredAttachmentStorage(),
    );

    return this.attachments;
  }

  private getPool(): Pool {
    if (this.pool !== undefined) {
      return this.pool;
    }

    const connectionString = process.env.DATABASE_URL?.trim();

    if (connectionString === undefined || connectionString.length === 0) {
      throw new ApiError('api_unavailable');
    }

    this.pool = createPersistencePool({ connectionString });

    return this.pool;
  }

  async onModuleDestroy(): Promise<void> {
    const pool = this.pool;

    this.pool = undefined;
    this.service = undefined;
    this.attachments = undefined;

    if (pool !== undefined) {
      await pool.end();
    }
  }
}
