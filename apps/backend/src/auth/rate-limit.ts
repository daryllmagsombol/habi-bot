/**
 * In-process fixed-window rate limiting for the H-014 identity slice.
 *
 * This is a deliberate POC stopgap, not the final abuse-control design (#23).
 * Properties and limits:
 *
 * - State is a `Map` in this process only. It is lost on restart and not shared
 *   between API replicas, so a multi-instance deployment would multiply the
 *   effective allowance.
 * - Callers pass both a canonical-email key and a client key; the service
 *   consumes all of them before checking, so a blocked request still counts
 *   against the other bucket.
 * - Keys are SHA-256 hashed in memory so raw addresses are not retained in a
 *   process dump. Hashing is not a security boundary; the buckets are small.
 * - The map is pruned opportunistically and capped so a spray of unique keys
 *   cannot grow it without bound.
 *
 * The route responses are the uniform `429 rate_limited` shape and never name
 * which bucket was exhausted.
 */
import { createHash } from 'node:crypto';

export interface RateLimitRule {
  /** Maximum allowed requests in the window. */
  readonly limit: number;
  readonly windowMs: number;
}

/**
 * Provisional allowances. They are intentionally generous enough for ordinary
 * retries and small enough to blunt scripted guessing. Owner-approved values
 * are part of #23.
 */
export const AUTH_RATE_LIMITS = {
  loginEmail: { limit: 10, windowMs: 15 * 60 * 1000 },
  loginClient: { limit: 30, windowMs: 15 * 60 * 1000 },
  signupEmail: { limit: 5, windowMs: 60 * 60 * 1000 },
  signupClient: { limit: 20, windowMs: 60 * 60 * 1000 },
  recoveryEmail: { limit: 3, windowMs: 15 * 60 * 1000 },
  recoveryClient: { limit: 10, windowMs: 15 * 60 * 1000 },
} as const satisfies Record<string, RateLimitRule>;

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
}

interface WindowEntry {
  count: number;
  resetAt: number;
}

const MAX_TRACKED_KEYS = 10_000;
const RATE_LIMIT_KEY_NAMESPACE = 'habi-auth-rate-limit';

/** Hashes a bucket identifier; the raw email/address never stays in the map. */
export function rateLimitKey(scope: string, value: string): string {
  const digest = createHash('sha256')
    .update(`${RATE_LIMIT_KEY_NAMESPACE}\u0000${scope}\u0000${value}`, 'utf8')
    .digest('hex');

  return `${scope}:${digest}`;
}

export class FixedWindowRateLimiter {
  private readonly windows = new Map<string, WindowEntry>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxTrackedKeys = MAX_TRACKED_KEYS,
  ) {}

  /**
   * Records one request. A fixed window starts on the first request and does
   * not slide, so the retry delay never exceeds one window.
   */
  consume(key: string, rule: RateLimitRule, at = this.now()): RateLimitDecision {
    this.prune(at);

    const existing = this.windows.get(key);
    const entry =
      existing === undefined || at >= existing.resetAt
        ? { count: 0, resetAt: at + rule.windowMs }
        : existing;

    entry.count += 1;
    this.windows.set(key, entry);

    if (entry.count <= rule.limit) {
      return { allowed: true, retryAfterSeconds: 0 };
    }

    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - at) / 1000)),
    };
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

    // A flood of still-live unique keys can exceed the cap; dropping oldest
    // insertions fails open on those buckets but keeps memory bounded. This is
    // documented as a POC limitation rather than a silent guarantee.
    while (this.windows.size >= this.maxTrackedKeys) {
      const oldest = this.windows.keys().next();

      if (oldest.done === true) {
        break;
      }

      this.windows.delete(oldest.value);
    }
  }
}
