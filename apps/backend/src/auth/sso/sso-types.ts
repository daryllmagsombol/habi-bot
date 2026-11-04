/**
 * Storage-neutral contracts for the SSO slice.
 *
 * Provider differences live behind `SsoProvider`: the service never sees
 * provider-specific endpoints, token shapes, or claim names. Adding a provider
 * means implementing this interface, not copying the flow.
 *
 * The repository port is intentionally coarse where atomicity matters: state
 * consumption and identity/account activation happen in one database
 * transaction inside the adapter, because a check-then-write split in the
 * service would permit double activation and invite double-spend.
 */
import type { AuthRequestContext } from '../auth-service.js';
import type { AuthSessionResult } from '../auth-types.js';
import type { AuthSessionPort } from '../auth-session-port.js';
import type { FixedWindowRateLimiter } from '../rate-limit.js';
import type { SsoConfig, SsoProviderId } from './sso-config.js';

export type { SsoProviderId };

export type SsoPurpose = 'login' | 'link';

/** A provider identity after token validation. Never persisted raw. */
export interface SsoIdentity {
  readonly provider: SsoProviderId;
  readonly subject: string;
  /** Provider-reported address, if any. Not canonicalized yet. */
  readonly email?: string;
  /** True only when the provider's trust predicate accepted `email`. */
  readonly emailVerified: boolean;
  /** Present for OIDC providers; recorded for diagnostics, never trusted alone. */
  readonly issuer?: string;
}

export interface SsoAuthorizeRequest {
  readonly state: string;
  readonly nonce: string;
  readonly codeChallenge: string;
  readonly redirectUri: string;
}

export interface SsoCodeExchangeRequest {
  readonly code: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
}

/** Transient token material. Never persisted, returned, or logged. */
export interface SsoTokenSet {
  readonly idToken?: string;
  readonly accessToken?: string;
}

export interface SsoIdentityRequest {
  readonly tokens: SsoTokenSet;
  readonly nonce: string;
}

export interface SsoProvider {
  readonly id: SsoProviderId;
  readonly displayName: string;
  readonly scopes: readonly string[];
  readonly usesOidc: boolean;
  /** Builds the provider authorization URL. Contains no secret or token. */
  authorizeUrl(input: SsoAuthorizeRequest): string;
  /** Server-to-server code exchange. Never called from the browser. */
  exchangeCode(input: SsoCodeExchangeRequest): Promise<SsoTokenSet>;
  /** Validates the token set and returns the identity proof. */
  readIdentity(input: SsoIdentityRequest): Promise<SsoIdentity>;
}

export interface SsoPendingAuthorization {
  readonly id: string;
  readonly provider: SsoProviderId;
  readonly purpose: SsoPurpose;
  readonly browserHash: string;
  readonly codeVerifier: string;
  readonly nonce: string;
  readonly redirectUri: string;
  readonly returnTo: string;
  readonly userId: string | null;
  readonly sessionHash: string | null;
  readonly inviteTokenHash: string | null;
  readonly expiresAt: number;
}

export interface CreatePendingAuthorizationInput {
  readonly stateHash: string;
  readonly browserHash: string;
  readonly provider: SsoProviderId;
  readonly purpose: SsoPurpose;
  readonly codeVerifier: string;
  readonly nonce: string;
  readonly redirectUri: string;
  readonly returnTo: string;
  readonly userId?: string;
  readonly sessionHash?: string;
  readonly inviteTokenHash?: string;
  readonly at: Date;
  readonly expiresAt: Date;
}

export interface SsoAccount {
  readonly userId: string;
  readonly email: string;
}

export interface SsoIdentityRecord {
  readonly userId: string;
  readonly revokedAt: number | null;
}

export interface SsoLinkedIdentity {
  readonly provider: SsoProviderId;
  readonly email: string | null;
  readonly emailTrusted: boolean;
  readonly linkedAt: string;
  readonly lastLoginAt: string | null;
}

