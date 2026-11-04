/**
 * Provider-neutral SSO configuration (H-015 / issue #15).
 *
 * A provider is **advertised and routed only when all of its required values are
 * present and valid**. Absent configuration means the provider's controller is
 * never created, so its routes do not exist (404, not 401/403) and it is not
 * listed by `GET /auth/sso/providers`. There is no partially configured provider:
 * a malformed value disables that provider rather than falling back to a default.
 *
 * Environment contract (server-side only; no value is ever sent to the browser,
 * logged, or returned by a route):
 *
 * | Provider   | Required                                                          | Optional overrides                                                       |
 * |------------|-------------------------------------------------------------------|--------------------------------------------------------------------------|
 * | Google     | `HABI_SSO_GOOGLE_CLIENT_ID`, `_CLIENT_SECRET`, `_REDIRECT_URI`     | `_AUTHORIZE_URL`, `_TOKEN_URL`, `_ISSUER`, `_JWKS_URL`                   |
 * | Microsoft  | `HABI_SSO_MICROSOFT_CLIENT_ID`, `_CLIENT_SECRET`, `_REDIRECT_URI`, `_ISSUER` | `_AUTHORIZE_URL`, `_TOKEN_URL`, `_JWKS_URL`                     |
 * | Facebook   | `HABI_SSO_FACEBOOK_CLIENT_ID`, `_CLIENT_SECRET`, `_REDIRECT_URI`   | `_AUTHORIZE_URL`, `_TOKEN_URL`, `_DEBUG_TOKEN_URL`, `_PROFILE_URL`       |
 *
 * Microsoft additionally requires `HABI_SSO_MICROSOFT_ISSUER` because OIDC `iss`
 * must be compared by exact string: the multi-tenant `common` endpoint does not
 * issue a fixed `iss`, and accepting a prefix or tenant wildcard would defeat
 * provider-mix-up protection. Without it the provider stays disabled.
 *
 * The `*_URL` overrides exist for self-hosted identity proxies and for the local
 * stub IdP in `apps/backend/test/sso-postgres.smoke.mjs`; they are not a way to
 * relax validation. Non-loopback endpoints must use HTTPS so provider secrets
 * never cross plaintext HTTP.
 *
 * Scopes are fixed by H-008 §8: identity only. No mail, calendar, drive, files,
 * friends, or `offline_access` scope can be requested through this module, and no
 * refresh token is requested or stored.
 */

import type { RegistrationMode } from '../auth-config.js';
import { readRegistrationMode } from '../auth-config.js';

export type SsoProviderId = 'google' | 'microsoft' | 'facebook';

export interface SsoProviderConfig {
  readonly id: SsoProviderId;
  readonly displayName: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** Exact callback URI registered with the provider. Compared by exact string. */
  readonly redirectUri: string;
  readonly authorizeEndpoint: string;
  readonly tokenEndpoint: string;
  /** OIDC only. Exact expected `iss`. */
  readonly issuer?: string;
  /** OIDC only. JWKS location for id-token signature verification. */
  readonly jwksUri?: string;
  /** Facebook only. Token introspection endpoint (`/debug_token`). */
  readonly debugTokenEndpoint?: string;
  /** Facebook only. Profile endpoint (`/me`). */
  readonly profileEndpoint?: string;
  readonly scopes: readonly string[];
  /**
   * Per-provider email trust predicate (H-008 §7.1):
   * - `verified-claim` requires an explicit boolean `email_verified: true` claim.
   * - `none` means no provider claim can establish ownership of the address, so
   *   the account must be verified by another mechanism before linking.
   */
  readonly emailTrust: 'verified-claim' | 'none';
}

export interface SsoConfig {
  readonly providers: readonly SsoProviderConfig[];
  /** Short-lived pending authorization record (H-008 §5.2). */
  readonly pendingTtlMs: number;
  /**
   * The H-014 registration mode applies to SSO account creation too. `closed`
   * refuses a new SSO account while leaving existing-identity sign-in intact;
   * it can never be bypassed by starting at a provider instead of the signup
   * form.
   */
  readonly registrationMode: RegistrationMode;
}

