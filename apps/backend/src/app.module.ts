import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller.js';
import { SessionSpikeModule } from './session/session-spike.module.js';
import { SpikeModule } from './spike/spike.module.js';

/**
 * Spike-only gate: the ownership spike is imported only when
 * HABI_SPIKE_MODE=1. When the flag is unset or any other value, the spike
 * module is never imported and its routes do not exist.
 */
const SPIKE_MODULES = process.env.HABI_SPIKE_MODE === '1' ? [SpikeModule] : [];

/**
 * Session-contract gate: the H-017 session slice is imported only when
 * HABI_SESSION_SPIKE=1. It is independent of HABI_SPIKE_MODE so neither
 * surface enables the other.
 */
const SESSION_SPIKE_MODULES =
  process.env.HABI_SESSION_SPIKE === '1' ? [SessionSpikeModule] : [];

@Module({
  controllers: [HealthController],
  imports: [...SPIKE_MODULES, ...SESSION_SPIKE_MODULES],
})
export class AppModule {}
