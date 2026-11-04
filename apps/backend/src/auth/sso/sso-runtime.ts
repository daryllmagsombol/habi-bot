/**
 * Lazy composition root for the SSO slice.
 *
 * Mirrors `AuthRuntime`: the database pool is created on first use, so importing
 * the module cannot fail startup over missing configuration or open an unused
 * connection. `DATABASE_URL` is read here and nowhere else in the slice; it is
 * never logged or returned.
 *
 * The session port is injected (already resolved against the H-017 core) so
 * guards can validate a session without touching the database.
 */
import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import type { Pool } from 'pg';
import { createPersistencePool } from '../../persistence/database.js';
import {
  summarizeProviders,
  type SsoConfig,
  type SsoProviderSummary,
} from './sso-config.js';
import type { SsoProvider, SsoProviderId, SsoSessionPort } from './sso-types.js';
import { SsoRepository } from './sso-repository.js';
import { SsoService } from './sso-service.js';

export const SSO_CONFIG = Symbol('HABI_SSO_CONFIG');
export const SSO_PROVIDERS = Symbol('HABI_SSO_PROVIDERS');
export const SSO_SESSION_PORT = Symbol('HABI_SSO_SESSION_PORT');

@Injectable()
export class SsoRuntime implements OnModuleDestroy {
  private service: SsoService | undefined;
  private pool: Pool | undefined;

  constructor(
    @Inject(SSO_CONFIG) private readonly config: SsoConfig,
    @Inject(SSO_PROVIDERS) private readonly providers: ReadonlyMap<SsoProviderId, SsoProvider>,
    @Inject(SSO_SESSION_PORT) private readonly sessions: SsoSessionPort,
  ) {}

  getSessions(): SsoSessionPort {
    return this.sessions;
  }

  /** Public advertisement. Reads configuration only; never opens a pool. */
  advertisedProviders(): SsoProviderSummary[] {
    return summarizeProviders(this.config);
  }

  getService(): SsoService {
    if (this.service !== undefined) {
      return this.service;
    }

    const connectionString = process.env.DATABASE_URL?.trim();

    if (connectionString === undefined || connectionString.length === 0) {
      throw new HttpException(
        { error: { code: 'sso_unavailable' } },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    this.pool = createPersistencePool({ connectionString });
    this.service = new SsoService({
      config: this.config,
      providers: this.providers,
      repository: new SsoRepository(this.pool),
      sessions: this.sessions,
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
