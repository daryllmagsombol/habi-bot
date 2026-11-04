/**
 * The single session authority for a process.
 *
 * Every surface that authenticates a request imports this module: the H-014
 * auth slice, SSO, the H-018 P1 chat API, and the H-017 fixture routes. Nest
 * caches an imported module by class, so all of them resolve the same
 * `SessionService` instance and therefore the same in-memory record set.
 *
 * Declaring `SessionService` as a provider in more than one feature module
 * instead creates one instance per module: a session minted at `/auth/login`
 * would then be unknown to `/api` and to logout. `SessionService` and its clock
 * are exported together so no importer can pair the store with a different
 * clock.
 *
 * This module is inert unless a flag-gated feature module imports it; it
 * registers no controllers.
 */
import { Module } from '@nestjs/common';
import { SessionAuthGuard } from './session-auth.guard.js';
import { SessionCsrfGuard } from './session-csrf.guard.js';
import { SESSION_CLOCK, SessionService, systemClock } from './session.service.js';

@Module({
  providers: [
    SessionService,
    { provide: SESSION_CLOCK, useValue: systemClock },
    SessionAuthGuard,
    SessionCsrfGuard,
  ],
  exports: [SessionService, SESSION_CLOCK, SessionAuthGuard, SessionCsrfGuard],
})
export class SessionCoreModule {}
