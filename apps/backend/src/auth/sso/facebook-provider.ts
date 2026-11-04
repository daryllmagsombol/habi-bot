/**
 * Facebook Login (authorization-code + PKCE) identity verification.
 *
 * Facebook is not an OIDC provider: there is no id_token and no signature to
 * verify. The access token is instead validated against the Graph debugging
 * endpoint, and the app identity is checked there:
 *
 *   - `data.is_valid === true`
 *   - `data.app_id === configured client id` (token was minted for this app)
 *   - `data.user_id === profile.id` (the profile read with that token is the
 *     subject the token was issued for)
 *
 * That combination prevents token substitution (H-008 §10). The app access token
 * used for debugging (`app_id|app_secret`) is sent in a POST body, and the user
 * access token is sent to the profile endpoint in an Authorization header, so no
 * token appears in a browser-visible URL.
 *
 * Facebook exposes no verified-email claim, so `emailVerified` is always false.
 * H-008 §7.1 requires Habi verification before that address can identify an
 * account; an existing linked identity can still sign in.
 */
import type { SsoIdentity, SsoProvider, SsoProviderId, SsoTokenSet } from './sso-types.js';
import type { SsoProviderConfig } from './sso-config.js';
import { SsoError } from './sso-errors.js';

const MAX_RESPONSE_BYTES = 16 * 1024;

function fail(): never {
  throw new SsoError('sso_failed');
}

async function readJsonObject(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) {
    fail();
  }

  const text = await response.text();

  if (text.length === 0 || text.length > MAX_RESPONSE_BYTES) {
    fail();
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    fail();
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    fail();
  }

  return parsed as Record<string, unknown>;
}

function readDebuggedUserId(
  debug: Record<string, unknown>,
  clientId: string,
): string {
  const data = debug.data;

  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    fail();
  }

  const record = data as Record<string, unknown>;

  if (record.is_valid !== true) {
    fail();
  }

  // The token must have been minted for this app, not another one.
  if (record.app_id !== clientId) {
    fail();
  }

  const userId = record.user_id;

  if (typeof userId !== 'string' || userId.length === 0) {
    fail();
  }

  return userId;
}

function readProfileEmail(profile: Record<string, unknown>): string | undefined {
  const email = profile.email;

  if (
    typeof email !== 'string' ||
    email.trim().length === 0 ||
    email.length > 254
  ) {
    return undefined;
  }

  return email;
}

export class FacebookSsoProvider implements SsoProvider {
  readonly id: SsoProviderId = 'facebook';
  readonly displayName: string;
  readonly scopes: readonly string[];
  readonly usesOidc = false;
  private readonly config: SsoProviderConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(config: SsoProviderConfig, fetchImpl: typeof fetch = fetch) {
    if (
      config.debugTokenEndpoint === undefined ||
      config.profileEndpoint === undefined
    ) {
      throw new Error('Facebook provider requires debug-token and profile endpoints');
    }

    this.config = config;
    this.fetchImpl = fetchImpl;
    this.displayName = config.displayName;
    this.scopes = config.scopes;
  }

  authorizeUrl(input: {
    state: string;
    nonce: string;
    codeChallenge: string;
    redirectUri: string;
  }): string {
    const url = new URL(this.config.authorizeEndpoint);

    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', this.config.scopes.join(' '));
    url.searchParams.set('state', input.state);
    url.searchParams.set('code_challenge', input.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');

    return url.toString();
  }

  async exchangeCode(input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<SsoTokenSet> {
    const body = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      redirect_uri: input.redirectUri,
      code: input.code,
      code_verifier: input.codeVerifier,
    });

    const tokenPayload = await this.requestJson(this.config.tokenEndpoint, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
      signal: AbortSignal.timeout(10000),
    });

    if (
      typeof tokenPayload.access_token !== 'string' ||
      tokenPayload.access_token.length === 0
    ) {
      fail();
    }

    return { accessToken: tokenPayload.access_token };
  }

  async readIdentity(input: { tokens: SsoTokenSet; nonce: string }): Promise<SsoIdentity> {
    const accessToken = input.tokens.accessToken;

    if (accessToken === undefined) {
      fail();
    }

    const endpoints = this.requireEndpoints();
    const tokenUserId = await this.debugAccessToken(accessToken, endpoints.debug);
    const profile = await this.readProfile(accessToken, endpoints.profile);

    if (profile.id !== tokenUserId) {
      fail();
    }

    const email = readProfileEmail(profile);

    return {
      provider: this.id,
      subject: tokenUserId,
      ...(email === undefined ? {} : { email }),
      // No provider claim can establish ownership of the address.
      emailVerified: false,
    };
  }

  private requireEndpoints(): { readonly debug: string; readonly profile: string } {
    const debug = this.config.debugTokenEndpoint;
    const profile = this.config.profileEndpoint;

    if (debug === undefined || profile === undefined) {
      fail();
    }

    return { debug, profile };
  }

  private async requestJson(
    url: string | URL,
    init: RequestInit,
  ): Promise<Record<string, unknown>> {
    try {
      const response = await this.fetchImpl(url, init);

      return await readJsonObject(response);
    } catch (error) {
      if (error instanceof SsoError) {
        throw error;
      }

      fail();
    }
  }

  /** Returns the subject the debugged token was issued for, after app checks. */
  private async debugAccessToken(accessToken: string, endpoint: string): Promise<string> {
    const body = new URLSearchParams({
      input_token: accessToken,
      access_token: `${this.config.clientId}|${this.config.clientSecret}`,
    });

    const debug = await this.requestJson(endpoint, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
      signal: AbortSignal.timeout(10000),
    });

    return readDebuggedUserId(debug, this.config.clientId);
  }

  private async readProfile(
    accessToken: string,
    endpoint: string,
  ): Promise<Record<string, unknown>> {
    const profileUrl = new URL(endpoint);

    profileUrl.searchParams.set('fields', 'id,email');

    return this.requestJson(profileUrl, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
      signal: AbortSignal.timeout(10000),
    });
  }
}
