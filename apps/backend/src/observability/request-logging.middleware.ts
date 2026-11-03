/**
 * Per-request structured outcome logging for H-013 (#13).
 *
 * Emits exactly one of:
 *   - `request.completed` (status < 400)
 *   - `request.failed`    (status >= 400; warn for 4xx, error for 5xx)
 *   - `request.aborted`   (connection closed before the response finished)
 *
 * Fields are limited to method, matched route pattern, status, rounded
 * duration, and the validated request id. Query strings, headers, cookies,
 * bodies, and client addresses are never read, so no prompt or credential can
 * reach a log line from here. Duration and status come from the response, not
 * from the caller.
 *
 * Apply it as middleware in the composing module (see
 * ObservabilityModule for the wiring); this class is exported, not applied
 * globally by import.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { RequestMetrics } from './metrics.js';
import {
  attachRequestId,
  describeRoute,
  echoRequestId,
  resolveRequestId,
  runWithRequestId,
  REQUEST_ID_HEADER,
} from './request-context.js';
import type { RequestWithRequestId } from './request-context.js';
import { StructuredLogger } from './structured-logger.js';

export const REQUEST_COMPLETED_EVENT = 'request.completed';
export const REQUEST_FAILED_EVENT = 'request.failed';
export const REQUEST_ABORTED_EVENT = 'request.aborted';

@Injectable()
export class RequestLoggingMiddleware implements NestMiddleware {
  constructor(
    @Inject(StructuredLogger) private readonly logger: StructuredLogger,
    @Inject(RequestMetrics) private readonly metrics: RequestMetrics,
  ) {}

  use(request: Request, response: Response, next: NextFunction): void {
    const typed = request as RequestWithRequestId;
    const requestId = attachRequestId(
      typed,
      resolveRequestId(typed.headers[REQUEST_ID_HEADER]),
    );

    echoRequestId(requestId, response);
    this.metrics.beginRequest();

    const startedAt = process.hrtime.bigint();
    let settled = false;

    const settle = (outcome: 'finish' | 'abort'): void => {
      if (settled) {
        return;
      }

      settled = true;

      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const status = response.statusCode;
      this.metrics.endRequest(status, durationMs);

      const fields = {
        requestId,
        method: request.method,
        route: describeRoute(typed),
        status,
        durationMs: Math.round(durationMs * 1000) / 1000,
      };

      if (outcome === 'abort') {
        this.logger.warn(REQUEST_ABORTED_EVENT, fields);
        return;
      }

      if (status >= 500) {
        this.logger.error(REQUEST_FAILED_EVENT, fields);
        return;
      }

      if (status >= 400) {
        this.logger.warn(REQUEST_FAILED_EVENT, fields);
        return;
      }

      this.logger.info(REQUEST_COMPLETED_EVENT, fields);
    };

    response.on('finish', () => {
      settle('finish');
    });
    // `close` always follows `finish`; `settled` keeps aborts from double
    // counting. A close before the response finished is a client abort.
    response.on('close', () => {
      if (!response.writableFinished) {
        settle('abort');
      }
    });

    // The async context is inherited by everything the handler starts, so a
    // later run/provider layer can correlate without re-reading the header.
    runWithRequestId(requestId, () => {
      next();
    });
  }
}
