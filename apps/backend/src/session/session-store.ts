/**
 * Session persistence port.
 *
 * `SessionService` owns every lifecycle rule (expiry windows, rotation,
 * reuse detection, revocation vocabulary). A store only moves records between
 * the service and its backing medium, and never decides whether a session is
 * valid. That split is what lets the same service run over the in-memory store
 * and over PostgreSQL without a caller noticing.
 *
 * **Why the port is synchronous.** The session service is consumed synchronously
 * by the auth slice, the SSO bridge, the P-1 API guards and the H-017 spike
 * routes (`CoreSessionPort`, `SsoSessionBridge`, `SessionAuthGuard`). Making
 * these methods return promises would change the session contract for every
 * caller, which is exactly what durability must not do. A PostgreSQL store
 * therefore keeps a process-local record set that is authoritative while the
 * process runs, hydrates it from the table at start-up, and writes changes
 * behind the synchronous call. See `session-postgres-store.ts` for the
 * durability boundary that follows from this choice:
 *
 *   - restart survival is exact: every committed row is reloaded at start-up;
 *   - writes are ordered and flushed on shutdown, so a graceful restart loses
 *     nothing;
 *   - a hard kill can lose writes that had not reached the database yet;
 *   - one process is authoritative at a time. Two live processes do not share
 *     a hot cache, so a session created or revoked in one becomes visible in
 *     the other when that process restarts and rehydrates. The deployed stack
 *     runs one api process, and this is documented rather than hidden.
 */
import type { SessionRecord, SessionRevocationReason } from './session.service.js';

/** Injection token for the selected store. */
export const SESSION_STORE = Symbol('HABI_SESSION_STORE');

/**
 * Design §9 D7 proposed retired-verifier retention. Retired and expired rows
 * are kept this long so replay of a rotated secret can still be detected, and
 * are purged after it. Both stores use the same window.
 */
export const SESSION_RETIRED_RETENTION_MS = 24 * 60 * 60 * 1000;

export interface SessionStore {
  /** The record for a SHA-256 verifier, if this process knows it. */
  load(verifierHash: string): SessionRecord | undefined;
  /** Adds a freshly minted record. The verifier is the store key. */
  insert(verifierHash: string, record: SessionRecord): void;
  /** Persists mutations to an existing record (last-seen slide, revocation). */
  save(record: SessionRecord): void;
  /** Live records for one owner, oldest first; never another owner's rows. */
  listForUser(userId: string, at: number): SessionRecord[];
  /** Revokes every live record of one owner; returns how many it changed. */
  revokeAllForUser(userId: string, reason: SessionRevocationReason, at: number): number;
  /** Revokes every live record in one rotation family. */
  revokeFamily(familyId: string, reason: SessionRevocationReason, at: number): number;
  /**
   * Drops records that can no longer authenticate or detect reuse: revoked or
   * absolutely expired longer ago than the retention window. Returns how many
   * records it removed.
   */
  sweep(at: number): number;
  /** Completes outstanding writes. Never needed by a caller in steady state. */
  flush(): Promise<void>;
  /** Releases the store's own resources (a connection pool). */
  close(): Promise<void>;
}

/**
 * The non-durable store. This is the behaviour the session slice shipped with:
 * records live in a `Map` keyed by the SHA-256 verifier, so the raw secret is
 * never held as a key. It is the default when no database is configured, which
 * keeps the flag-gated slices and the H-017 fixture surface dependency-free.
 *
 * `save` is a no-op because callers mutate the record object the store handed
 * them; the object in the map is that same object.
 */
export class InMemorySessionStore implements SessionStore {
  private readonly records = new Map<string, SessionRecord>();

  load(verifierHash: string): SessionRecord | undefined {
    return this.records.get(verifierHash);
  }

  insert(verifierHash: string, record: SessionRecord): void {
    this.records.set(verifierHash, record);
  }

  save(_record: SessionRecord): void {
    // The map already holds this object; mutations are visible without a copy.
  }

  listForUser(userId: string, at: number): SessionRecord[] {
    return [...this.records.values()]
      .filter((record) => record.userId === userId && isLive(record, at))
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  revokeAllForUser(userId: string, reason: SessionRevocationReason, at: number): number {
    return this.revokeWhere((record) => record.userId === userId, reason, at);
  }

  revokeFamily(familyId: string, reason: SessionRevocationReason, at: number): number {
    return this.revokeWhere((record) => record.familyId === familyId, reason, at);
  }

  sweep(at: number): number {
    let removed = 0;

    for (const [verifier, record] of this.records) {
      if (isPastRetention(record, at)) {
        this.records.delete(verifier);
        removed += 1;
      }
    }

    return removed;
  }

  async flush(): Promise<void> {
    // Nothing is buffered.
  }

  async close(): Promise<void> {
    // Nothing is held.
  }

  private revokeWhere(
    predicate: (record: SessionRecord) => boolean,
    reason: SessionRevocationReason,
    at: number,
  ): number {
    let revoked = 0;

    for (const record of this.records.values()) {
      if (record.revokedAt === null && predicate(record)) {
        record.revokedAt = at;
        record.revokedReason = reason;
        revoked += 1;
      }
    }

    return revoked;
  }
}

/** A record that may still authenticate at `at`. */
export function isLive(record: SessionRecord, at: number): boolean {
  return record.revokedAt === null && at < record.idleExpiresAt && at < record.absoluteExpiresAt;
}

/**
 * True when a record is old enough for the retention window to have passed:
 * it was revoked, or it expired, at least one retention window before `at`.
 */
export function isPastRetention(record: SessionRecord, at: number): boolean {
  const retiredLongAgo =
    record.revokedAt !== null && at - record.revokedAt >= SESSION_RETIRED_RETENTION_MS;
  const expiredLongAgo = at - record.absoluteExpiresAt >= SESSION_RETIRED_RETENTION_MS;

  return retiredLongAgo || expiredLongAgo;
}
