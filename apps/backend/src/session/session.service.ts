/**
 * Session contract slice for H-017 (#17). Not product authentication.
 *
 * Implements the accepted session lifecycle from
 * docs/superpowers/specs/2026-11-03-session-and-secret-lifecycle-design.md §2
 * in-process, gated behind HABI_SESSION_SPIKE=1:
 *
 *   - opaque 256-bit session secret (base64url) minted by the CSPRNG;
 *   - only a SHA-256 verifier is retained, never the raw session secret;
 *   - idle (sliding) and absolute expiry, evaluated against the server clock;
 *   - rotation keeps family lineage and retires the old record single-use;
 *   - reuse of a retired secret revokes the whole family;
 *   - a separate per-session CSRF token, re-issued on rotation.
 *
 * State is in-memory and non-durable: a process restart drops every session,
 * CSRF token, and observer hash. There is no database, no password check, and
 * no provider credential handling here. Numeric TTLs mirror the design's
 * proposed defaults (idle 30 minutes, absolute 12 hours); they remain an owner
 * decision (#17 D1) and are not approved values.
 */
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';

/** Design §9 D1 proposed defaults, not owner-approved values. */
export const SESSION_IDLE_TTL_MS = 30 * 60 * 1000;
export const SESSION_ABSOLUTE_TTL_MS = 12 * 60 * 60 * 1000;

/** Design §9 D7 proposed retired-verifier retention for reuse detection. */
const RETIRED_RETENTION_MS = 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 1000;

/** 32 random bytes, base64url encoded, is 43 characters and 256 bits. */
const SESSION_SECRET_BYTES = 32;
const SESSION_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Per-process salt for coarse observer hashes. Hashes are therefore not
 * comparable across restarts, which is acceptable because nothing is durable.
 */
const OBSERVER_HASH_SALT = randomBytes(32);

export type SessionRevocationReason =
  | 'logout'
  | 'logout_all'
  | 'rotated'
  | 'idle_expired'
  | 'absolute_expired'
  | 'reuse_detected'
  | 'family_revoked';

export interface SessionRecord {
  /** Internal, non-secret record handle used for listing and lineage. */
  readonly recordId: string;
  /** Rotations of one login share a family id. */
  readonly familyId: string;
  readonly userId: string;
  readonly createdAt: number;
  lastSeenAt: number;
  idleExpiresAt: number;
  /** Fixed at first authentication; never extended by activity or rotation. */
  readonly absoluteExpiresAt: number;
  /** Previous record id in this family, or null for the first session. */
  readonly rotatedFrom: string | null;
  revokedAt: number | null;
  revokedReason: SessionRevocationReason | null;
  /** Salted hash of the User-Agent; raw values are never retained. */
  readonly userAgentHash: string | null;
  /** Salted hash of the client IP; raw values are never retained. */
  readonly ipHash: string | null;
  /**
   * Synchronizer CSRF token. Retained in memory so the authenticated client
   * can fetch it (`GET /session-spike/csrf`); it is not a bearer credential.
   * A durable implementation may issue it on demand instead.
   */
  readonly csrfToken: string;
}

export interface SessionObserver {
  userAgent?: string;
  ip?: string;
}

export interface IssuedSession {
  /** Raw session secret. Only the Set-Cookie header may carry it. */
  sessionId: string;
  csrfToken: string;
  record: SessionRecord;
}

export interface SessionView {
  sessionRef: string;
  userId: string;
  createdAt: string;
  lastSeenAt: string;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
  current: boolean;
}

/**
 * The external failure shape is deliberately uniform for unknown, expired,
 * revoked, and rotated-reuse sessions (design §6). Internal causes are never
 * returned to a caller or written to a response body.
 */
export interface SessionFailure {
  ok: false;
  reason: 'unauthenticated';
}

export type SessionValidation =
  | { ok: true; userId: string; record: SessionRecord }
  | SessionFailure;

export const SESSION_FAILURE: SessionFailure = { ok: false, reason: 'unauthenticated' };

