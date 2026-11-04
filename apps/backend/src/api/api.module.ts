/**
 * P1 chat composition module (H-018). Not product authentication.
 *
 * Enabled only when `HABI_P1_API=1`; `AppModule` does not import this module
 * otherwise, so the default app has no `/api` surface and no database pool from
 * this slice.
 *
 * It provides its own H-017 session core instead of importing
 * `SessionSpikeModule` or `AuthModule`, so enabling the chat surface does not
 * also expose fixture-login or auth-spike routes. The session service is
 * in-memory, exactly like the contract slice it reuses.
 */
import { Module } from '@nestjs/common';
import { SESSION_CLOCK, SessionService, systemClock } from '../session/session.service.js';
import { SessionAuthGuard } from '../session/session-auth.guard.js';
import { SessionCsrfGuard } from '../session/session-csrf.guard.js';
import { ApiController } from './api.controller.js';
import { ApiErrorFilter } from './api-errors.js';
import { ApiRuntime } from './api-runtime.js';

@Module({
  controllers: [ApiController],
  providers: [
    SessionService,
    { provide: SESSION_CLOCK, useValue: systemClock },
    SessionAuthGuard,
    SessionCsrfGuard,
    ApiErrorFilter,
    ApiRuntime,
  ],
})
export class P1ApiModule {}
