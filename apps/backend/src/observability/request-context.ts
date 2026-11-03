/**
 * Request correlation for H-013 (#13).
 *
 * A request id is an opaque, low-cardinality correlation handle. It is never
 * used for authorization and never carries user data: an inbound header is
 * accepted only when it matches `[A-Za-z0-9._-]{1,128}`, so header injection
 * (spaces, commas, newlines, JSON fragments) cannot reach the log line.
 *
 * Request ids also propagate through async work via AsyncLocalStorage so a
 * future run/provider call can correlate without threading the id everywhere.
 * Only the id is stored; no request body, headers, or identity is retained.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';

export const REQUEST_ID_HEADER = 'x-request-id';
export const MAX_REQUEST_ID_LENGTH = 128;
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/** Route label used when no Express route matched, e.g. a 404. */
export const UNMATCHED_ROUTE = '(unmatched)';

/** Structural subset of the Express response needed to echo a header. */
export interface HeaderTarget {
  setHeader(name: string, value: string): unknown;
  readonly headersSent?: boolean;
}

export interface RequestWithRequestId extends Request {
  /** Set by RequestLoggingMiddleware (or lazily by the exception filter). */
  requestId?: string;
}

export function isValidRequestId(value: unknown): value is string {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value);
}

export function generateRequestId(): string {
  return randomUUID();
}

/**
 * Accepts a single string header value. Repeated headers arrive as an array;
 * only the first element is considered, and anything invalid yields
 * `undefined` so the caller generates a fresh id.
 */
export function normalizeRequestId(raw: unknown): string | undefined {
  const candidate = Array.isArray(raw) ? raw[0] : raw;
  return isValidRequestId(candidate) ? candidate : undefined;
}

export function resolveRequestId(
  raw: unknown,
  generate: () => string = generateRequestId,
): string {
  return normalizeRequestId(raw) ?? generate();
}

const requestIdStorage = new AsyncLocalStorage<{ readonly requestId: string }>();

/** Runs `work` with `requestId` available to `currentRequestId()`. */
export function runWithRequestId<T>(requestId: string, work: () => T): T {
  return requestIdStorage.run({ requestId }, work);
}

export function currentRequestId(): string | undefined {
  return requestIdStorage.getStore()?.requestId;
}

/**
 * Echoes the correlation id on the response. Correlation is best-effort: a
 * response that cannot accept headers must not fail because of it.
 */
export function echoRequestId(requestId: string, response: HeaderTarget): void {
  try {
    if (response.headersSent === true) {
      return;
    }

    response.setHeader(REQUEST_ID_HEADER, requestId);
  } catch {
    // Never fail a request because the correlation header could not be set.
  }
}

export function attachRequestId(
  request: RequestWithRequestId,
  requestId: string,
): string {
  request.requestId = requestId;
  return requestId;
}

/**
 * Reads the id attached by the middleware, falling back to the inbound header
 * when the middleware did not run (for example in a unit test or a worker
 * context). Never returns the raw header value.
 */
export function requestIdOf(
  request: RequestWithRequestId,
  generate?: () => string,
): string {
  if (isValidRequestId(request.requestId)) {
    return request.requestId;
  }

  return attachRequestId(
    request,
    resolveRequestId(request.headers[REQUEST_ID_HEADER], generate),
  );
}

/**
 * Safe route label. The matched route pattern is used, never the raw path, so
 * identifiers embedded in a URL (`/runs/abc123`, `/files/<name>`) cannot leak
 * into logs. Unmatched requests collapse to one constant label.
 */
export function describeRoute(request: Request): string {
  const pattern =
    request.route !== undefined && typeof request.route.path === 'string'
      ? request.route.path
      : undefined;

  if (pattern === undefined) {
    return UNMATCHED_ROUTE;
  }

  const base = typeof request.baseUrl === 'string' ? request.baseUrl : '';
  const route = `${base}${pattern}`;

  return route === '' ? '/' : route;
}
