/**
 * Session contract slice for H-017 (#17). Not product authentication.
 *
 * Implements the accepted session lifecycle from
 * docs/superpowers/specs/2026-11-03-session-and-secret-lifecycle-design.md §2:
 *
 *   - opaque 256-bit session secret (base64url) minted by the CSPRNG;
 *   - only a SHA-256 verifier is retained, never the raw session secret;
 *   - idle (sliding) and absolute expiry, evaluated against the server clock;
 *   - rotation keeps family lineage and retires the old record single-use;
 *   - reuse of a retired secret revokes the whole family;
 *   - a separate per-session CSRF token, re-issued on rotation and verified
 *     against a stored hash, never by recovering the token.
 *
 * Storage is a separate concern (`SessionStore`). The service owns the rules
 * and runs unchanged over either implementation. The default is the in-memory
 * store for a process with no database configured, and the PostgreSQL store
 * when `DATABASE_URL` is present; `HABI_SESSION_STORE=memory|postgres` forces
 * one. The durable store is what makes a restart stop dropping every session,
 * and its write-behind and cross-process boundaries are documented in
 * `session-store.ts` and `session-postgres-store.ts`.
 *
 * There is no password check and no provider credential handling here. Numeric
 * TTLs mirror the design's proposed defaults (idle 30 minutes, absolute 12
 * hours); they remain an owner decision (#17 D1) and are not approved values.
 */
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { InMemorySessionStore, SESSION_STORE } from './session-store.js';
import type { SessionStore } from './session-store.js';

/** Design §9 D1 proposed defaults, not owner-approved values. */
export const SESSION_IDLE_TTL_MS = 30 * 60 * 1000;
export const SESSION_ABSOLUTE_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * How often the lazy cleanup path runs. It is not a timer: the sweep happens
 * on the first `create`/`validate` after the window, so a process with no
 * traffic does no work, and `sweepExpired` can always be called explicitly.
 */
const SWEEP_INTERVAL_MS = 60 * 1000;

/** 32 random bytes, base64url encoded, is 43 characters and 256 bits. */
const SESSION_SECRET_BYTES = 32;
const SESSION_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Per-process salt for coarse observer hashes. A salted hash stored by one
 * process is not comparable with one produced by another, which is acceptable
 * because observer hashes are coarse metadata and no decision reads them.
 */
const OBSERVER_HASH_SALT = randomBytes(32);

export const SESSION_REVOCATION_REASONS = [
  'logout',
  'logout_all',
  'rotated',
  'idle_expired',
  'absolute_expired',
  'reuse_detected',
  'family_revoked',
] as const;

export type SessionRevocationReason = (typeof SESSION_REVOCATION_REASONS)[number];

/** Validates a stored reason before it becomes a domain value. */
export function isSessionRevocationReason(value: string): value is SessionRevocationReason {
  return SESSION_REVOCATION_REASONS.some((reason) => reason === value);
}

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
   * CSRF material bound to the session, and never a bearer credential.
   *
   * A record minted in this process holds the raw token, so the authenticated
   * client can be handed it. A record loaded from durable storage holds only
   * the stored SHA-256 digest: the raw token is client-held and cannot be
   * recovered from the database. `csrfTokenMatches` accepts either form and
   * compares in constant time.
   */
  csrfToken: string;
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

/** A SHA-256 hex digest. Raw session and CSRF secrets are 43 base64url chars. */
const CSRF_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

function hashCsrfToken(csrfToken: string): string {
  return createHash('sha256').update(csrfToken).digest('hex');
}

/**
 * The digest for a CSRF value that is either the raw token (a record minted in
 * this process) or its stored digest (a record loaded from durable storage).
 * The two forms are disjoint: raw tokens are 43 base64url characters, digests
 * are 64 lowercase hex characters.
 */
