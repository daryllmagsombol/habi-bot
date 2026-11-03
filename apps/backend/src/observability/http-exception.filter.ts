/**
 * Catch-all HTTP exception filter for H-013 (#13).
 *
 * Response contract:
 *   - 5xx: `{error: {code, requestId}}`. No stack, no internal message, no
 *     exception payload passthrough. Only an app-authored, pattern-valid code
 *     is preserved; anything else becomes `internal_error`.
 *   - 4xx: the existing shape is preserved. Nest object payloads from
 *     `HttpException({error: {code}})` (used by the session/spike guards) pass
 *     through unchanged; a string payload becomes
 *     `{error: {code: "request_invalid", message}}` with the message scrubbed.
 *
 * `x-request-id` is echoed on the response so a client can correlate even
 * when the body shape carries no id (4xx pass-through). The exception itself
 * is logged once as `request.exception`; the middleware logs the terminal
 * `request.failed` with status and duration.
 */
import { Catch, HttpException, Inject, Injectable } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { requestIdOf, echoRequestId, describeRoute } from './request-context.js';
import type { RequestWithRequestId } from './request-context.js';
import { sanitizeErrorMessage, StructuredLogger } from './structured-logger.js';

export const REQUEST_EXCEPTION_EVENT = 'request.exception';
export const INTERNAL_ERROR_CODE = 'internal_error';
export const REQUEST_INVALID_CODE = 'request_invalid';

const ERROR_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

@Catch()
@Injectable()
export class HttpExceptionFilter implements ExceptionFilter {
  constructor(@Inject(StructuredLogger) private readonly logger: StructuredLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<RequestWithRequestId>();

    if (response.headersSent) {
      // The response is already on the wire; rewriting it would corrupt the
      // body. Let the adapter's default handling stand.
      return;
    }

    const status = statusOf(exception);
    const requestId = requestIdOf(request);

    echoRequestId(requestId, response);

    this.logger.error(REQUEST_EXCEPTION_EVENT, {
      requestId,
      method: request.method,
      route: describeRoute(request),
      status,
      error: exception,
    });

    response.status(status).json(errorBody(exception, status, requestId));
  }
}

function statusOf(exception: unknown): number {
  if (!(exception instanceof HttpException)) {
    return 500;
  }

  const status = exception.getStatus();
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
}

function errorBody(
  exception: unknown,
  status: number,
  requestId: string,
): Record<string, unknown> {
  const payload = exception instanceof HttpException ? exception.getResponse() : undefined;

  if (status >= 500) {
    return {
      error: {
        code: readApiErrorCode(payload) ?? INTERNAL_ERROR_CODE,
        requestId,
      },
    };
  }

  // 4xx: preserve an existing JSON error shape exactly. Guards and services in
  // this app already throw `{error: {code}}` objects.
  if (isRecord(payload)) {
    return payload;
  }

  const code = readApiErrorCode(payload) ?? REQUEST_INVALID_CODE;

  if (typeof payload === 'string' && payload.trim() !== '') {
    return {
      error: { code, message: sanitizeErrorMessage(payload) },
    };
  }

  return { error: { code } };
}

/** Accepts `{error: {code}}` or `{code}`; rejects anything else. */
function readApiErrorCode(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const nested = value['error'];
  const candidate = isRecord(nested) ? nested['code'] : value['code'];

  return typeof candidate === 'string' && ERROR_CODE_PATTERN.test(candidate)
    ? candidate
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
