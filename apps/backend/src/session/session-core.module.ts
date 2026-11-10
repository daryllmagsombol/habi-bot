/**
 * The single session authority for a process.
 *
 * Every surface that authenticates a request imports this module: the H-014
 * auth slice, SSO, the H-018 P1 chat API, and the H-017 fixture routes. Nest
 * caches an imported module by class, so all of them resolve the same
 * `SessionService` instance and therefore the same record set.
 *
 * Declaring `SessionService` as a provider in more than one feature module
 * instead creates one instance per module: a session minted at `/auth/login`
 * would then be unknown to `/api` and to logout. `SessionService`, its clock
 * and its store are exported together so no importer can pair the service with
 * a different clock or a second store.
 *
 * **Store selection.** `SESSION_STORE` is chosen once, here, from the
 * environment:
 *
 *   - `HABI_SESSION_STORE=memory` forces the in-memory store;
 *   - `HABI_SESSION_STORE=postgres` requires `DATABASE_URL` and fails loudly
 *     without it, because a durable deployment must not silently degrade to
 *     losing every session on restart;
 *   - unset (the default) uses PostgreSQL when `DATABASE_URL` is present and
 *     the in-memory store when it is not. The deployed stack always has a
 *     database, so it gets durability by default; a flag-gated slice or the
 *     H-017 fixture surface with no database keeps the dependency-free store
 *     it shipped with.
 *
 * This module is inert unless a flag-gated feature module imports it; it
 * registers no controllers.
 */
import { Module } from '@nestjs/common';
import { PostgresSessionStore } from './session-postgres-store.js';
import { SessionAuthGuard } from './session-auth.guard.js';
import { SessionCsrfGuard } from './session-csrf.guard.js';
import { InMemorySessionStore, SESSION_STORE } from './session-store.js';
import type { SessionStore } from './session-store.js';
import { SESSION_CLOCK, SessionService, systemClock } from './session.service.js';

const STORE_MODE_KEY = 'HABI_SESSION_STORE';

function readStoreMode(): string {
  return (process.env[STORE_MODE_KEY] ?? '').trim().toLowerCase();
}

function databaseUrl(): string | undefined {
  const value = process.env.DATABASE_URL?.trim();

  return value === undefined || value.length === 0 ? undefined : value;
}

function createSessionStore(): SessionStore {
  const mode = readStoreMode();
  const connectionString = databaseUrl();

  if (mode === 'memory') {
    return new InMemorySessionStore();
  }

  if (mode === 'postgres') {
    if (connectionString === undefined) {
      throw new Error(`${STORE_MODE_KEY}=postgres requires DATABASE_URL.`);
    }

    return new PostgresSessionStore({ connectionString });
  }

  if (mode !== '') {
    // Report the accepted values, not an echo of the input.
    throw new Error(`${STORE_MODE_KEY} must be "memory" or "postgres" when set.`);
  }

  return connectionString === undefined
    ? new InMemorySessionStore()
    : new PostgresSessionStore({ connectionString });
}

@Module({
  providers: [
    SessionService,
    { provide: SESSION_CLOCK, useValue: systemClock },
    { provide: SESSION_STORE, useFactory: createSessionStore },
    SessionAuthGuard,
    SessionCsrfGuard,
  ],
  exports: [SessionService, SESSION_CLOCK, SESSION_STORE, SessionAuthGuard, SessionCsrfGuard],
})
export class SessionCoreModule {}
