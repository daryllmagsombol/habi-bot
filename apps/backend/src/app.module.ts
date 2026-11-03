import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller.js';
import { SpikeModule } from './spike/spike.module.js';

/**
 * Spike-only gate: the ownership spike is imported only when
 * HABI_SPIKE_MODE=1. When the flag is unset or any other value, the spike
 * module is never imported and its routes do not exist.
 */
const SPIKE_MODULES = process.env.HABI_SPIKE_MODE === '1' ? [SpikeModule] : [];

@Module({
  controllers: [HealthController],
  imports: SPIKE_MODULES,
})
export class AppModule {}
