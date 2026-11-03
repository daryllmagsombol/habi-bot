/**
 * H-020 (#20) RunEventStream: replay plus live subscription over persisted
 * events.
 *
 * Guarantees:
 *   - Persisted events are delivered in `seq` order; the store, not a buffer, is
 *     the source of truth.
 *   - A reconnect replays from `afterSeq` (or an encoded cursor) and a
 *     subscription shared from the same stream instance dedupes `(runId, seq)`,
 *     so a client that reconnects slightly behind does not see duplicate
 *     output.
 *   - A missing sequence range is surfaced as an explicit `gap` item; the
 *     stream never silently jumps over a hole.
 *   - The stream ends after the terminal event. A terminal event already at or
 *     before the cursor ends an empty subscription immediately.
 *   - Every subscription resolves the Run for `actorUserId` before reading, so
 *     a foreign Run or foreign cursor is a non-enumerating not-found.
 *
 * Delivery is at-least-once. The process-local hub only wakes a subscriber; it
 * carries no event data. Multi-replica fan-out needs a durable bus later, and
 * reconnect after a process restart relies on the persisted cursor, not on the
 * in-memory dedupe set. No HTTP/SSE transport is implemented in this slice.
 */
import {
  PersistenceNotFoundError,
  PersistenceValidationError,
} from '../persistence/errors.js';
import { requireActorUserId, requireResourceId } from '../persistence/rows.js';
import type { RunEventStore } from './run-event-store.js';
import type {
  RunEventEnvelope,
  RunEventStreamItem,
} from './types.js';
import { isTerminalRunEventType } from './types.js';
import {
  decodeRunEventCursor,
  normalizeAfterSeq,
  normalizeReplayLimit,
} from './validation.js';

export interface RunEventSubscribeOptions {
  /** Authenticated actor from the session boundary. Never a client owner id. */
  actorUserId: string;
  runId: string;
  /** Exclusive replay cursor; defaults to 0. */
  afterSeq?: number;
  /** Run-bound cursor. Rejected when it names a different Run. */
  cursor?: string;
  /** Page bound for replay; the store clamps it. */
  limit?: number;
  signal?: AbortSignal;
}

interface QueueWaiter {
  resolve: (result: IteratorResult<RunEventStreamItem>) => void;
  reject: (error: unknown) => void;
}

/**
 * One instance represents one logical consumer (for example one client
 * connection and its reconnects). Its subscriptions share the dedupe set, so a
 * reconnect suppresses events this consumer already saw even when its cursor
 * lagged behind. Independent consumers must use separate instances, otherwise
 * one consumer's delivery would suppress another's replay.
 */
export class RunEventStream {
  /**
   * Delivered sequences per Run, shared by subscriptions from this instance.
   * A reconnect using the same stream instance suppresses events the consumer
   * already saw even if its cursor lagged behind.
   */
  private readonly delivered = new Map<string, Set<number>>();

  constructor(private readonly store: RunEventStore) {}

  subscribe(options: RunEventSubscribeOptions): RunEventSubscription {
    return new RunEventSubscription(this.store, this.delivered, options);
  }

  /** Diagnostic: how many sequences this instance remembers for one Run. */
  deliveredCount(runId: string): number {
    return this.delivered.get(runId)?.size ?? 0;
  }
}

