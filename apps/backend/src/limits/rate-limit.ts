/**
 * In-process run-creation rate limiting for H-023.
 *
 * This is the abuse stopgap for one API process: a fixed one-minute window per
 * Habi user, 30 run creations per window by default. It bounds scripted
 * run-creation floods without adding a dependency or a network call.
 *
 * Documented limitations (deliberate, not accidental):
 *   - State is a `Map` in this process only. It is lost on restart and is not
 *     shared between API replicas, so N replicas multiply the effective limit.
 *     Durable, distributed enforcement (for example a shared counter or a
 *     queue-level admission check) belongs to a later layer; this module must
 *     not be described as a hard distributed guarantee.
 *   - A flood of unique user ids can exceed the tracked-key cap; the oldest key
 *     is dropped, which fails open for that key. Memory stays bounded.
 *   - Keys are SHA-256 hashed so raw user ids are not retained for the life of
 *     the process. Hashing is not a security boundary; the map is small.
 *
 * Every refusal carries the same metadata shape. It never names the user, the
 * bucket, or how close other callers are to their own limit.
 */
import { createHash } from 'node:crypto';
import { RateLimitError } from './errors.js';
import type { RateLimitedMetadata } from './errors.js';

export interface RunCreationRateLimitRule {
  /** Maximum run creations allowed in the window. */
  readonly limit: number;
  readonly windowMs: number;
}

/** Provisional abuse allowance; a lower value is an owner decision, not a code change. */
export const RUN_CREATION_RATE_LIMIT: RunCreationRateLimitRule = {
  limit: 30,
  windowMs: 60_000,
};

export interface RunCreationRateLimiterOptions {
  readonly limit?: number;
  readonly windowMs?: number;
  readonly now?: () => Date;
  readonly maxTrackedKeys?: number;
}

export interface RunCreationRateLimitDecision {
  readonly allowed: boolean;
  readonly limit: number;
  /** Requests remaining in the current window; never negative. */
  readonly remaining: number;
  /** First instant the next request would be admitted, as an ISO timestamp. */
  readonly resetAt: string;
  /** Zero while allowed; otherwise whole seconds until `resetAt`. */
  readonly retryAfterSeconds: number;
}

interface WindowEntry {
  count: number;
  resetAt: number;
}

const MAX_TRACKED_KEYS = 10_000;
const RATE_LIMIT_KEY_NAMESPACE = 'habi-run-creation-rate-limit';

/** Hashes the bucket identifier; the raw Habi user id never stays in the map. */
export function runCreationRateLimitKey(ownerUserId: string): string {
  const digest = createHash('sha256')
    .update(`${RATE_LIMIT_KEY_NAMESPACE}\u0000${ownerUserId}`, 'utf8')
    .digest('hex');

  return `run:${digest}`;
}

export class RunCreationRateLimiter {
  private readonly windows = new Map<string, WindowEntry>();
  private readonly rule: RunCreationRateLimitRule;
  private readonly now: () => Date;
  private readonly maxTrackedKeys: number;

  constructor(options: RunCreationRateLimiterOptions = {}) {
    this.rule = {
      limit: options.limit ?? RUN_CREATION_RATE_LIMIT.limit,
      windowMs: options.windowMs ?? RUN_CREATION_RATE_LIMIT.windowMs,
    };
    this.now = options.now ?? (() => new Date());
    this.maxTrackedKeys = options.maxTrackedKeys ?? MAX_TRACKED_KEYS;

    if (
      !Number.isSafeInteger(this.rule.limit) ||
      this.rule.limit <= 0 ||
      !Number.isSafeInteger(this.rule.windowMs) ||
      this.rule.windowMs <= 0
    ) {
      throw new TypeError('Rate limit rule must use positive integer bounds.');
    }
  }

  /** Number of live tracked buckets; used to prove the map stays bounded. */
  get trackedKeys(): number {
    return this.windows.size;
  }

  /**
   * Records one run-creation attempt. A fixed window starts on the first
   * attempt and does not slide, so the retry delay never exceeds one window.
   */
  check(ownerUserId: string, at?: Date): RunCreationRateLimitDecision {
    const instant = this.normalizeInstant(at);
    const key = runCreationRateLimitKey(this.requireOwner(ownerUserId));

    this.prune(instant.getTime());

    const existing = this.windows.get(key);
    const entry =
      existing === undefined || instant.getTime() >= existing.resetAt
        ? { count: 0, resetAt: instant.getTime() + this.rule.windowMs }
        : existing;

    entry.count += 1;
    this.windows.set(key, entry);

    const allowed = entry.count <= this.rule.limit;

    return {
      allowed,
      limit: this.rule.limit,
      remaining: Math.max(0, this.rule.limit - entry.count),
      resetAt: new Date(entry.resetAt).toISOString(),
      retryAfterSeconds: allowed
        ? 0
        : Math.max(1, Math.ceil((entry.resetAt - instant.getTime()) / 1000)),
    };
  }

  /**
   * Throws `RateLimitError` (429) with the uniform metadata when the caller is
   * over the window. Route layers map the error; this layer never writes HTTP.
   */
  assert(ownerUserId: string, at?: Date): RunCreationRateLimitDecision {
    const decision = this.check(ownerUserId, at);

    if (!decision.allowed) {
      throw new RateLimitError(rateLimitedMetadata(decision));
    }

    return decision;
  }

  private requireOwner(ownerUserId: string): string {
    if (typeof ownerUserId !== 'string' || ownerUserId.trim().length === 0) {
      throw new TypeError('A non-empty owner id is required for rate limiting.');
    }

    return ownerUserId;
  }

  private normalizeInstant(at: Date | undefined): Date {
    const instant = at ?? this.now();

    if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) {
      throw new TypeError('A valid Date is required for rate limiting.');
    }

    return instant;
  }

  private prune(at: number): void {
    if (this.windows.size < this.maxTrackedKeys) {
      return;
    }

    for (const [key, entry] of this.windows) {
      if (at >= entry.resetAt) {
        this.windows.delete(key);
      }
    }

    while (this.windows.size >= this.maxTrackedKeys) {
      const oldest = this.windows.keys().next();

      if (oldest.done === true) {
        break;
      }

      this.windows.delete(oldest.value);
    }
  }
}

/** Uniform refusal metadata; identical for every user and every window. */
export function rateLimitedMetadata(
  decision: RunCreationRateLimitDecision,
): RateLimitedMetadata {
  return {
    code: 'rate_limited',
    limit: decision.limit,
    retryAfterSeconds: decision.retryAfterSeconds,
  };
}
