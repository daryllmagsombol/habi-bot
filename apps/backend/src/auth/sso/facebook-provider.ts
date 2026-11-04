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

    let payload: Record<string, unknown>;

    try {
      const response = await this.fetchImpl(this.config.tokenEndpoint, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
        signal: AbortSignal.timeout(10000),
      });

      payload = await readJsonObject(response);
    } catch (error) {
      if (error instanceof SsoError) {
        throw error;
      }

      fail();
    }

    if (typeof payload.access_token !== 'string' || payload.access_token.length === 0) {
      fail();
    }

    return { accessToken: payload.access_token };
  }

  async readIdentity(input: { tokens: SsoTokenSet; nonce: string }): Promise<SsoIdentity> {
    const accessToken = input.tokens.accessToken;

    if (accessToken === undefined) {
      fail();
    }

    const debugEndpoint = this.config.debugTokenEndpoint;
    const profileEndpoint = this.config.profileEndpoint;

    if (debugEndpoint === undefined || profileEndpoint === undefined) {
      fail();
    }

    const debugBody = new URLSearchParams({
      input_token: accessToken,
      access_token: `${this.config.clientId}|${this.config.clientSecret}`,
    });

    let debug: Record<string, unknown>;

    try {
      const response = await this.fetchImpl(debugEndpoint, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: debugBody.toString(),
        signal: AbortSignal.timeout(10000),
      });

      debug = await readJsonObject(response);
    } catch (error) {
      if (error instanceof SsoError) {
        throw error;
      }

      fail();
    }

    const data = debug.data;

    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      fail();
    }

    const record = data as Record<string, unknown>;

    if (record.is_valid !== true) {
      fail();
    }

    if (record.app_id !== this.config.clientId) {
      fail();
    }

    const tokenUserId = record.user_id;

    if (typeof tokenUserId !== 'string' || tokenUserId.length === 0) {
      fail();
    }

    const profileUrl = new URL(profileEndpoint);
    profileUrl.searchParams.set('fields', 'id,email');

    let profile: Record<string, unknown>;

    try {
      const response = await this.fetchImpl(profileUrl, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${accessToken}`,
        },
        signal: AbortSignal.timeout(10000),
      });

      profile = await readJsonObject(response);
    } catch (error) {
      if (error instanceof SsoError) {
        throw error;
      }

      fail();
    }

    if (profile.id !== tokenUserId) {
      fail();
    }

    const email =
      typeof profile.email === 'string' &&
      profile.email.trim().length > 0 &&
      profile.email.length <= 254
        ? profile.email
        : undefined;

    return {
      provider: this.id,
      subject: tokenUserId,
      ...(email === undefined ? {} : { email }),
      // No provider claim can establish ownership of the address.
      emailVerified: false,
    };
  }
}