class RunEventSubscription
  implements AsyncIterableIterator<RunEventStreamItem>
{
  private readonly actorUserId: string;
  private readonly runId: string;
  private readonly limit: number;
  private readonly signal: AbortSignal | null;
  private readonly delivered: Set<number>;

  private readonly items: RunEventStreamItem[] = [];
  private readonly waiters: QueueWaiter[] = [];
  private afterSeq = 0;
  private done = false;
  private closed = false;
  private error: unknown = null;
  private notified = false;
  private wake: (() => void) | null = null;
  private unsubscribe: (() => void) | null = null;
  private abortListener: (() => void) | null = null;

  constructor(
    private readonly store: RunEventStore,
    delivered: Map<string, Set<number>>,
    options: RunEventSubscribeOptions,
  ) {
    this.actorUserId = requireActorUserId(options.actorUserId);
    this.runId = requireResourceId(options.runId);
    this.limit = normalizeReplayLimit(options.limit);
    this.signal = options.signal ?? null;

    // Validate a cursor synchronously so a malformed cursor fails at subscribe
    // time rather than after ownership has been resolved.
    if (options.cursor !== undefined) {
      if (options.afterSeq !== undefined) {
        throw new PersistenceValidationError('invalid_input');
      }

      const decoded = decodeRunEventCursor(options.cursor);
      // A cursor bound to another Run is the same not-found as a foreign Run.
      if (decoded.runId !== this.runId) {
        throw new PersistenceNotFoundError();
      }

      this.afterSeq = decoded.afterSeq;
    } else {
      this.afterSeq = normalizeAfterSeq(options.afterSeq ?? 0);
    }

    const existing = delivered.get(this.runId);
    this.delivered = existing ?? new Set<number>();
    delivered.set(this.runId, this.delivered);

    void this.start();
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<RunEventStreamItem> {
    return this;
  }

  next(): Promise<IteratorResult<RunEventStreamItem>> {
    if (this.items.length > 0) {
      return Promise.resolve({
        value: this.items.shift() as RunEventStreamItem,
        done: false,
      });
    }

    if (this.error !== null) {
      return Promise.reject(this.error);
    }

    if (this.done) {
      return Promise.resolve({ value: undefined, done: true });
    }

    return new Promise<IteratorResult<RunEventStreamItem>>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  async return(): Promise<IteratorResult<RunEventStreamItem>> {
    this.close();
    return { value: undefined, done: true };
  }

  close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.stopListening();
    this.finish();
  }

  private async start(): Promise<void> {
    if (this.closed) {
      return;
    }

    try {
      if (this.signal?.aborted === true) {
        this.close();
        return;
      }

      if (this.signal !== null) {
        const onAbort = () => {
          this.close();
        };
        this.abortListener = onAbort;
        this.signal.addEventListener('abort', onAbort, { once: true });
      }

      const position = await this.store.loadPosition(
        this.actorUserId,
        this.runId,
      );

      // Close/abort while the ownership lookup was in flight must not attach a
      // listener after finish() already ran.
      if (this.closed) {
        return;
      }

      // A cursor beyond the stored stream cannot come from this Run.
      if (this.afterSeq > position.lastEventSeq) {
        throw new PersistenceNotFoundError();
      }

      // Nothing left to observe: the terminal event is already at/before the
      // reconnect cursor.
      if (
        position.terminalEventSeq !== null
        && position.terminalEventSeq <= this.afterSeq
      ) {
        this.finish();
        return;
      }

      // Attach before the first replay read so an append between read and wait
      // is not missed. The hub carries no data; a wake-up just re-reads.
      this.unsubscribe = this.store.hub.subscribe(this.runId, () => {
        this.notified = true;
        const wake = this.wake;
        this.wake = null;
        wake?.();
      });

      while (!this.closed) {
        const page = await this.store.read(this.actorUserId, this.runId, {
          afterSeq: this.afterSeq,
          limit: this.limit,
        });

        if (this.closed) {
          return;
        }

        if (page.events.length === 0 && page.lastEventSeq > this.afterSeq) {
          // The allocator advanced but no row is readable for the requested
          // range: retention removed it or the row set is inconsistent. Mark
          // the hole and advance rather than spin forever.
          this.pushGap(this.afterSeq + 1, page.lastEventSeq);
          this.afterSeq = page.lastEventSeq;
        }

        for (const event of page.events) {
          if (event.seq <= this.afterSeq) {
            continue;
          }

          if (event.seq > this.afterSeq + 1) {
            this.pushGap(this.afterSeq + 1, event.seq - 1);
          }

          this.afterSeq = event.seq;

          if (this.remember(event)) {
            this.push({ kind: 'event', event });
          }

          if (isTerminalRunEventType(event.type)) {
            this.stopListening();
            this.finish();
            return;
          }
        }

        if (page.hasMore) {
          continue;
        }

        if (
          page.terminalEventSeq !== null
          && page.terminalEventSeq <= this.afterSeq
        ) {
          // The terminal event was deduped after reconnect.
          this.stopListening();
          this.finish();
          return;
        }

        if (this.notified) {
          this.notified = false;
          continue;
        }

        await this.waitForNotification();

        if (this.closed) {
          return;
        }
      }
    } catch (error) {
      if (!this.closed) {
        this.fail(error);
      }
    }
  }

  private pushGap(fromSeq: number, toSeq: number): void {
    this.push({ kind: 'gap', runId: this.runId, fromSeq, toSeq });
  }

  private push(item: RunEventStreamItem): void {
    const waiter = this.waiters.shift();

    if (waiter !== undefined) {
      waiter.resolve({ value: item, done: false });
      return;
    }

    this.items.push(item);
  }

  /** Marks `(runId, seq)` delivered; false when it was already seen. */
  private remember(event: RunEventEnvelope): boolean {
    if (this.delivered.has(event.seq)) {
      return false;
    }

    this.delivered.add(event.seq);
    return true;
  }

  private waitForNotification(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.wake = resolve;
    });
  }

  private stopListening(): void {
    if (this.unsubscribe !== null) {
      this.unsubscribe();
      this.unsubscribe = null;
    }

    if (this.abortListener !== null && this.signal !== null) {
      this.signal.removeEventListener('abort', this.abortListener);
      this.abortListener = null;
    }
  }

  private finish(): void {
    if (this.done) {
      return;
    }

    this.done = true;
    this.stopListening();
    this.releaseWake();
    this.flushWaiters();
  }

  private fail(error: unknown): void {
    if (this.done) {
      return;
    }

    this.error = error;
    this.done = true;
    this.stopListening();
    this.releaseWake();

    while (this.waiters.length > 0) {
      this.waiters.shift()?.reject(error);
    }
  }

  /** Lets a close/abort end the replay loop instead of leaving it suspended. */
  private releaseWake(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  private flushWaiters(): void {
    while (this.waiters.length > 0) {
      this.waiters.shift()?.resolve({ value: undefined, done: true });
    }
  }
}