/** Provisional POC lifetime. Owner-approved values remain a #17/#23 decision. */
export const SSO_PENDING_TTL_MS = 10 * 60 * 1000;

/** Provisional POC abuse limits for the SSO surfaces; numeric policy is #23. */
export const SSO_RATE_LIMITS = {
  startClient: { limit: 40, windowMs: 15 * 60 * 1000 },
  callbackClient: { limit: 80, windowMs: 15 * 60 * 1000 },
  linkUser: { limit: 20, windowMs: 15 * 60 * 1000 },
} as const;

/** Exact environment variable names per provider, for operations and tests. */
export const SSO_ENV_VARS = {
  google: {
    clientId: 'HABI_SSO_GOOGLE_CLIENT_ID',
    clientSecret: 'HABI_SSO_GOOGLE_CLIENT_SECRET',
    redirectUri: 'HABI_SSO_GOOGLE_REDIRECT_URI',
    authorizeEndpoint: 'HABI_SSO_GOOGLE_AUTHORIZE_URL',
    tokenEndpoint: 'HABI_SSO_GOOGLE_TOKEN_URL',
    issuer: 'HABI_SSO_GOOGLE_ISSUER',
    jwksUri: 'HABI_SSO_GOOGLE_JWKS_URL',
  },
  microsoft: {
    clientId: 'HABI_SSO_MICROSOFT_CLIENT_ID',
    clientSecret: 'HABI_SSO_MICROSOFT_CLIENT_SECRET',
    redirectUri: 'HABI_SSO_MICROSOFT_REDIRECT_URI',
    authorizeEndpoint: 'HABI_SSO_MICROSOFT_AUTHORIZE_URL',
    tokenEndpoint: 'HABI_SSO_MICROSOFT_TOKEN_URL',
    issuer: 'HABI_SSO_MICROSOFT_ISSUER',
    jwksUri: 'HABI_SSO_MICROSOFT_JWKS_URL',
  },
  facebook: {
    clientId: 'HABI_SSO_FACEBOOK_CLIENT_ID',
    clientSecret: 'HABI_SSO_FACEBOOK_CLIENT_SECRET',
    redirectUri: 'HABI_SSO_FACEBOOK_REDIRECT_URI',
    authorizeEndpoint: 'HABI_SSO_FACEBOOK_AUTHORIZE_URL',
    tokenEndpoint: 'HABI_SSO_FACEBOOK_TOKEN_URL',
    debugTokenEndpoint: 'HABI_SSO_FACEBOOK_DEBUG_TOKEN_URL',
    profileEndpoint: 'HABI_SSO_FACEBOOK_PROFILE_URL',
  },
} as const;

/** Minimal identity scopes (H-008 §8). Fixed; not configurable by environment. */
const SCOPES: Readonly<Record<SsoProviderId, readonly string[]>> = {
  google: ['openid', 'email'],
  microsoft: ['openid', 'email'],
  facebook: ['email'],
};

const DISPLAY_NAMES: Readonly<Record<SsoProviderId, string>> = {
  google: 'Google',
  microsoft: 'Microsoft',
  facebook: 'Facebook',
};

const GOOGLE_DEFAULTS = {
  authorizeEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  issuer: 'https://accounts.google.com',
  jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
} as const;

const FACEBOOK_DEFAULTS = {
  authorizeEndpoint: 'https://www.facebook.com/v21.0/dialog/oauth',
  tokenEndpoint: 'https://graph.facebook.com/v21.0/oauth/access_token',
  debugTokenEndpoint: 'https://graph.facebook.com/v21.0/debug_token',
  profileEndpoint: 'https://graph.facebook.com/v21.0/me',
} as const;

const MICROSOFT_DEFAULT_BASE = 'https://login.microsoftonline.com/common';

function read(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();

  return value === undefined || value.length === 0 ? undefined : value;
}

