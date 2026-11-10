/**
 * PostgreSQL-backed session store.
 *
 * Same lifecycle rules as `InMemorySessionStore`; only the medium changes. The
 * table is `auth_sessions` (migration 0019) and it never holds a usable
 * credential:
 *
 *   - the row key is `verifier_hash` = SHA-256 hex of the opaque session
 *     secret, so a database dump cannot be replayed as a cookie;
 *   - CSRF material is `csrf_hash` = SHA-256 hex of the token, compared in
 *     constant time, so the raw token is not recoverable at rest;
 *   - observer values are salted hashes and are never read by a decision.
 *
 * **Durability boundary.** The synchronous `SessionStore` port (see
 * `session-store.ts` for why it is synchronous) means this store runs as an
 * ordered write-behind cache:
 *
 *   1. At module start-up `hydrate()` loads every row that can still
 *      authenticate or detect reuse, so a restarted process serves sessions
 *      issued by the previous one.
 *   2. Reads are served from the process record set.
 *   3. Every mutation is queued and executed in order on one connection, so an
 *      insert always lands before the update that revokes it.
 *   4. `onModuleDestroy` flushes the queue and closes the pool, so a graceful
 *      restart loses nothing.
 *
 * What that does and does not promise:
 *
 *   - a restart no longer drops every session: that is the gap this closes;
 *   - a hard kill can lose queued writes not yet committed, and a failed
 *     revocation write is reported (never silently treated as successful) —
 *     the process still refuses the session locally;
 *   - an insert that cannot be persisted is forgotten locally, so a session
 *     that the database does not know can never authenticate;
 *   - one process is authoritative at a time. A process that was already
 *     running when another process created or revoked a session does not see
 *     that change until it restarts and rehydrates. The deployed stack runs a
 *     single api process, so this is the boundary of the guarantee, stated
 *     rather than hidden.
 *     `revokeAllForUser`/`revokeFamily` still issue an owner/family-wide
 *     UPDATE, so the durable row set is corrected for rows this process never
 *     cached.
 */
import { Logger } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Pool } from 'pg';
import { createPersistencePool } from '../persistence/database.js';
import { SESSION_RETIRED_RETENTION_MS, isPastRetention } from './session-store.js';
import type { SessionStore } from './session-store.js';
import { csrfDigest, isSessionRevocationReason } from './session.service.js';
import type { SessionRecord, SessionRevocationReason } from './session.service.js';

const RECORD_ID_PREFIX = 'sess_';
const FAMILY_ID_PREFIX = 'fam_';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Bounded retry for one queued write. A transient failure is retried before
 * the store gives up, reports it, and (for an insert) forgets the record.
 */
const WRITE_ATTEMPTS = 3;

/** Columns read on hydration and by the mapping helper below. */
const SELECT_COLUMNS = `id,
       session_family_id,
       verifier_hash,
       owner_user_id,
       created_at,
       last_seen_at,
       idle_expires_at,
       absolute_expires_at,
       rotated_from_id,
       revoked_at,
       revoked_reason,
       csrf_hash,
       user_agent_hash,
       ip_hash`;

interface SessionRow {
  id: string;
  session_family_id: string;
  verifier_hash: string;
  owner_user_id: string;
  created_at: Date;
  last_seen_at: Date;
  idle_expires_at: Date;
  absolute_expires_at: Date;
  rotated_from_id: string | null;
  revoked_at: Date | null;
  revoked_reason: string | null;
  csrf_hash: string;
  user_agent_hash: string | null;
  ip_hash: string | null;
}

export interface PostgresSessionStoreOptions {
  /** Connection string. Supplied by the composition root, never read here. */
  connectionString: string;
}

function stripPrefix(value: string, prefix: string): string | undefined {
  const candidate = value.startsWith(prefix) ? value.slice(prefix.length) : '';

  return UUID_PATTERN.test(candidate) ? candidate : undefined;
}

/**
 * A stored reason is a domain value only if this version knows it. An unknown
 * string is treated as "revoked, reason not recognised": the session is still
 * rejected, and the family-reuse branch simply does not fire.
 */
function toRevocationReason(value: string | null): SessionRevocationReason | null {
  return value !== null && isSessionRevocationReason(value) ? value : null;
}

