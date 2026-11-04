/**
 * Minimal OIDC id-token verifier: RS256 only, no third-party JWT dependency.
 *
 * Why hand-rolled: the workspace has no JWT library, and the verification set is
 * small and fixed by H-008 §5.5 — signature with a JWKS key, exact `iss`, `aud`
 * containing the client id, `nonce`, and expiry. Everything else an id_token may
 * carry is ignored, so an unexpected claim cannot widen authority.
 *
 * Accepted algorithms are RS256 with an RSA JWK. Google and Microsoft both sign
 * with RS256; `none`, HMAC, and key-embedding (`jwk`/`jku` headers) are rejected
 * before any key lookup, so a token cannot choose its own key. `alg` is compared
 * against the allow-list, not read as a hint.
 *
 * The JWKS is fetched from the caller-configured URI and cached for five minutes.
 * An unknown `kid` triggers at most one refresh per second, which handles
 * provider key rotation without turning a bad token into a fetch amplifier.
 *
 * Every failure raises the same `sso_failed` error. The reason is not recorded in
 * a response or a log line, and token material is never included in an error.
 */
import { createPublicKey, timingSafeEqual, verify as verifySignature } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { SsoError } from './sso-errors.js';

const MAX_TOKEN_LENGTH = 16 * 1024;
const MAX_JWKS_BYTES = 64 * 1024;
const MAX_KEY_COUNT = 32;
const CLOCK_SKEW_MS = 60 * 1000;
const JWKS_CACHE_MS = 5 * 60 * 1000;
const BASE64URL_SEGMENT = /^[A-Za-z0-9_-]+$/;
const ALLOWED_ALGORITHMS = new Set(['RS256']);

export interface OidcClaims {
  readonly subject: string;
  readonly issuer: string;
  /** Present only when the claim is a non-empty string. */
  readonly email?: string;
  /** True only for a literal boolean/string `email_verified: true` claim. */
  readonly emailVerified: boolean;
}

export interface OidcVerifierOptions {
  readonly issuer: string;
  readonly audience: string;
  readonly jwksUri: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

interface JsonWebKeyRecord {
  readonly kty?: unknown;
  readonly kid?: unknown;
  readonly use?: unknown;
  readonly alg?: unknown;
  readonly n?: unknown;
  readonly e?: unknown;
}

interface JwksCache {
  readonly fetchedAt: number;
  readonly keys: ReadonlyMap<string, KeyObject>;
}

function fail(): never {
  throw new SsoError('sso_failed');
}

function decodeJsonSegment(segment: string): Record<string, unknown> {
  if (!BASE64URL_SEGMENT.test(segment)) {
    fail();
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    fail();
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    fail();
  }

  return parsed as Record<string, unknown>;
}

function constantTimeEquals(expected: string, provided: unknown): boolean {
  if (typeof provided !== 'string') {
    return false;
  }

  const expectedBuffer = Buffer.from(expected, 'utf8');
  const providedBuffer = Buffer.from(provided, 'utf8');

  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, providedBuffer);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function audienceMatches(audience: unknown, clientId: string): boolean {
  if (typeof audience === 'string') {
    return audience === clientId;
  }

  if (Array.isArray(audience)) {
    return audience.some((value) => value === clientId);
  }

  return false;
}

export class OidcVerifier {
  private readonly issuer: string;
  private readonly audience: string;
  private readonly jwksUri: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private cache: JwksCache | undefined;

