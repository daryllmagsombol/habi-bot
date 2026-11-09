/**
 * Lazy composition root for the H-032 account routes.
 *
 * Like `ApiRuntime`, it opens nothing at module import. `DATABASE_URL` is read
 * here and never logged. `HABI_ATTACHMENT_STORAGE_ROOT` names the private local
 * object root the attachment lane already uses; when it is unset, deletion
 * still works for an account with no attachment rows and refuses (503
 * `account_storage_unavailable`) rather than reporting a purge while leaving
 * files behind when rows exist.
 */
import { Injectable } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import type { Pool } from 'pg';
import { LocalAttachmentStorage } from '../attachments/storage.js';
import { createPersistencePool } from '../persistence/database.js';
import { ApiError } from '../api/api-errors.js';
import { AccountService } from './account-service.js';

export const ATTACHMENT_STORAGE_ROOT_ENV = 'HABI_ATTACHMENT_STORAGE_ROOT';

@Injectable()
export class AccountRuntime implements OnModuleDestroy {
  private pool: Pool | undefined;
  private service: AccountService | undefined;

  getService(): AccountService {
    if (this.service !== undefined) {
      return this.service;
    }

    const connectionString = process.env.DATABASE_URL?.trim();

    if (connectionString === undefined || connectionString.length === 0) {
      throw new ApiError('api_unavailable');
    }

    const storageRoot = process.env[ATTACHMENT_STORAGE_ROOT_ENV]?.trim();
    this.pool = createPersistencePool({ connectionString });
    this.service = new AccountService(
      this.pool,
      storageRoot === undefined || storageRoot.length === 0
        ? undefined
        : new LocalAttachmentStorage(storageRoot),
    );

    return this.service;
  }

  async onModuleDestroy(): Promise<void> {
    const pool = this.pool;

    this.pool = undefined;
    this.service = undefined;

    if (pool !== undefined) {
      await pool.end();
    }
  }
}
