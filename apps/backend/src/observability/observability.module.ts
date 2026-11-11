/**
 * Observability module for H-013 (#13), first slice.
 *
 * Importable but not yet imported: `AppModule`/`main.ts` are owned by another
 * lane, so this module registers providers and exports them without applying
 * middleware or a global filter itself. The composing module must do both:
 *
 *   imports: [ObservabilityModule.forRoot({ service: 'api' })]
 *
 *   configure(consumer: MiddlewareConsumer) {
 *     consumer
 *       .apply(RequestLoggingMiddleware)
 *       .forRoutes({ path: '*splat', method: RequestMethod.ALL });
 *   }
 *
 *   // in bootstrap, after create():
 *   app.useGlobalFilters(app.get(HttpExceptionFilter));
 *
 * Express 5 requires the named wildcard (`*splat`) rather than `'*'`.
 * Applying middleware from this module would silently change every route, so
 * the choice stays with the composing module.
 *
 * Metrics are in-process only: counts by status class, in-flight gauge, and a
 * duration sum/count. `RequestMetrics.toPrometheus()` formats them but no HTTP
 * route exposes them yet.
 */
import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { HttpExceptionFilter } from './http-exception.filter.js';
import { RequestMetrics, RunMetrics } from './metrics.js';
import { normalizeObservabilityConfig, OBSERVABILITY_CONFIG } from './observability-config.js';
import type { ObservabilityModuleOptions } from './observability-config.js';
import { RequestLoggingMiddleware } from './request-logging.middleware.js';
import { StructuredLogger } from './structured-logger.js';

@Module({})
export class ObservabilityModule {
  static forRoot(options: ObservabilityModuleOptions): DynamicModule {
    const config = normalizeObservabilityConfig(options);

    return {
      module: ObservabilityModule,
      providers: [
        { provide: OBSERVABILITY_CONFIG, useValue: config },
        StructuredLogger,
        RequestMetrics,
        RunMetrics,
        RequestLoggingMiddleware,
        HttpExceptionFilter,
      ],
      exports: [
        OBSERVABILITY_CONFIG,
        StructuredLogger,
        RequestMetrics,
        RunMetrics,
        RequestLoggingMiddleware,
        HttpExceptionFilter,
      ],
    };
  }
}
