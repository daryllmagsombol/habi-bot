/**
 * Spike-only. Not product code. Enabled only when HABI_SPIKE_MODE=1.
 *
 * Registers the two-user ownership spike surface. `AppModule` imports this
 * module only when the flag is set, so the default app has no spike routes.
 */
import { Module } from '@nestjs/common';
import { SpikeAuthGuard } from './spike-auth.guard.js';
import { SpikeRunsController } from './spike-runs.controller.js';
import { SpikeRunsService } from './spike-runs.service.js';

@Module({
  controllers: [SpikeRunsController],
  providers: [SpikeRunsService, SpikeAuthGuard],
})
export class SpikeModule {}
