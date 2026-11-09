/**
 * P1 chat composition module (H-018), extended by H-032.
 *
 * Enabled only when `HABI_P1_API=1`; `AppModule` does not import this module
 * otherwise, so the default app has no `/api` surface and no database pool from
 * this slice.
 *
 * The session core is imported from `SessionCoreModule` and is the same
 * instance the auth and SSO surfaces use. Importing `AuthModule` or
 * `SessionSpikeModule` here would expose login/fixture routes behind the chat
 * flag, so the shared module is imported directly instead. The session service
 * remains in-memory, exactly like the contract slice it reuses.
 *
 * H-032 adds `ApiAccountController` and its lazy `AccountRuntime`; both reuse
 * the same shared session instance so deletion can revoke the caller's session
 * and every other live session.
 */
import { Module } from '@nestjs/common';
import { AccountRuntime } from '../account/account-runtime.js';
import { SessionCoreModule } from '../session/session-core.module.js';
import { ApiAccountController } from './api-account.controller.js';
import { ApiContentController } from './api-content.controller.js';
import { ApiController } from './api.controller.js';
import { ApiErrorFilter } from './api-errors.js';
import { ApiRuntime } from './api-runtime.js';

@Module({
  imports: [SessionCoreModule],
  controllers: [ApiController, ApiContentController, ApiAccountController],
  providers: [ApiErrorFilter, ApiRuntime, AccountRuntime],
})
export class P1ApiModule {}
