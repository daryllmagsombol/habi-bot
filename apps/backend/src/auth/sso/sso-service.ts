/**
 * Provider-neutral SSO orchestration.
 *
 * One flow for every provider:
 *
 *   start    -> mint state/browser/PKCE/nonce, persist a pending record, return
 *               the provider URL plus the browser-binding cookie value
 *   callback -> validate state, browser binding, redirect URI and (for linking)
 *               the same live session; exchange the code server-to-server;
 *               validate the identity; consume the pending record and either
 *               sign in, create an invite-gated account, or link
 *
 * Security properties implemented here:
 *
 * - `state` is random, stored hashed, single-use, and short-lived.
 * - The PKCE verifier and OIDC nonce never leave the server; only the S256
 *   challenge and the nonce are sent to the provider.
 * - The browser binding is a separate cookie, so a valid `state` captured by an
 *   attacker is useless in another browser.
 * - The redirect URI used for the exchange is the stored one and is compared by
 *   exact string with the configured value.
 * - The provider's answer is never trusted directly: `readIdentity` verifies the
 *   signature/claims (OIDC) or debugs the token and checks the app/user (Facebook).
 * - An unverified provider email cannot create or attach an account.
 * - New accounts still pass the H-014 invite gate; failures use the same
 *   `signup_unavailable` response so SSO cannot enumerate accounts or invites.
 * - No token, code, or verifier is put in a URL or a JSON body; the only places
 *   they travel are the provider request (server-side) and `Set-Cookie`.
 *
 * `start` is a POST, `callback` is a GET (the narrow protocol exception from
 * H-008 §5.4). Every other operation is a POST.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { canonicalizeEmail } from '../email.js';
import { FixedWindowRateLimiter, rateLimitKey } from '../rate-limit.js';
import { hashToken, mintToken } from '../tokens.js';
import { SSO_RATE_LIMITS } from './sso-config.js';
import { SsoError } from './sso-errors.js';
import type { SsoProviderConfig } from './sso-config.js';
import type {
  SsoCallbackInput,
  SsoCallbackResult,
  SsoIdentity,
  SsoLinkStartInput,
  SsoLinkedIdentity,
  SsoPendingAuthorization,
  SsoProvider,
  SsoProviderId,
  SsoServiceOptions,
  SsoSessionPort,
  SsoStartInput,
  SsoStartResult,
  SsoUnlinkInput,
} from './sso-types.js';

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;
const CODE_SHAPE = /^[\x21-\x7e]{1,4096}$/;
const MAX_INVITE_TOKEN_LENGTH = 512;
const MAX_RETURN_PATH_LENGTH = 512;

function codeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/** C0 controls and DEL; optionally also rejects any ASCII space. */
function hasControlCharacter(value: string, includeSpace = false): boolean {
  const space = 0x20;

  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;

    if (code < space || code === 0x7f || (includeSpace && code === space)) {
      return true;
    }
  }

  return false;
}

function constantTimeEquals(expected: string, provided: string): boolean {
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const providedBuffer = Buffer.from(provided, 'utf8');

  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, providedBuffer);
}

/**
 * Only relative, server-validated post-login paths are accepted. Anything with a
 * scheme, a network-path reference (`//host`), a backslash, or a control
 * character is rejected rather than rewritten, so no open redirect exists.
 */
export function safeReturnPath(raw: unknown): string {
  if (raw === undefined || raw === null || raw === '') {
    return '/';
  }

  if (typeof raw !== 'string') {
    throw new SsoError('invalid_request');
  }

  if (
    raw.length > MAX_RETURN_PATH_LENGTH ||
    !raw.startsWith('/') ||
    raw.startsWith('//') ||
    raw.includes('\\') ||
    hasControlCharacter(raw)
  ) {
    throw new SsoError('invalid_request');
  }

  try {
    const resolved = new URL(raw, 'http://relative.invalid');

    if (resolved.origin !== 'http://relative.invalid') {
      throw new SsoError('invalid_request');
    }
  } catch {
    throw new SsoError('invalid_request');
  }

  return raw;
}

interface CallbackCredentials {
  readonly state: string;
  readonly code: string;
  readonly bindingSecret: string;
}

function readCallbackCredentials(input: SsoCallbackInput): CallbackCredentials {
  // A provider error (user cancelled, access denied) is never echoed. It is
  // one uniform failure so provider text cannot reach a response or a log.
  if (input.providerError !== undefined) {
    throw new SsoError('sso_failed');
  }

  const { state, code, bindingSecret } = input;

  if (
    state === undefined ||
    code === undefined ||
    bindingSecret === undefined ||
    !TOKEN_SHAPE.test(state) ||
    !TOKEN_SHAPE.test(bindingSecret) ||
    !CODE_SHAPE.test(code)
  ) {
    throw new SsoError('sso_state_invalid');
  }

  return { state, code, bindingSecret };
}

