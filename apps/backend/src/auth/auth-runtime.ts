/**
 * Lazy composition root for the auth slice.
 *
 * The database pool is created on first use, not at module import, so a
 * process that imports `AuthModule` while `HABI_AUTH_SPIKE` is unset cannot
 * fail startup over missing auth configuration or open an unused connection.
 * `authSpikeModules()` is the intended `AppModule` entry point; this runtime is
 * the fallback boundary when the module is imported unconditionally.
 *
 * `DATABASE_URL` is read here and nowhere else in the auth slice. It is never
 * logged or returned.
 */
import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import type { Pool } from 'pg';
import { createPersistencePool } from '../persistence/database.js';
import { readRegistrationMode } from './auth-config.js';
import { AuthRepository } from './auth-repository.js';
import { AuthService } from './auth-service.js';
import { CoreSessionPort } from './core-session-port.js';
import { SessionService } from '../session/session.service.js';

@Injectable()
export class AuthRuntime implements OnModuleDestroy {
  private service: AuthService | undefined;
  private pool: Pool | undefined;

  constructor(@Inject(SessionService) private readonly sessions: SessionService) {}

  getService(): AuthService {
    if (this.service !== undefined) {
      return this.service;
    }

    const connectionString = process.env.DATABASE_URL?.trim();

    if (connectionString === undefined || connectionString.length === 0) {
      throw new HttpException(
        { error: { code: 'auth_unavailable' } },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    this.pool = createPersistencePool({ connectionString });
    this.service = new AuthService({
      repository: new AuthRepository(this.pool),
      sessions: new CoreSessionPort(this.sessions),
      registrationMode: readRegistrationMode(),
    });

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
