/**
 * JSON polling fallback for the Run event stream (H-020 gap).
 *
 * SSE stays the live transport. When a client cannot hold an event stream (a
 * sleeping mobile tab, a buffering proxy), it polls the same
 * `GET /api/runs/:runId/events` route with `?after=<seq>&limit=<n>` and
 * advances the same exclusive cursor it would have carried in `Last-Event-ID`.
 * Ordering, cursor scope, ownership, and terminal replay all come from
 * `RunEventStore.read`, so polling and SSE can never disagree about what
 * `afterSeq` means. The page bound is smaller than the store default: one
 * fallback request stays bounded (default 50, ceiling 200) and the client
 * follows `hasMore`.
 *
 * No owner, id, or lifecycle is read from the request. Like the stream, the
 * controller resolves the Run for the actor first, so a foreign, unknown, or
 * malformed Run id is the same non-enumerating `not_found`; only after
 * ownership is proven does a malformed cursor become `invalid_cursor`.
 */
import { HttpStatus } from '@nestjs/common';
import type { Request, Response } from 'express';
import { PersistenceValidationError } from '../persistence/errors.js';
import type { RunEventEnvelope, RunEventReplayPage } from '../events/types.js';
import {
  DEFAULT_POLL_LIMIT,
  normalizeAfterSeq,
  normalizePollLimit,
} from '../events/validation.js';

export interface RunEventPollQuery {
  /** Exclusive cursor: the first returned event has `seq > afterSeq`. */
  afterSeq: number;
  /** Bounded page size, already clamped to the polling ceiling. */
  limit: number;
}

export interface RunEventPollPage {
  runId: string;
  /** Echoes the effective exclusive cursor for this page. */
  afterSeq: number;
  events: RunEventEnvelope[];
  /** More persisted events exist after this page. */
  hasMore: boolean;
  lastEventSeq: number;
  terminalEventSeq: number | null;
}

const UNSIGNED_INTEGER = /^\d+$/;
const JSON_ACCEPT = /application\/json/;
const SSE_ACCEPT = /text\/event-stream/;

/**
 * True when the request wants a JSON page rather than an event stream: an
 * explicit `after`/`limit` query, or an `Accept` that names JSON without
 * naming the stream. A bare `*‍/*` and the BFF's stream accept stay on SSE, so
 * existing stream clients see no behavior change.
 */
export function isRunEventPollRequest(request: Request): boolean {
  if (request.query.after !== undefined || request.query.limit !== undefined) {
    return true;
  }

  const accept = request.headers.accept ?? '';

  return JSON_ACCEPT.test(accept) && !SSE_ACCEPT.test(accept);
}

function readUnsignedParam(
  value: unknown,
  code: 'invalid_input' | 'invalid_cursor',
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string' || !UNSIGNED_INTEGER.test(value)) {
    throw new PersistenceValidationError(code);
  }

  return value;
}

function readAfterParam(value: unknown): number {
  const raw = readUnsignedParam(value, 'invalid_cursor');

  if (raw === undefined) {
    return 0;
  }

  return normalizeAfterSeq(Number(raw));
}

function readLimitParam(value: unknown): number {
  const raw = readUnsignedParam(value, 'invalid_input');

  if (raw === undefined) {
    return DEFAULT_POLL_LIMIT;
  }

  return normalizePollLimit(Number(raw));
}

/**
 * Parses `?after=&limit=`. Call only after the Run was resolved for the
 * actor, so a malformed cursor on a foreign Run still answers `not_found`.
 */
export function readRunEventPollQuery(request: Request): RunEventPollQuery {
  return {
    afterSeq: readAfterParam(request.query.after),
    limit: readLimitParam(request.query.limit),
  };
}

export function toRunEventPollPage(page: RunEventReplayPage): RunEventPollPage {
  return {
    runId: page.runId,
    afterSeq: page.afterSeq,
    events: page.events,
    hasMore: page.hasMore,
    lastEventSeq: page.lastEventSeq,
    terminalEventSeq: page.terminalEventSeq,
  };
}

/** Answers the poll as a no-store JSON page. */
export function sendRunEventPollPage(
  response: Response,
  page: RunEventPollPage,
): void {
  response.status(HttpStatus.OK);
  response.setHeader('cache-control', 'no-store');
  response.json(page);
}