/** A link callback must prove the same live session that started the link. */
function assertLinkSession(
  sessions: SsoSessionPort,
  pending: SsoPendingAuthorization,
  sessionSecret: string | undefined,
  at: number,
): void {
  const session =
    sessionSecret === undefined ? undefined : sessions.validate(sessionSecret, at);

  if (
    session === undefined ||
    pending.userId === null ||
    pending.sessionHash === null ||
    session.userId !== pending.userId ||
    !constantTimeEquals(pending.sessionHash, hashToken(sessionSecret ?? ''))
  ) {
    throw new SsoError('unauthenticated');
  }
}

/** Only a provider-trusted address may create or link an account. */
function verifiedEmailOf(identity: SsoIdentity): string | undefined {
  const canonicalEmail =
    identity.email === undefined ? undefined : canonicalizeEmail(identity.email);

  return identity.emailVerified && canonicalEmail !== undefined
    ? canonicalEmail
    : undefined;
}

export class SsoService {
  private readonly config: SsoServiceOptions['config'];
  private readonly providers: ReadonlyMap<SsoProviderId, SsoProvider>;
  private readonly repository: SsoServiceOptions['repository'];
  private readonly sessions: SsoServiceOptions['sessions'];
  private readonly now: () => number;
  private readonly limiter: FixedWindowRateLimiter;

  constructor(options: SsoServiceOptions) {
    this.config = options.config;
    this.providers = options.providers;
    this.repository = options.repository;
    this.sessions = options.sessions;
    this.now = options.now ?? Date.now;
    this.limiter = options.limiter ?? new FixedWindowRateLimiter(this.now);
  }

  async start(input: SsoStartInput): Promise<SsoStartResult> {
    const at = this.now();
    const provider = this.provider(input.providerId);
    this.enforceLimit(
      'sso:start:client',
      input.clientKey,
      SSO_RATE_LIMITS.startClient,
      at,
    );

    const invitation = this.readInviteToken(input.inviteToken);
    const returnTo = safeReturnPath(input.returnTo);
    const state = mintToken();
    const bindingSecret = mintToken();
    const verifier = mintToken();
    const nonce = mintToken();

    await this.repository.createPending({
      stateHash: hashToken(state),
      browserHash: hashToken(bindingSecret),
      provider: provider.id,
      purpose: 'login',
      codeVerifier: verifier,
      nonce,
      redirectUri: this.providerConfig(provider.id).redirectUri,
      returnTo,
      ...(invitation === undefined ? {} : { inviteTokenHash: hashToken(invitation) }),
      at: new Date(at),
      expiresAt: new Date(at + this.config.pendingTtlMs),
    });

    return {
      authorizeUrl: provider.authorizeUrl({
        state,
        nonce,
        codeChallenge: codeChallenge(verifier),
        redirectUri: this.providerConfig(provider.id).redirectUri,
      }),
      bindingSecret,
      bindingMaxAgeSeconds: Math.ceil(this.config.pendingTtlMs / 1000),
    };
  }

  async linkStart(input: SsoLinkStartInput): Promise<SsoStartResult> {
    const at = this.now();
    const provider = this.provider(input.providerId);
    this.enforceLimit('sso:link:user', input.userId, SSO_RATE_LIMITS.linkUser, at);

    const returnTo = safeReturnPath(input.returnTo);
    const state = mintToken();
    const bindingSecret = mintToken();
    const verifier = mintToken();
    const nonce = mintToken();

    await this.repository.createPending({
      stateHash: hashToken(state),
      browserHash: hashToken(bindingSecret),
      provider: provider.id,
      purpose: 'link',
      codeVerifier: verifier,
      nonce,
      redirectUri: this.providerConfig(provider.id).redirectUri,
      returnTo,
      userId: input.userId,
      sessionHash: hashToken(input.sessionSecret),
      at: new Date(at),
      expiresAt: new Date(at + this.config.pendingTtlMs),
    });

    return {
      authorizeUrl: provider.authorizeUrl({
        state,
        nonce,
        codeChallenge: codeChallenge(verifier),
        redirectUri: this.providerConfig(provider.id).redirectUri,
      }),
      bindingSecret,
      bindingMaxAgeSeconds: Math.ceil(this.config.pendingTtlMs / 1000),
    };
  }

  async callback(input: SsoCallbackInput): Promise<SsoCallbackResult> {
    const at = this.now();
    const provider = this.provider(input.providerId);
    this.enforceLimit(
      'sso:callback:client',
      input.clientKey,
      SSO_RATE_LIMITS.callbackClient,
      at,
    );

    const credentials = readCallbackCredentials(input);
    const pending = await this.resolvePending(
      provider,
      credentials.state,
      credentials.bindingSecret,
      at,
    );

    if (pending.purpose === 'link') {
      assertLinkSession(this.sessions, pending, input.sessionSecret, at);
    }

    const tokens = await this.callProvider(() =>
      provider.exchangeCode({
        code: credentials.code,
        codeVerifier: pending.codeVerifier,
        redirectUri: pending.redirectUri,
      }),
    );

    const identity = await this.callProvider(() =>
      provider.readIdentity({ tokens, nonce: pending.nonce }),
    );

    if (identity.provider !== provider.id) {
      throw new SsoError('sso_failed');
    }

    const verifiedEmail = verifiedEmailOf(identity);

    if (pending.purpose === 'link') {
      return this.completeLinkCallback(pending, identity, verifiedEmail, provider, at);
    }

    return this.completeLoginCallback(
      pending,
      identity,
      verifiedEmail,
      provider,
      input,
      at,
    );
  }

