/**
 * Auth-slice Nest module.
 *
 * Wiring note: `AppModule` owns the feature flags, so this module is exported
 * for a one-line conditional import:
 *
 *   const AUTH_SPIKE_MODULES = authSpikeModules();
 *   imports: [...SPIKE_MODULES, ...SESSION_SPIKE_MODULES, ...AUTH_SPIKE_MODULES]
 *
 * The session service, clock, and guards are provided here rather than by
 * importing `SessionSpikeModule`, because the auth surface must not also expose
 * the H-017 fixture controller. The session core is unmodified.
 */
import { Module } from '@nestjs/common';
import { SESSION_CLOCK, SessionService, systemClock } from '../session/session.service.js';
import { SessionAuthGuard } from '../session/session-auth.guard.js';
import { SessionCsrfGuard } from '../session/session-csrf.guard.js';
import { AuthController } from './auth.controller.js';
import { AuthRuntime } from './auth-runtime.js';
import { AuthSpikeGuard } from './auth-spike.guard.js';

@Module({
  controllers: [AuthController],
  providers: [
    SessionService,
    { provide: SESSION_CLOCK, useValue: systemClock },
    SessionAuthGuard,
    SessionCsrfGuard,
    AuthSpikeGuard,
    AuthRuntime,
  ],
})
export class AuthModule {}
