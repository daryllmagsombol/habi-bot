/**
 * Request helpers for the H-017 contract slice: clock reading, bearer fixture
 * parsing, and the Origin/Referer second control from design §3.
 */
import { UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import type { SessionRecord } from './session.service.js';

/**
 * Test-only time control. Honoured only when HABI_SESSION_SPIKE_TEST_CLOCK=1
 * (and the session spike itself is enabled), so a normal spike server can
 * never have its expiry windows shifted by a request header.
 */
export const SESSION_TEST_CLOCK_HEADER = 'x-session-spike-now-offset-ms';
const MAX_TEST_CLOCK_OFFSET_MS = 7 * 24 * 60 * 60 * 1000;

export interface SessionAttachment {
  userId: string;
  record: SessionRecord;
}

export interface SessionRequest extends Request {
  /** Set only by SessionAuthGuard after a successful validation. */
  sessionSpike?: SessionAttachment;
}

function headerValue(request: Request, name: string): string | undefined {
  const value = request.headers[name];

  return typeof value === 'string' ? value : undefined;
}

export function readUserAgent(request: Request): string | undefined {
  return headerValue(request, 'user-agent');
}

export function readBearerToken(header: string | undefined): string | undefined {
  if (typeof header !== 'string') {
    return undefined;
  }

  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1];
}

export function isTestClockEnabled(): boolean {
  return process.env.HABI_SESSION_SPIKE_TEST_CLOCK === '1';
}

/**
 * Server time is authoritative (design §6). The offset header exists only for
 * expiry tests and is ignored unless explicitly enabled by the environment.
 */
export function requestNow(request: Request): number {
  const now = Date.now();

  if (!isTestClockEnabled()) {
    return now;
  }

  const raw = headerValue(request, SESSION_TEST_CLOCK_HEADER);

  if (raw === undefined) {
    return now;
  }

  const offset = Number(raw);

  if (!Number.isInteger(offset) || Math.abs(offset) > MAX_TEST_CLOCK_OFFSET_MS) {
    return now;
  }

  return now + offset;
}

/**
 * Second CSRF control. A mismatched Origin/Referer is always rejected; in
 * production (where a browser always sends one) an absent value is rejected
 * too. Test clients may omit it outside production.
 */
export function isSameOrigin(request: Request): boolean {
  const candidate = headerValue(request, 'origin') ?? headerValue(request, 'referer');

  if (candidate === undefined) {
    return !isProductionEnvironment();
  }

  try {
    return new URL(candidate).host === (request.headers.host ?? '');
  } catch {
    return false;
  }
}

function isProductionEnvironment(): boolean {
  return process.env.NODE_ENV === 'production';
}

/** Reads the attachment set by SessionAuthGuard; 401 if it is missing. */
export function requireSession(request: SessionRequest): SessionAttachment {
  const session = request.sessionSpike;

  if (session === undefined) {
    throw new UnauthorizedException({ error: { code: 'unauthenticated' } });
  }

  return session;
}