export interface CompleteSsoLoginInput {
  readonly pendingId: string;
  readonly provider: SsoProviderId;
  /** Canonical provider email, only when the trust predicate accepted it. */
  readonly email: string | undefined;
  readonly subject: string;
  /** False when `HABI_REGISTRATION_MODE=closed`; existing identities still sign in. */
  readonly allowRegistration: boolean;
  readonly at: Date;
}

export interface CompleteSsoLoginResult extends SsoAccount {
  readonly created: boolean;
}

export interface CompleteSsoLinkInput {
  readonly pendingId: string;
  readonly provider: SsoProviderId;
  readonly subject: string;
  readonly email: string;
  readonly userId: string;
  readonly at: Date;
}

export interface UnlinkIdentityInput {
  readonly userId: string;
  readonly provider: SsoProviderId;
  readonly at: Date;
}

export interface SsoRepositoryPort {
  createPending(input: CreatePendingAuthorizationInput): Promise<void>;
  /** Non-consuming lookup used to validate the browser binding first. */
  findPending(
    stateHash: string,
    provider: SsoProviderId,
    at: Date,
  ): Promise<SsoPendingAuthorization | undefined>;
  /**
   * Consumes the pending record and resolves the identity in one transaction:
   * existing identity -> sign in; new identity -> invite-gated account creation.
   * Throws a closed `SsoError` on any refusal; nothing is partially written.
   */
  completeLogin(input: CompleteSsoLoginInput): Promise<CompleteSsoLoginResult>;
  /**
   * Consumes the pending record and attaches the identity to the initiating
   * user in one transaction. The provider email must equal the account's
   * canonical email; a mismatch or an identity owned by someone else is
   * `link_unavailable`.
   */
  completeLink(input: CompleteSsoLinkInput): Promise<void>;
  findIdentity(
    provider: SsoProviderId,
    subject: string,
  ): Promise<SsoIdentityRecord | undefined>;
  listIdentities(userId: string): Promise<SsoLinkedIdentity[]>;
  /** Revokes every active identity for one provider; blocks the last method. */
  unlinkIdentity(input: UnlinkIdentityInput): Promise<void>;
}

/**
 * Session operations the SSO slice needs. Extends the H-014 issuance port with
 * validation for link/unlink, so the SSO module never re-implements the H-017
 * session rules.
 */
export interface SsoSessionPort extends AuthSessionPort {
  validate(
    sessionSecret: string,
    at: number,
  ): { userId: string; csrfToken: string } | undefined;
}

export interface SsoRequestContext extends AuthRequestContext {
  readonly origin?: string;
}

export interface SsoStartInput extends SsoRequestContext {
  readonly providerId: SsoProviderId;
  readonly inviteToken?: string;
  readonly returnTo?: string;
}

export interface SsoStartResult {
  readonly authorizeUrl: string;
  readonly bindingSecret: string;
  readonly bindingMaxAgeSeconds: number;
}

export interface SsoCallbackInput extends SsoRequestContext {
  readonly providerId: SsoProviderId;
  readonly state?: string;
  readonly code?: string;
  readonly providerError?: string;
  readonly bindingSecret?: string;
  /** Present only when the initiating session is still offered by the browser. */
  readonly sessionSecret?: string;
}

export type SsoCallbackResult =
  | {
      readonly kind: 'login';
      readonly session: AuthSessionResult;
      readonly returnTo: string;
    }
  | {
      readonly kind: 'link';
      readonly provider: SsoProviderId;
      readonly returnTo: string;
    };

export interface SsoLinkStartInput extends SsoRequestContext {
  readonly providerId: SsoProviderId;
  readonly userId: string;
  readonly sessionSecret: string;
  readonly returnTo?: string;
}

export interface SsoUnlinkInput {
  readonly providerId: SsoProviderId;
  readonly userId: string;
}

export interface SsoServiceOptions {
  readonly config: SsoConfig;
  readonly providers: ReadonlyMap<SsoProviderId, SsoProvider>;
  readonly repository: SsoRepositoryPort;
  readonly sessions: SsoSessionPort;
  readonly now?: () => number;
  readonly limiter?: FixedWindowRateLimiter;
}