  async listIdentities(userId: string): Promise<SsoLinkedIdentity[]> {
    return this.repository.listIdentities(userId);
  }

  async unlink(input: SsoUnlinkInput): Promise<void> {
    // The provider must be configured; a disabled provider has no route at all.
    this.provider(input.providerId);
    await this.repository.unlinkIdentity({
      userId: input.userId,
      provider: input.providerId,
      at: new Date(this.now()),
    });
  }

  private async resolvePending(
    provider: SsoProvider,
    state: string,
    bindingSecret: string,
    at: number,
  ): Promise<SsoPendingAuthorization> {
    const pending = await this.repository.findPending(
      hashToken(state),
      provider.id,
      new Date(at),
    );

    if (pending === undefined) {
      throw new SsoError('sso_state_invalid');
    }

    // Independent browser binding. A stolen state cannot complete elsewhere.
    if (!constantTimeEquals(pending.browserHash, hashToken(bindingSecret))) {
      throw new SsoError('sso_state_invalid');
    }

    // Exact redirect URI comparison. A stored value that does not equal the
    // configured value means the flow was created under another configuration.
    if (pending.redirectUri !== this.providerConfig(provider.id).redirectUri) {
      throw new SsoError('sso_state_invalid');
    }

    return pending;
  }

  private async completeLinkCallback(
    pending: SsoPendingAuthorization,
    identity: SsoIdentity,
    verifiedEmail: string | undefined,
    provider: SsoProvider,
    at: number,
  ): Promise<SsoCallbackResult> {
    if (pending.userId === null) {
      throw new SsoError('sso_state_invalid');
    }

    if (verifiedEmail === undefined) {
      throw new SsoError('sso_email_unverified');
    }

    await this.repository.completeLink({
      pendingId: pending.id,
      provider: provider.id,
      subject: identity.subject,
      email: verifiedEmail,
      userId: pending.userId,
      at: new Date(at),
    });

    return { kind: 'link', provider: provider.id, returnTo: pending.returnTo };
  }

  private async completeLoginCallback(
    pending: SsoPendingAuthorization,
    identity: SsoIdentity,
    verifiedEmail: string | undefined,
    provider: SsoProvider,
    input: SsoCallbackInput,
    at: number,
  ): Promise<SsoCallbackResult> {
    const account = await this.repository.completeLogin({
      pendingId: pending.id,
      provider: provider.id,
      subject: identity.subject,
      email: verifiedEmail,
      allowRegistration: this.config.registrationMode !== 'closed',
      at: new Date(at),
    });

    // Rotation on authentication: the presented session (if any) is retired and
    // a brand-new family is issued. A client-supplied identifier is never adopted.
    if (input.sessionSecret !== undefined) {
      this.sessions.revoke(input.sessionSecret, at);
    }

    const issued = this.sessions.issue(
      account.userId,
      {
        ...(input.userAgent === undefined ? {} : { userAgent: input.userAgent }),
        ...(input.ip === undefined ? {} : { ip: input.ip }),
      },
      at,
    );

    return {
      kind: 'login',
      session: {
        user: { userId: account.userId, email: account.email },
        sessionSecret: issued.sessionSecret,
        csrfToken: issued.csrfToken,
        maxAgeSeconds: issued.maxAgeSeconds,
      },
      returnTo: pending.returnTo,
    };
  }

  private provider(id: SsoProviderId): SsoProvider {
    const provider = this.providers.get(id);

    if (provider === undefined) {
      throw new SsoError('not_found');
    }

    return provider;
  }

  private providerConfig(id: SsoProviderId): SsoProviderConfig {
    const config = this.config.providers.find((candidate) => candidate.id === id);

    if (config === undefined) {
      throw new SsoError('not_found');
    }

    return config;
  }

  private readInviteToken(raw: string | undefined): string | undefined {
    if (raw === undefined || raw === '') {
      return undefined;
    }

    if (raw.length > MAX_INVITE_TOKEN_LENGTH || hasControlCharacter(raw, true)) {
      throw new SsoError('invalid_request');
    }

    return raw;
  }

  /**
   * Any provider/network/parse failure becomes the uniform `sso_failed`. The
   * original error is not attached: its message can contain a provider error
   * description or a URL with a code in it.
   */
  private async callProvider<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof SsoError) {
        throw error;
      }

      throw new SsoError('sso_failed');
    }
  }

  private enforceLimit(
    scope: string,
    key: string,
    rule: { readonly limit: number; readonly windowMs: number },
    at: number,
  ): void {
    const decision = this.limiter.consume(rateLimitKey(scope, key), rule, at);

    if (!decision.allowed) {
      throw new SsoError('rate_limited', {
        retryAfterSeconds: decision.retryAfterSeconds,
      });
    }
  }
}
