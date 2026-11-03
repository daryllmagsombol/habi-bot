/**
 * Session spike module for H-017 (#17). Not product code.
 * Enabled only when HABI_SESSION_SPIKE=1.
 *
 * Registers the in-process session service, its guards, and the spike routes.
 * `AppModule` imports this module only when the flag is set, so the default app
 * has no session surface. All state is in-memory and lost on process exit.
 */
import { Module } from '@nestjs/common';
import { SessionAuthGuard } from './session-auth.guard.js';
import { SessionCsrfGuard } from './session-csrf.guard.js';
import { SESSION_CLOCK, SessionService, systemClock } from './session.service.js';
import { SessionSpikeController } from './session-spike.controller.js';

@Module({
  controllers: [SessionSpikeController],
  providers: [
    SessionService,
    SessionAuthGuard,
    SessionCsrfGuard,
    { provide: SESSION_CLOCK, useValue: systemClock },
  ],
})
export class SessionSpikeModule {}