  constructor(options: OidcVerifierOptions) {
    this.issuer = options.issuer;
    this.audience = options.audience;
    this.jwksUri = options.jwksUri;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async verify(idToken: string, nonce: string): Promise<OidcClaims> {
    if (
      typeof idToken !== 'string' ||
      idToken.length === 0 ||
      idToken.length > MAX_TOKEN_LENGTH
    ) {
      fail();
    }

    const segments = idToken.split('.');

    if (segments.length !== 3) {
      fail();
    }

    const [encodedHeader, encodedPayload, encodedSignature] = segments;

    if (
      encodedHeader === undefined ||
      encodedPayload === undefined ||
      encodedSignature === undefined ||
      !BASE64URL_SEGMENT.test(encodedSignature)
    ) {
      fail();
    }

    const header = decodeJsonSegment(encodedHeader);

    if (typeof header.alg !== 'string' || !ALLOWED_ALGORITHMS.has(header.alg)) {
      fail();
    }

    // Never let a token select its own key material.
    if (header.jwk !== undefined || header.jku !== undefined || header.x5u !== undefined) {
      fail();
    }

    if (header.typ !== undefined && header.typ !== 'JWT') {
      fail();
    }

    const kid = header.kid;

    if (!isNonEmptyString(kid)) {
      fail();
    }

    const signature = Buffer.from(encodedSignature, 'base64url');
    const signedData = Buffer.from(`${encodedHeader}.${encodedPayload}`, 'ascii');
    const key = await this.resolveKey(kid);

    if (!verifySignature('RSA-SHA256', signedData, key, signature)) {
      fail();
    }

    const payload = decodeJsonSegment(encodedPayload);

    if (payload.iss !== this.issuer) {
      fail();
    }

    if (!audienceMatches(payload.aud, this.audience)) {
      fail();
    }

    // OIDC Core §3.1.3.7: when multiple audiences are present, `azp` names the
    // authorized party and must be this client.
    if (payload.azp !== undefined && payload.azp !== this.audience) {
      fail();
    }

    const now = this.now();
    const expiresAt = payload.exp;
    const issuedAt = payload.iat;

    if (
      typeof expiresAt !== 'number' ||
      !Number.isFinite(expiresAt) ||
      now >= expiresAt * 1000
    ) {
      fail();
    }

    if (
      typeof issuedAt !== 'number' ||
      !Number.isFinite(issuedAt) ||
      issuedAt * 1000 > now + CLOCK_SKEW_MS
    ) {
      fail();
    }

    if (!constantTimeEquals(nonce, payload.nonce)) {
      fail();
    }

    const subject = payload.sub;

    if (!isNonEmptyString(subject) || subject.length > 255) {
      fail();
    }

    const email =
      isNonEmptyString(payload.email) && payload.email.length <= 254
        ? payload.email
        : undefined;
    const emailVerified =
      payload.email_verified === true || payload.email_verified === 'true';

    return {
      subject,
      issuer: this.issuer,
      ...(email === undefined ? {} : { email }),
      emailVerified,
    };
  }

  private async resolveKey(kid: string): Promise<KeyObject> {
    const cached = this.cachedKey(kid);

    if (cached !== undefined) {
      return cached;
    }

    if (this.cache !== undefined && this.now() - this.cache.fetchedAt < 1000) {
      // At most one forced refresh per second: a flood of unknown `kid` values
      // cannot become a request amplifier.
      fail();
    }

    const refreshed = await this.refreshKeys();
    const key = refreshed.get(kid);

    if (key === undefined) {
      fail();
    }

    return key;
  }

  private cachedKey(kid: string): KeyObject | undefined {
    if (this.cache === undefined || this.now() - this.cache.fetchedAt >= JWKS_CACHE_MS) {
      return undefined;
    }

    return this.cache.keys.get(kid);
  }

  private async refreshKeys(): Promise<ReadonlyMap<string, KeyObject>> {
    let payload: unknown;

    try {
      const response = await this.fetchImpl(this.jwksUri, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        fail();
      }

      const text = await response.text();

      if (text.length > MAX_JWKS_BYTES) {
        fail();
      }

      payload = JSON.parse(text);
    } catch (error) {
      if (error instanceof SsoError) {
        throw error;
      }

      fail();
    }

    if (typeof payload !== 'object' || payload === null) {
      fail();
    }

    const rawKeys = (payload as { keys?: unknown }).keys;

    if (!Array.isArray(rawKeys) || rawKeys.length === 0 || rawKeys.length > MAX_KEY_COUNT) {
      fail();
    }

    const keys = new Map<string, KeyObject>();

    for (const rawKey of rawKeys) {
      if (typeof rawKey !== 'object' || rawKey === null) {
        continue;
      }

      const jwk = rawKey as JsonWebKeyRecord;
      const keyId = jwk.kid;

      if (!isNonEmptyString(keyId) || jwk.kty !== 'RSA') {
        continue;
      }

      if (jwk.use !== undefined && jwk.use !== 'sig') {
        continue;
      }

      if (jwk.alg !== undefined && jwk.alg !== 'RS256') {
        continue;
      }

      if (typeof jwk.n !== 'string' || typeof jwk.e !== 'string') {
        continue;
      }

      try {
        keys.set(
          keyId,
          createPublicKey({
            key: { kty: 'RSA', n: jwk.n, e: jwk.e },
            format: 'jwk',
          }),
        );
      } catch {
        continue;
      }
    }

    if (keys.size === 0) {
      fail();
    }

    this.cache = { fetchedAt: this.now(), keys };

    return keys;
  }
}
