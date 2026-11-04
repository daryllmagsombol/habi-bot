import { Module } from '@nestjs/common';
import { P1ApiModule } from './api/api.module.js';
import { authSpikeModules } from './auth/auth-spike-modules.js';
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

/**
 * Auth-identity gate: the H-014 slice is imported only when HABI_AUTH_SPIKE=1.
 */
const AUTH_SPIKE_MODULES = authSpikeModules();

/**
 * Chat composition gate (H-018): the `/api` surface is imported only when
 * HABI_P1_API=1. It is independent of the spike and auth gates. Importing it
 * adds no product authentication: routes still require an H-017 session, and
 * the session core is in-memory.
 */
const P1_API_MODULES = process.env.HABI_P1_API === '1' ? [P1ApiModule] : [];

@Module({
  controllers: [HealthController],
  imports: [
    ...SPIKE_MODULES,
    ...SESSION_SPIKE_MODULES,
    ...AUTH_SPIKE_MODULES,
    ...P1_API_MODULES,
  ],
})
export class AppModule {}
