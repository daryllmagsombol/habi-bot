/**
 * Lazy composition root for the P1 chat surface.
 *
 * The pool is opened on the first route call, not at module import, so a process
 * that merely loads `ApiModule` behind an unset flag cannot fail startup or
 * idle a database connection. `DATABASE_URL` is read here; it is never logged
 * or returned. A flag-on deployment with no database answers `503
 * api_unavailable` instead of exposing half a surface.
 */
import { Injectable } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import type { Pool } from 'pg';
import { createPersistencePool } from '../persistence/database.js';
import { ApiError } from './api-errors.js';
import { ApiService } from './api-service.js';

@Injectable()
export class ApiRuntime implements OnModuleDestroy {
  private pool: Pool | undefined;
  private service: ApiService | undefined;

  getService(): ApiService {
    if (this.service !== undefined) {
      return this.service;
    }

    const connectionString = process.env.DATABASE_URL?.trim();

    if (connectionString === undefined || connectionString.length === 0) {
      throw new ApiError('api_unavailable');
    }

    this.pool = createPersistencePool({ connectionString });
    this.service = new ApiService(this.pool);

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
