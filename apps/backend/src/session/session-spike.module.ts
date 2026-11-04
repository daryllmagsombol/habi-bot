/**
 * Session spike module for H-017 (#17). Not product code.
 * Enabled only when HABI_SESSION_SPIKE=1.
 *
 * Registers the spike routes over the process-wide `SessionCoreModule`, so a
 * fixture session and a real login session are the same records when both
 * flags are on. `AppModule` imports this module only when the flag is set, so
 * the default app has no session surface. All state is in-memory and lost on
 * process exit.
 */
import { Module } from '@nestjs/common';
import { SessionCoreModule } from './session-core.module.js';
import { SessionSpikeController } from './session-spike.controller.js';

@Module({
  imports: [SessionCoreModule],
  controllers: [SessionSpikeController],
})
export class SessionSpikeModule {}