function toRecord(row: SessionRow): SessionRecord {
  return {
    recordId: `${RECORD_ID_PREFIX}${row.id}`,
    familyId: `${FAMILY_ID_PREFIX}${row.session_family_id}`,
    userId: row.owner_user_id,
    createdAt: row.created_at.getTime(),
    lastSeenAt: row.last_seen_at.getTime(),
    idleExpiresAt: row.idle_expires_at.getTime(),
    absoluteExpiresAt: row.absolute_expires_at.getTime(),
    rotatedFrom: row.rotated_from_id === null ? null : `${RECORD_ID_PREFIX}${row.rotated_from_id}`,
    revokedAt: row.revoked_at === null ? null : row.revoked_at.getTime(),
    revokedReason: toRevocationReason(row.revoked_reason),
    userAgentHash: row.user_agent_hash,
    ipHash: row.ip_hash,
    // Only the stored digest is available; the raw token is client-held.
    csrfToken: row.csrf_hash,
  };
}

export class PostgresSessionStore implements SessionStore, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PostgresSessionStore.name);
  private readonly pool: Pool;
  private readonly records = new Map<string, SessionRecord>();
  private queue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(options: PostgresSessionStoreOptions) {
    this.pool = createPersistencePool({ connectionString: options.connectionString, max: 3 });
  }

  /** Provides the module hook Nest calls once, before the app serves traffic. */
  async onModuleInit(): Promise<void> {
    await this.hydrate();
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }

  /**
   * Loads every row that can still authenticate or detect reuse. A failure
   * propagates: a session authority that cannot read its own store must not
   * start and then deny (or worse, admit) sessions on an empty cache.
   */
  async hydrate(): Promise<void> {
    const cutoff = new Date(Date.now() - SESSION_RETIRED_RETENTION_MS);
    const result = await this.pool.query<SessionRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM auth_sessions
        WHERE absolute_expires_at > $1::timestamptz
          AND (revoked_at IS NULL OR revoked_at > $1::timestamptz)`,
      [cutoff],
    );

    for (const row of result.rows) {
      const loaded = toRecord(row);
      const cached = this.records.get(row.verifier_hash);

      if (cached === undefined) {
        this.records.set(row.verifier_hash, loaded);
        continue;
      }

      // Never overwrite a live in-process record with older stored state, but
      // do adopt a revocation another process committed.
      if (cached.revokedAt === null && loaded.revokedAt !== null) {
        cached.revokedAt = loaded.revokedAt;
        cached.revokedReason = loaded.revokedReason;
      }
    }
  }

  load(verifierHash: string): SessionRecord | undefined {
    return this.records.get(verifierHash);
  }

  insert(verifierHash: string, record: SessionRecord): void {
    if (this.closed) {
      return;
    }

    this.records.set(verifierHash, record);

    const id = stripPrefix(record.recordId, RECORD_ID_PREFIX);

    if (id === undefined) {
      this.records.delete(verifierHash);
      this.logger.error('session record id is not a session handle; the session was not stored');
      return;
    }

    const familyId = stripPrefix(record.familyId, FAMILY_ID_PREFIX);

    if (familyId === undefined) {
      this.records.delete(verifierHash);
      this.logger.error('session family id is not a session handle; the session was not stored');
      return;
    }

    const rotatedFrom =
      record.rotatedFrom === null ? null : stripPrefix(record.rotatedFrom, RECORD_ID_PREFIX);

    this.enqueue(
      async () => {
        await this.pool.query(
          `INSERT INTO auth_sessions (
             id, session_family_id, verifier_hash, owner_user_id, created_at, last_seen_at,
             idle_expires_at, absolute_expires_at, rotated_from_id, revoked_at, revoked_reason,
             csrf_hash, user_agent_hash, ip_hash
           ) VALUES (
             $1::uuid, $2::uuid, $3, $4::uuid, $5::timestamptz, $6::timestamptz,
             $7::timestamptz, $8::timestamptz, $9::uuid, $10::timestamptz, $11::text,
             $12, $13, $14
           )
           ON CONFLICT (id) DO NOTHING`,
          [
            id,
            familyId,
            verifierHash,
            record.userId,
            new Date(record.createdAt),
            new Date(record.lastSeenAt),
            new Date(record.idleExpiresAt),
            new Date(record.absoluteExpiresAt),
            rotatedFrom ?? null,
            record.revokedAt === null ? null : new Date(record.revokedAt),
            record.revokedReason,
            csrfDigest(record.csrfToken),
            record.userAgentHash,
            record.ipHash,
          ],
        );
      },
      () => {
        if (this.records.get(verifierHash) === record) {
          this.records.delete(verifierHash);
        }
      },
    );
  }

  save(record: SessionRecord): void {
    if (this.closed) {
      return;
    }

    const id = stripPrefix(record.recordId, RECORD_ID_PREFIX);

    if (id === undefined) {
      return;
    }

    this.enqueue(async () => {
      await this.pool.query(
        `UPDATE auth_sessions
            SET last_seen_at = GREATEST(last_seen_at, $2::timestamptz),
                idle_expires_at = GREATEST(idle_expires_at, $3::timestamptz),
                revoked_at = COALESCE(revoked_at, $4::timestamptz),
                revoked_reason = COALESCE(revoked_reason, $5::text),
                csrf_hash = $6
          WHERE id = $1::uuid`,
        [
          id,
          new Date(record.lastSeenAt),
          new Date(record.idleExpiresAt),
          record.revokedAt === null ? null : new Date(record.revokedAt),
          record.revokedReason,
          csrfDigest(record.csrfToken),
        ],
      );
    });
  }

  listForUser(userId: string, at: number): SessionRecord[] {
    return [...this.records.values()]
      .filter(
        (record) =>
          record.userId === userId &&
          record.revokedAt === null &&
          at < record.idleExpiresAt &&
          at < record.absoluteExpiresAt,
      )
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  revokeAllForUser(userId: string, reason: SessionRevocationReason, at: number): number {
    const revoked = this.revokeCached((record) => record.userId === userId, reason, at);

    this.enqueue(async () => {
      await this.pool.query(
        `UPDATE auth_sessions
            SET revoked_at = COALESCE(revoked_at, $2::timestamptz),
                revoked_reason = COALESCE(revoked_reason, $3::text)
          WHERE owner_user_id = $1::uuid
            AND revoked_at IS NULL`,
        [userId, new Date(at), reason],
      );
    });

    return revoked;
  }

  revokeFamily(familyId: string, reason: SessionRevocationReason, at: number): number {
    const revoked = this.revokeCached((record) => record.familyId === familyId, reason, at);
    const id = stripPrefix(familyId, FAMILY_ID_PREFIX);

    if (id === undefined) {
      return revoked;
    }

    this.enqueue(async () => {
      await this.pool.query(
        `UPDATE auth_sessions
            SET revoked_at = COALESCE(revoked_at, $2::timestamptz),
                revoked_reason = COALESCE(revoked_reason, $3::text)
          WHERE session_family_id = $1::uuid
            AND revoked_at IS NULL`,
        [id, new Date(at), reason],
      );
    });

    return revoked;
  }

  sweep(at: number): number {
    let removed = 0;

    for (const [verifier, record] of this.records) {
      if (isPastRetention(record, at)) {
        this.records.delete(verifier);
        removed += 1;
      }
    }

    if (this.closed) {
      return removed;
    }

    const cutoff = new Date(at - SESSION_RETIRED_RETENTION_MS);

    this.enqueue(async () => {
      await this.pool.query(
        `DELETE FROM auth_sessions
          WHERE (revoked_at IS NOT NULL AND revoked_at <= $1::timestamptz)
             OR absolute_expires_at <= $1::timestamptz`,
        [cutoff],
      );
    });

    return removed;
  }

  async flush(): Promise<void> {
    await this.queue;
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;
    await this.flush();
    await this.pool.end();
  }

  private revokeCached(
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

  /**
   * Appends one write to the ordered chain. Writes never reject the caller:
   * a failure after the bounded retries is logged without credential or row
   * content, and the optional failure hook decides the local consequence.
   */
  private enqueue(work: () => Promise<void>, onFailure?: () => void): void {
    if (this.closed) {
      return;
    }

    // The trailing catch keeps a single unexpected failure from turning the
    // chain into a rejected promise, which would silently skip every later
    // write (and reject `flush`).
    this.queue = this.queue
      .then(() => this.run(work, onFailure))
      .catch(() => {
        // `run` already reports failures; nothing here may throw either.
      });
  }

  private async run(work: () => Promise<void>, onFailure?: () => void): Promise<void> {
    for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt += 1) {
      try {
        await work();
        return;
      } catch (error) {
        if (attempt < WRITE_ATTEMPTS) {
          continue;
        }

        this.logger.error(
          `session store write failed after ${WRITE_ATTEMPTS} attempts: ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        );
        onFailure?.();
      }
    }
  }
}