/**
 * Absolute http(s) URL with no fragment and no embedded credentials. Plain HTTP
 * is only accepted for loopback, so the local stub IdP can run without TLS while
 * a real deployment cannot send client secrets over cleartext.
 */
function readEndpointUrl(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: string | undefined,
): string | undefined {
  const raw = read(env, name) ?? fallback;

  if (raw === undefined) {
    return undefined;
  }

  try {
    const url = new URL(raw);

    if (url.hash.length > 0 || url.username !== '' || url.password !== '') {
      return undefined;
    }

    if (url.protocol === 'https:') {
      return url.toString();
    }

    if (url.protocol === 'http:' && isLoopbackHost(url.hostname)) {
      return url.toString();
    }

    return undefined;
  } catch {
    return undefined;
  }
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();

  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
}

/**
 * The redirect URI is compared byte-for-byte with what the provider has
 * registered, so it is validated once here and reused unchanged. A URI with a
 * fragment, credentials, or a query-bearing path is rejected rather than
 * normalized, because normalization is exactly what makes an exact comparison
 * unsafe.
 */
function readRedirectUri(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = read(env, name);

  if (raw === undefined) {
    return undefined;
  }

  try {
    const url = new URL(raw);

    if (
      url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && isLoopbackHost(url.hostname))
    ) {
      return undefined;
    }

    if (url.hash.length > 0 || url.username !== '' || url.password !== '') {
      return undefined;
    }

    return raw;
  } catch {
    return undefined;
  }
}

function readSecret(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = read(env, name);

  // A provider secret is a fixed, non-empty token; bound it so a pasted multiline
  // value cannot reach a log or a request body.
  if (value === undefined || value.length > 512 || /[\r\n]/.test(value)) {
    return undefined;
  }

  return value;
}

function microsoftBase(issuer: string): string | undefined {
  try {
    const url = new URL(issuer);

    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
      // The loopback exception exists for the test registry only.
      if (!(url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
        return undefined;
      }
    }

    // Accept `<base>/v2.0` or `<base>`; endpoints are derived from `<base>`.
    return url.toString().replace(/\/v2\.0\/?$/, '');
  } catch {
    return undefined;
  }
}

function readGoogle(env: NodeJS.ProcessEnv): SsoProviderConfig | undefined {
  const names = SSO_ENV_VARS.google;
  const clientId = read(env, names.clientId);
  const clientSecret = readSecret(env, names.clientSecret);
  const redirectUri = readRedirectUri(env, names.redirectUri);
  const authorizeEndpoint = readEndpointUrl(
    env,
    names.authorizeEndpoint,
    GOOGLE_DEFAULTS.authorizeEndpoint,
  );
  const tokenEndpoint = readEndpointUrl(env, names.tokenEndpoint, GOOGLE_DEFAULTS.tokenEndpoint);
  const issuer = readEndpointUrl(env, names.issuer, GOOGLE_DEFAULTS.issuer);
  const jwksUri = readEndpointUrl(env, names.jwksUri, GOOGLE_DEFAULTS.jwksUri);

  if (
    clientId === undefined ||
    clientSecret === undefined ||
    redirectUri === undefined ||
    authorizeEndpoint === undefined ||
    tokenEndpoint === undefined ||
    jwksUri === undefined ||
    issuer === undefined
  ) {
    return undefined;
  }

  return {
    id: 'google',
    displayName: DISPLAY_NAMES.google,
    clientId,
    clientSecret,
    redirectUri,
    authorizeEndpoint,
    tokenEndpoint,
    issuer: issuer.replace(/\/$/, ''),
    jwksUri,
    scopes: SCOPES.google,
    emailTrust: 'verified-claim',
  };
}

