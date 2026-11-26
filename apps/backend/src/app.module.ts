import { Module, RequestMethod } from '@nestjs/common';
import type { MiddlewareConsumer, NestModule } from '@nestjs/common';
import { P1ApiModule } from './api/api.module.js';
import { authSpikeModules } from './auth/auth-spike-modules.js';
import { HealthController } from './health/health.controller.js';
import { ObservabilityModule } from './observability/observability.module.js';
import { RequestLoggingMiddleware } from './observability/request-logging.middleware.js';
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
 * The module re-exports the process-wide `SessionCoreModule`, so when the chat
 * surface is also enabled both validate the same session records.
 */
const AUTH_SPIKE_MODULES = authSpikeModules();

/**
 * Chat composition gate (H-018): the `/api` surface is imported only when
 * HABI_P1_API=1. It is independent of the spike and auth gates: the flag adds
 * no auth/login routes. Importing it adds no product authentication either;
 * routes still require an H-017 session, and the session core is in-memory.
 */
const P1_API_MODULES = process.env.HABI_P1_API === '1' ? [P1ApiModule] : [];

/**
 * Observability (H-013) is always imported. It is the one module that must not
 * be flag-gated: it owns request logging, the request id echo, and the
 * catch-all exception filter that keeps stack traces and internal messages out
 * of a 5xx response. Gating it would mean an unobserved deployment, which is
 * exactly the gap this wiring closes.
 */
const OBSERVABILITY_MODULES = [
  ObservabilityModule.forRoot({ service: 'api' }),
];

@Module({
  controllers: [HealthController],
  imports: [
    ...OBSERVABILITY_MODULES,
    ...SPIKE_MODULES,
    ...SESSION_SPIKE_MODULES,
    ...AUTH_SPIKE_MODULES,
    ...P1_API_MODULES,
  ],
})
export class AppModule implements NestModule {
  /**
   * Applied to every route, including the ones the flag gates later add,
   * because the consumer is registered before those modules mount. Express 5
   * requires the named wildcard (`*splat`) rather than `'*'`.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(RequestLoggingMiddleware)
      .forRoutes({ path: '*splat', method: RequestMethod.ALL });
  }
}
