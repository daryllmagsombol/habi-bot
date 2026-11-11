/**
 * Bounded input rules for the event store and replay cursor.
 *
 * Every rejection is either `invalid_input` (malformed client data after the
 * Run was resolved) or `invalid_cursor` (a cursor that cannot be decoded).
 * Neither error reveals whether a resource exists.
 */
import { isUuid } from '../persistence/cursor.js';
import { PersistenceValidationError } from '../persistence/errors.js';
import type { RunEventType } from './types.js';

const RUN_EVENT_CURSOR_PREFIX = 'e1.';

export const DEFAULT_EVENT_REPLAY_LIMIT = 200;
/** Hard ceiling so one replay/page cannot exhaust memory. */
export const MAX_EVENT_REPLAY_LIMIT = 1000;
/** 64 KiB is far below a prompt and keeps a hostile payload bounded. */
export const MAX_EVENT_PAYLOAD_BYTES = 64 * 1024;
export const MAX_EVENT_TYPE_LENGTH = 120;
export const MAX_EVENT_CURSOR_LENGTH = 256;

const EVENT_TYPE_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]*$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const CURSOR_BODY_PATTERN = /^(\d{1,19}):([0-9a-f-]{36})$/;

export function normalizeEventType(type: unknown): RunEventType {
  if (typeof type !== 'string') {
    throw new PersistenceValidationError('invalid_input');
  }

  const trimmed = type.trim();

  if (
    trimmed.length === 0
    || trimmed.length > MAX_EVENT_TYPE_LENGTH
    || !EVENT_TYPE_PATTERN.test(trimmed)
  ) {
    throw new PersistenceValidationError('invalid_input');
  }

  return trimmed;
}

export function normalizeEventId(eventId: unknown): string | undefined {
  if (eventId === undefined) {
    return undefined;
  }

  if (!isUuid(eventId)) {
    throw new PersistenceValidationError('invalid_input');
  }

  return eventId;
}

export function serializeEventPayload(
  payload: Readonly<Record<string, unknown>> | undefined,
): string {
  if (payload === undefined) {
    return '{}';
  }

  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new PersistenceValidationError('invalid_input');
  }

  let serialized: string | undefined;

  try {
    serialized = JSON.stringify(payload);
  } catch {
    // A circular payload is a programming error, not a retryable condition.
    throw new PersistenceValidationError('invalid_input');
  }

  if (serialized === undefined) {
    throw new PersistenceValidationError('invalid_input');
  }

  if (Buffer.byteLength(serialized, 'utf8') > MAX_EVENT_PAYLOAD_BYTES) {
    throw new PersistenceValidationError('invalid_input');
  }

  return serialized;
}

export function normalizeAfterSeq(afterSeq: unknown): number {
  if (
    typeof afterSeq !== 'number'
    || !Number.isSafeInteger(afterSeq)
    || afterSeq < 0
  ) {
    throw new PersistenceValidationError('invalid_cursor');
  }

  return afterSeq;
}

export function normalizeReplayLimit(
  limit: unknown,
  maximum = MAX_EVENT_REPLAY_LIMIT,
): number {
  if (limit === undefined) {
    return Math.min(DEFAULT_EVENT_REPLAY_LIMIT, maximum);
  }

  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1) {
    throw new PersistenceValidationError('invalid_input');
  }

  return Math.min(limit, maximum);
}

/**
 * HTTP polling page bound. The store default (200) would let one fallback
 * request materialize a large transcript; the polling transport keeps pages
 * small (default 50, ceiling 200) and the client follows `hasMore`.
 */
export const DEFAULT_POLL_LIMIT = 50;
/** Hard ceiling for one polling page. */
export const MAX_POLL_LIMIT = 200;

export function normalizePollLimit(limit: unknown): number {
  if (limit === undefined) {
    return DEFAULT_POLL_LIMIT;
  }

  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1) {
    throw new PersistenceValidationError('invalid_input');
  }

  return Math.min(limit, MAX_POLL_LIMIT);
}

export interface DecodedRunEventCursor {
  runId: string;
  afterSeq: number;
}

/**
 * Encodes the Run binding with the exclusive sequence cursor. The cursor is an
 * ordering hint only: every read still checks owner and Run scope, and a
 * cursor decoded for a different Run is rejected before any event is read.
 */
export function encodeRunEventCursor(runId: string, afterSeq: number): string {
  if (!isUuid(runId)) {
    throw new PersistenceValidationError('invalid_input');
  }

  const seq = normalizeAfterSeq(afterSeq);
  const body = `${seq}:${runId}`;

  return `${RUN_EVENT_CURSOR_PREFIX}${Buffer.from(body, 'utf8').toString('base64url')}`;
}

export function decodeRunEventCursor(cursor: unknown): DecodedRunEventCursor {
  if (
    typeof cursor !== 'string'
    || cursor.length === 0
    || cursor.length > MAX_EVENT_CURSOR_LENGTH
    || !cursor.startsWith(RUN_EVENT_CURSOR_PREFIX)
  ) {
    throw new PersistenceValidationError('invalid_cursor');
  }

  const encoded = cursor.slice(RUN_EVENT_CURSOR_PREFIX.length);

  if (!BASE64URL_PATTERN.test(encoded)) {
    throw new PersistenceValidationError('invalid_cursor');
  }

  let decoded: string;

  try {
    decoded = Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    throw new PersistenceValidationError('invalid_cursor');
  }

  const match = CURSOR_BODY_PATTERN.exec(decoded);

  if (match === null) {
    throw new PersistenceValidationError('invalid_cursor');
  }

  const rawSeq = match[1];
  const runId = match[2];

  if (rawSeq === undefined || runId === undefined || !isUuid(runId)) {
    throw new PersistenceValidationError('invalid_cursor');
  }

  const afterSeq = Number(rawSeq);

  if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
    throw new PersistenceValidationError('invalid_cursor');
  }

  return { runId, afterSeq };
}