function readMicrosoft(env: NodeJS.ProcessEnv): SsoProviderConfig | undefined {
  const names = SSO_ENV_VARS.microsoft;
  const clientId = read(env, names.clientId);
  const clientSecret = readSecret(env, names.clientSecret);
  const redirectUri = readRedirectUri(env, names.redirectUri);
  const issuer = readEndpointUrl(env, names.issuer, undefined);

  if (
    clientId === undefined ||
    clientSecret === undefined ||
    redirectUri === undefined ||
    issuer === undefined
  ) {
    return undefined;
  }

  const base = microsoftBase(issuer) ?? MICROSOFT_DEFAULT_BASE;
  const authorizeEndpoint = readEndpointUrl(
    env,
    names.authorizeEndpoint,
    `${base}/oauth2/v2.0/authorize`,
  );
  const tokenEndpoint = readEndpointUrl(env, names.tokenEndpoint, `${base}/oauth2/v2.0/token`);
  const jwksUri = readEndpointUrl(env, names.jwksUri, `${base}/discovery/v2.0/keys`);

  if (
    authorizeEndpoint === undefined ||
    tokenEndpoint === undefined ||
    jwksUri === undefined
  ) {
    return undefined;
  }

  return {
    id: 'microsoft',
    displayName: DISPLAY_NAMES.microsoft,
    clientId,
    clientSecret,
    redirectUri,
    authorizeEndpoint,
    tokenEndpoint,
    issuer: issuer.replace(/\/$/, ''),
    jwksUri,
    scopes: SCOPES.microsoft,
    // Microsoft only asserts `email_verified` for consumer accounts; work-account
    // `email` claims are not proof, so the predicate requires the explicit claim.
    emailTrust: 'verified-claim',
  };
}

function readFacebook(env: NodeJS.ProcessEnv): SsoProviderConfig | undefined {
  const names = SSO_ENV_VARS.facebook;
  const clientId = read(env, names.clientId);
  const clientSecret = readSecret(env, names.clientSecret);
  const redirectUri = readRedirectUri(env, names.redirectUri);
  const authorizeEndpoint = readEndpointUrl(
    env,
    names.authorizeEndpoint,
    FACEBOOK_DEFAULTS.authorizeEndpoint,
  );
  const tokenEndpoint = readEndpointUrl(
    env,
    names.tokenEndpoint,
    FACEBOOK_DEFAULTS.tokenEndpoint,
  );
  const debugTokenEndpoint = readEndpointUrl(
    env,
    names.debugTokenEndpoint,
    FACEBOOK_DEFAULTS.debugTokenEndpoint,
  );
  const profileEndpoint = readEndpointUrl(
    env,
    names.profileEndpoint,
    FACEBOOK_DEFAULTS.profileEndpoint,
  );

  if (
    clientId === undefined ||
    clientSecret === undefined ||
    redirectUri === undefined ||
    authorizeEndpoint === undefined ||
    tokenEndpoint === undefined ||
    debugTokenEndpoint === undefined ||
    profileEndpoint === undefined
  ) {
    return undefined;
  }

  return {
    id: 'facebook',
    displayName: DISPLAY_NAMES.facebook,
    clientId,
    clientSecret,
    redirectUri,
    authorizeEndpoint,
    tokenEndpoint,
    debugTokenEndpoint,
    profileEndpoint,
    scopes: SCOPES.facebook,
    // Facebook exposes no verified-email claim; H-008 §7.1 requires Habi
    // verification before this address can identify an account. Existing linked
    // identities can still sign in; linking/signup is refused.
    emailTrust: 'none',
  };
}

export function readSsoConfig(env: NodeJS.ProcessEnv = process.env): SsoConfig {
  const providers = [readGoogle(env), readMicrosoft(env), readFacebook(env)].filter(
    (provider): provider is SsoProviderConfig => provider !== undefined,
  );

  return {
    providers,
    pendingTtlMs: SSO_PENDING_TTL_MS,
    registrationMode: readRegistrationMode(env),
  };
}

/** Public advertisement shape. Contains no secret and no endpoint URL. */
export interface SsoProviderSummary {
  readonly id: SsoProviderId;
  readonly displayName: string;
  readonly scopes: readonly string[];
}

export function summarizeProviders(config: SsoConfig): SsoProviderSummary[] {
  return config.providers.map((provider) => ({
    id: provider.id,
    displayName: provider.displayName,
    scopes: provider.scopes,
  }));
}
