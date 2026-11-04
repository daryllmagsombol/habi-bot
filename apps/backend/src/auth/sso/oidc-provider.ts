/**
 * Provider-neutral OIDC authorization-code implementation.
 *
 * Google and Microsoft are the same flow with different configuration, which is
 * the point: the service layer has one callback path, and a provider supplies
 * endpoints, scopes, and an email-trust predicate. Nothing here is provider
 * specific beyond those inputs.
 *
 * - PKCE `S256` is always sent. No `plain` mode exists.
 * - The token request uses `client_secret_post` with the secret in the request
 *   body, never a URL. The request is server-to-server and its body is never
 *   logged.
 * - `readIdentity` accepts only an id_token verified by `OidcVerifier`; access
 *   tokens are not used to read profile data because the id_token already carries
 *   the identity and its trust claims.
 * - The provider-reported email counts as verified only when the configured
 *   predicate requires the explicit `email_verified: true` claim.
 */
import type { SsoIdentity, SsoProvider, SsoProviderId, SsoTokenSet } from './sso-types.js';
import type { SsoProviderConfig } from './sso-config.js';
import type { OidcVerifier } from './oidc-verifier.js';
import { SsoError } from './sso-errors.js';

const MAX_TOKEN_RESPONSE_BYTES = 16 * 1024;

interface TokenResponseBody {
  readonly id_token?: unknown;
  readonly access_token?: unknown;
  readonly token_type?: unknown;
}

function fail(): never {
  throw new SsoError('sso_failed');
}

export class OidcSsoProvider implements SsoProvider {
  readonly id: SsoProviderId;
  readonly displayName: string;
  readonly scopes: readonly string[];
  readonly usesOidc = true;
  private readonly config: SsoProviderConfig;
  private readonly verifier: OidcVerifier;
  private readonly fetchImpl: typeof fetch;

  constructor(
    config: SsoProviderConfig,
    verifier: OidcVerifier,
    fetchImpl: typeof fetch = fetch,
  ) {
    if (config.issuer === undefined || config.jwksUri === undefined) {
      throw new Error('OIDC provider requires an issuer and a JWKS URI');
    }

    this.config = config;
    this.verifier = verifier;
    this.fetchImpl = fetchImpl;
    this.id = config.id;
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
    url.searchParams.set('nonce', input.nonce);
    url.searchParams.set('code_challenge', input.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    // Identity only: no prompt/consent/offline parameters are added, and no
    // refresh token is requested.
    url.searchParams.set('response_mode', 'query');

    return url.toString();
  }

  async exchangeCode(input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<SsoTokenSet> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      code_verifier: input.codeVerifier,
    });

    let payload: TokenResponseBody;

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

      if (!response.ok) {
        fail();
      }

      const text = await response.text();

      if (text.length === 0 || text.length > MAX_TOKEN_RESPONSE_BYTES) {
        fail();
      }

      const parsed: unknown = JSON.parse(text);

      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        fail();
      }

      payload = parsed as TokenResponseBody;
    } catch (error) {
      if (error instanceof SsoError) {
        throw error;
      }

      // Network failure, timeout, invalid JSON, and provider error bodies all
      // collapse to one failure. Provider error text is never forwarded.
      fail();
    }

    if (typeof payload.id_token !== 'string' || payload.id_token.length === 0) {
      fail();
    }

    return {
      idToken: payload.id_token,
      ...(typeof payload.access_token === 'string'
        ? { accessToken: payload.access_token }
        : {}),
    };
  }

  async readIdentity(input: { tokens: SsoTokenSet; nonce: string }): Promise<SsoIdentity> {
    if (input.tokens.idToken === undefined) {
      fail();
    }

    const claims = await this.verifier.verify(input.tokens.idToken, input.nonce);
    const email = claims.email;
    const emailVerified =
      this.config.emailTrust === 'verified-claim' &&
      claims.emailVerified &&
      email !== undefined;

    return {
      provider: this.config.id,
      subject: claims.subject,
      ...(email === undefined ? {} : { email }),
      emailVerified,
      issuer: claims.issuer,
    };
  }
}
