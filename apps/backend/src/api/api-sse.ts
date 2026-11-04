/**
 * Small SSE transport helpers for the Run event stream.
 *
 * The store/stream own ordering, ownership, dedupe, gaps, and termination. This
 * module only turns stream items into `text/event-stream` frames and resolves
 * the resume position from the standard `Last-Event-ID` header or a `seq`
 * query parameter.
 *
 * `id:` is the existing Run-bound event cursor, so a browser reconnect sends it
 * back automatically. A cursor for another Run is the same non-enumerating
 * not-found as a foreign Run.
 */
import type { Request, Response } from 'express';
import {
  decodeRunEventCursor,
  encodeRunEventCursor,
  normalizeAfterSeq,
} from '../events/validation.js';
import type { RunEventStreamItem } from '../events/types.js';
import {
  PersistenceNotFoundError,
  PersistenceValidationError,
} from '../persistence/errors.js';

function readLastEventId(request: Request): string | undefined {
  const header = request.headers['last-event-id'];

  if (header === undefined) {
    return undefined;
  }

  if (typeof header !== 'string') {
    throw new PersistenceValidationError('invalid_cursor');
  }

  return header;
}

function readSeqQuery(request: Request): string | undefined {
  const raw = request.query.seq;

  if (raw === undefined) {
    return undefined;
  }

  if (typeof raw !== 'string') {
    throw new PersistenceValidationError('invalid_cursor');
  }

  return raw;
}

/**
 * Resolves the exclusive replay cursor. `Last-Event-ID` takes precedence over
 * `?seq=`; both are validated before any response header is written, so a
 * malformed cursor is a clean 400 and a foreign Run is a clean 404.
 */
export function readResumeAfterSeq(request: Request, runId: string): number {
  const lastEventId = readLastEventId(request);

  if (lastEventId !== undefined && lastEventId.length > 0) {
    if (lastEventId.startsWith('e1.')) {
      const decoded = decodeRunEventCursor(lastEventId);

      if (decoded.runId !== runId) {
        throw new PersistenceNotFoundError();
      }

      return decoded.afterSeq;
    }

    if (!/^\d+$/.test(lastEventId)) {
      throw new PersistenceValidationError('invalid_cursor');
    }

    return normalizeAfterSeq(Number(lastEventId));
  }

  const seq = readSeqQuery(request);

  if (seq === undefined) {
    return 0;
  }

  if (!/^\d+$/.test(seq)) {
    throw new PersistenceValidationError('invalid_cursor');
  }

  return normalizeAfterSeq(Number(seq));
}

/** One named SSE event carrying the stored envelope as JSON. */
export function eventChunk(item: Extract<RunEventStreamItem, { kind: 'event' }>): string {
  const { event } = item;
  const id = encodeRunEventCursor(event.runId, event.seq);

  return `id: ${id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** Explicit hole marker; it never silently continues across a missing range. */
export function gapChunk(item: Extract<RunEventStreamItem, { kind: 'gap' }>): string {
  return `event: gap\ndata: ${JSON.stringify({
    runId: item.runId,
    fromSeq: item.fromSeq,
    toSeq: item.toSeq,
  })}\n\n`;
}

export function heartbeatChunk(): string {
  return ': keep-alive\n\n';
}

/**
 * Writes one chunk, waiting for drain when the socket buffer is full. A closed
 * response also resolves so a disconnected client cannot leave the loop
 * suspended.
 */
export function writeChunk(response: Response, chunk: string): Promise<void> {
  if (response.write(chunk)) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    const done = (): void => {
      response.off('drain', done);
      response.off('close', done);
      resolve();
    };

    response.once('drain', done);
    response.once('close', done);
  });
}