export interface Clock {
  now(): number;
}

export const SESSION_CLOCK = Symbol('HABI_SESSION_CLOCK');

export const systemClock: Clock = {
  now: () => Date.now(),
};

function hashSessionSecret(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex');
}

function hashObserver(value: string | undefined): string | null {
  if (value === undefined || value.length === 0) {
    return null;
  }

  return createHmac('sha256', OBSERVER_HASH_SALT).update(value).digest('hex');
}

function mintSessionSecret(): string {
  return randomBytes(SESSION_SECRET_BYTES).toString('base64url');
}

/**
 * Constant-time synchronizer-token comparison. Length mismatch short-circuits
 * because `timingSafeEqual` requires equal-length buffers.
 */
export function csrfTokenMatches(expected: string, provided: string | undefined): boolean {
  if (provided === undefined || provided.length === 0) {
    return false;
  }

  const expectedBuffer = Buffer.from(expected, 'utf8');
  const providedBuffer = Buffer.from(provided, 'utf8');

  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, providedBuffer);
}

export function toSessionView(record: SessionRecord, current: boolean): SessionView {
  return {
    sessionRef: record.recordId,
    userId: record.userId,
    createdAt: new Date(record.createdAt).toISOString(),
    lastSeenAt: new Date(record.lastSeenAt).toISOString(),
    idleExpiresAt: new Date(record.idleExpiresAt).toISOString(),
    absoluteExpiresAt: new Date(record.absoluteExpiresAt).toISOString(),
    current,
  };
}

/**
 * In-memory session store. Records are keyed by the SHA-256 verifier of the
 * session secret, so the raw secret never enters the store. One record maps to
 * exactly one user; identity is never read from a request header.
 */
@Injectable()
export class SessionService {
  private readonly records = new Map<string, SessionRecord>();
  private nextPruneAt = 0;

  constructor(@Inject(SESSION_CLOCK) private readonly clock: Clock = systemClock) {}

  /**
   * Mints a new family. Login must always call this: a client-supplied
   * identifier is never adopted (fixation, design §6).
   */
  create(userId: string, observer: SessionObserver = {}, at = this.clock.now()): IssuedSession {
    this.prune(at);

    return this.insert({
      userId,
      familyId: `fam_${randomUUID()}`,
      rotatedFrom: null,
      absoluteExpiresAt: at + SESSION_ABSOLUTE_TTL_MS,
      userAgentHash: hashObserver(observer.userAgent),
      ipHash: hashObserver(observer.ip),
      at,
    });
  }

  /**
   * Issues a new secret in the same family and retires the presented record.
   * Absolute expiry is inherited, never extended. Returns undefined when the
   * presented secret is not live.
   */
  rotate(sessionId: string, at = this.clock.now()): IssuedSession | undefined {
    const current = this.validate(sessionId, at);

    if (!current.ok) {
      return undefined;
    }

    const issued = this.insert({
      userId: current.record.userId,
      familyId: current.record.familyId,
      rotatedFrom: current.record.recordId,
      absoluteExpiresAt: current.record.absoluteExpiresAt,
      userAgentHash: current.record.userAgentHash,
      ipHash: current.record.ipHash,
      at,
    });

    this.markRevoked(current.record, 'rotated', at);
    return issued;
  }

  /** Revokes the presented session only. Returns false if it was not live. */
  revoke(sessionId: string, at = this.clock.now()): boolean {
    const record = this.lookup(sessionId);

    if (record?.revokedAt !== null) {
      return false;
    }

    this.markRevoked(record, 'logout', at);
    return true;
  }

  /** Revokes every live session for the user, across devices. */
  revokeAllForUser(userId: string, at = this.clock.now()): number {
    return this.revokeWhere((record) => record.userId === userId, 'logout_all', at);
  }

  /** Revokes every live session in one rotation family. */
  revokeFamily(familyId: string, at = this.clock.now()): number {
    return this.revokeWhere((record) => record.familyId === familyId, 'family_revoked', at);
  }

