/**
 * Auth-slice Nest module.
 *
 * Wiring note: `AppModule` owns the feature flags, so this module is exported
 * for a one-line conditional import:
 *
 *   const AUTH_SPIKE_MODULES = authSpikeModules();
 *   imports: [...SPIKE_MODULES, ...SESSION_SPIKE_MODULES, ...AUTH_SPIKE_MODULES]
 *
 * The session core is imported from `SessionCoreModule` and re-exported, never
 * provided here. `AuthController` mints sessions at login, `GET /auth/me` and
 * `POST /auth/logout` validate the same records through the same guards, and
 * the P1 chat module imports the same core. A private copy of `SessionService`
 * in this module is what previously made a login unknown to every other
 * authenticated surface.
 *
 * `SessionSpikeModule` is still not imported: enabling the auth surface must
 * not also expose the H-017 fixture controller.
 */
import { Module } from '@nestjs/common';
import { SessionCoreModule } from '../session/session-core.module.js';
import { AuthController } from './auth.controller.js';
import { AuthRuntime } from './auth-runtime.js';
import { AuthSpikeGuard } from './auth-spike.guard.js';

@Module({
  imports: [SessionCoreModule],
  controllers: [AuthController],
  providers: [AuthSpikeGuard, AuthRuntime],
  exports: [SessionCoreModule],
})
export class AuthModule {}