export function csrfDigest(csrfToken: string): string {
  return CSRF_DIGEST_PATTERN.test(csrfToken) ? csrfToken : hashCsrfToken(csrfToken);
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

/** Constant-time comparison of two equal-purpose SHA-256 hex digests. */
function digestMatches(expectedHash: string, providedHash: string): boolean {
  const expected = Buffer.from(expectedHash, 'hex');
  const provided = Buffer.from(providedHash, 'hex');

  if (expected.length === 0 || expected.length !== provided.length) {
    return false;
  }

  return timingSafeEqual(expected, provided);
}

/**
 * Constant-time synchronizer-token comparison.
 *
 * `expected` is either the raw token (minted in this process) or the stored
 * SHA-256 digest (loaded from durable storage); both are reduced to a digest
 * before comparison, so a restarted process verifies a token the client already
 * holds without ever needing the token at rest. `timingSafeEqual` needs
 * equal-length buffers, which digests always are; an empty or missing
 * presentation short-circuits.
 */
export function csrfTokenMatches(expected: string, provided: string | undefined): boolean {
  if (provided === undefined || provided.length === 0) {
    return false;
  }

  return digestMatches(csrfDigest(expected), hashCsrfToken(provided));
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
 * The session authority for a process. Records are keyed by the SHA-256
 * verifier of the session secret, so the raw secret never enters the store.
 * One record maps to exactly one user; identity is never read from a request
 * header.
 */
@Injectable()
export class SessionService {
  /** Earliest clock reading at which the lazy sweep may run again. */
  private nextSweepAt = 0;

  constructor(
    @Inject(SESSION_CLOCK) private readonly clock: Clock = systemClock,
    @Inject(SESSION_STORE) private readonly store: SessionStore = new InMemorySessionStore(),
  ) {}

  /**
   * Mints a new family. Login must always call this: a client-supplied
   * identifier is never adopted (fixation, design §6).
   */
  create(userId: string, observer: SessionObserver = {}, at = this.clock.now()): IssuedSession {
    this.sweepIfDue(at);

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
    return this.store.revokeAllForUser(userId, 'logout_all', at);
  }

  /** Revokes every live session in one rotation family. */
  revokeFamily(familyId: string, at = this.clock.now()): number {
    return this.store.revokeFamily(familyId, 'family_revoked', at);
  }

  /**
   * Validates a session secret and slides the idle window.
   *
   * Presenting a secret that was retired by rotation is reuse: the family is
   * revoked before the uniform failure is returned (design §2.2, §6).
   */
  validate(sessionId: string, at = this.clock.now()): SessionValidation {
    this.sweepIfDue(at);

    const record = this.lookup(sessionId);

    if (record === undefined) {
      return SESSION_FAILURE;
    }

    if (record.revokedAt !== null) {
      if (record.revokedReason === 'rotated') {
        this.store.revokeFamily(record.familyId, 'reuse_detected', at);
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
    this.store.save(record);

    return { ok: true, userId: record.userId, record };
  }

  /** Live sessions for one user only; never another user's records. */
  listForUser(userId: string, at = this.clock.now()): SessionRecord[] {
    return this.store.listForUser(userId, at);
  }

  /**
   * Bounded cleanup of rows that can no longer authenticate or detect reuse.
   *
   * This is the explicit entry point; the lazy call site is the first
   * `create`/`validate` after a one-minute window. If it never runs, retired
   * and expired rows accumulate in storage — nothing authenticates
   * incorrectly, because expiry and revocation are evaluated on every
   * validation against the record itself, never inferred from the sweep.
   */
  sweepExpired(at = this.clock.now()): number {
    return this.store.sweep(at);
  }

  /**
   * Returns the raw CSRF token bound to a record.
   *
   * A record loaded from durable storage carries only the hash, so the token
   * cannot be recovered and is re-issued here. The product login path always
   * returns a freshly minted token, and the web client holds it; only the
   * H-017 fixture route needs this, and it runs without a database.
   */
  csrfTokenFor(record: SessionRecord): string {
    if (!CSRF_DIGEST_PATTERN.test(record.csrfToken)) {
      return record.csrfToken;
    }

    const csrfToken = mintSessionSecret();

    record.csrfToken = csrfToken;
    this.store.save(record);

    return csrfToken;
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

    this.store.insert(hashSessionSecret(sessionId), record);

    return { sessionId, csrfToken, record };
  }

  private lookup(sessionId: string): SessionRecord | undefined {
    if (typeof sessionId !== 'string' || !SESSION_SECRET_PATTERN.test(sessionId)) {
      return undefined;
    }

    return this.store.load(hashSessionSecret(sessionId));
  }

  private markRevoked(record: SessionRecord, reason: SessionRevocationReason, at: number): void {
    if (record.revokedAt !== null) {
      return;
    }

    record.revokedAt = at;
    record.revokedReason = reason;
    this.store.save(record);
  }

  /**
   * Lazy cleanup cadence, mirroring the slice's original bounded pruning: at
   * most one sweep per window, driven by traffic rather than a timer.
   */
  private sweepIfDue(at: number): void {
    if (at < this.nextSweepAt) {
      return;
    }

    this.nextSweepAt = at + SWEEP_INTERVAL_MS;
    this.store.sweep(at);
  }
}
