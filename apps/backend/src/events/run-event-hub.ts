/**
 * In-process Run event notification fan-out.
 *
 * The hub carries no event data: an append persists first, then publishes the
 * Run id. A subscriber re-reads the store from its cursor, so a duplicate or
 * missed notification cannot lose or reorder persisted events.
 *
 * This is deliberately process-local. Multi-replica streaming needs a durable
 * bus (PostgreSQL LISTEN/NOTIFY, Redis, or a queue) so an append in one process
 * wakes a subscriber in another. That bus is not implemented in this slice.
 */

export type RunEventListener = () => void;

export class RunEventHub {
  private readonly listeners = new Map<string, Set<RunEventListener>>();

  /** Subscribes one listener. The returned function is idempotent. */
  subscribe(runId: string, listener: RunEventListener): () => void {
    const listeners = this.listeners.get(runId) ?? new Set<RunEventListener>();
    listeners.add(listener);
    this.listeners.set(runId, listeners);

    let active = true;

    return () => {
      if (!active) {
        return;
      }

      active = false;
      const current = this.listeners.get(runId);

      if (current === undefined) {
        return;
      }

      current.delete(listener);

      if (current.size === 0) {
        this.listeners.delete(runId);
      }
    };
  }

  /**
   * Notifies subscribers after a committed append. A throwing listener must not
   * fail the append or starve the other listeners, so failures are isolated.
   */
  publish(runId: string): void {
    const listeners = this.listeners.get(runId);

    if (listeners === undefined) {
      return;
    }

    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // A listener rebuilds from storage; missing this wake-up is visible as
        // latency, not as lost or reordered events.
      }
    }
  }

  /** Test/diagnostic visibility into leaked subscriptions. */
  listenerCount(runId?: string): number {
    if (runId !== undefined) {
      return this.listeners.get(runId)?.size ?? 0;
    }

    let total = 0;

    for (const listeners of this.listeners.values()) {
      total += listeners.size;
    }

    return total;
  }
}