  /**
   * Validates a session secret and slides the idle window.
   *
   * Presenting a secret that was retired by rotation is reuse: the family is
   * revoked before the uniform failure is returned (design §2.2, §6).
   */
  validate(sessionId: string, at = this.clock.now()): SessionValidation {
    this.prune(at);

    const record = this.lookup(sessionId);

    if (record === undefined) {
      return SESSION_FAILURE;
    }

    if (record.revokedAt !== null) {
      if (record.revokedReason === 'rotated') {
        this.revokeWhere((candidate) => candidate.familyId === record.familyId, 'reuse_detected', at);
      }

      return SESSION_FAILURE;
    }

    if (at >= record.absoluteExpiresAt) {
      this.markRevoked(record, 'absolute_expired', at);
      return SESSION_FAILURE;
    }

    if (at >= record.idleExpiresAt) {
      this.markRevoked(record, 'idle_expired', at);
      return SESSION_FAILURE;
    }

    record.lastSeenAt = at;
    record.idleExpiresAt = Math.min(at + SESSION_IDLE_TTL_MS, record.absoluteExpiresAt);

    return { ok: true, userId: record.userId, record };
  }

  /** Live sessions for one user only; never another user's records. */
  listForUser(userId: string, at = this.clock.now()): SessionRecord[] {
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

  private insert(input: {
    userId: string;
    familyId: string;
    rotatedFrom: string | null;
    absoluteExpiresAt: number;
    userAgentHash: string | null;
    ipHash: string | null;
    at: number;
  }): IssuedSession {
    const sessionId = mintSessionSecret();
    const csrfToken = mintSessionSecret();
    const record: SessionRecord = {
      recordId: `sess_${randomUUID()}`,
      familyId: input.familyId,
      userId: input.userId,
      createdAt: input.at,
      lastSeenAt: input.at,
      idleExpiresAt: Math.min(input.at + SESSION_IDLE_TTL_MS, input.absoluteExpiresAt),
      absoluteExpiresAt: input.absoluteExpiresAt,
      rotatedFrom: input.rotatedFrom,
      revokedAt: null,
      revokedReason: null,
      userAgentHash: input.userAgentHash,
      ipHash: input.ipHash,
      csrfToken,
    };

    this.records.set(hashSessionSecret(sessionId), record);

    return { sessionId, csrfToken, record };
  }

  private lookup(sessionId: string): SessionRecord | undefined {
    if (typeof sessionId !== 'string' || !SESSION_SECRET_PATTERN.test(sessionId)) {
      return undefined;
    }

    return this.records.get(hashSessionSecret(sessionId));
  }

  private markRevoked(record: SessionRecord, reason: SessionRevocationReason, at: number): void {
    if (record.revokedAt !== null) {
      return;
    }

    record.revokedAt = at;
    record.revokedReason = reason;
  }

  private revokeWhere(
    predicate: (record: SessionRecord) => boolean,
    reason: SessionRevocationReason,
    at: number,
  ): number {
    let revoked = 0;

    for (const record of this.records.values()) {
      if (record.revokedAt === null && predicate(record)) {
        this.markRevoked(record, reason, at);
        revoked += 1;
      }
    }

    return revoked;
  }

  /**
   * Bounded lazy pruning. Retired verifiers are kept only long enough to
   * detect reuse (design §9 D7); expired records are dropped after the same
   * window.
   */
  private prune(at: number): void {
    if (at < this.nextPruneAt) {
      return;
    }

    for (const [verifier, record] of this.records) {
      const retiredLongAgo =
        record.revokedAt !== null && at - record.revokedAt >= RETIRED_RETENTION_MS;
      const expiredLongAgo = at - record.absoluteExpiresAt >= RETIRED_RETENTION_MS;

      if (retiredLongAgo || expiredLongAgo) {
        this.records.delete(verifier);
      }
    }

    this.nextPruneAt = at + PRUNE_INTERVAL_MS;
  }
}
