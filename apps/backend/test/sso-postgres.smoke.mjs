/**
 * H-015 (#15): Google, Microsoft, and Facebook sign-in.
 *
 * Runs a real PostgreSQL 18.6 container, the real migrations, and the built
 * `AuthModule` + `SsoModule` in-process. The identity providers are a local
 * HTTP stub: no request leaves the loopback interface, and no live provider is
 * contacted or claimed.
 *
 * The stub intentionally behaves like a strict provider: it validates the client
 * id/secret, the exact redirect URI, and the PKCE `S256` verifier before issuing
 * a code or token, and it can be told to return tampered id_tokens (bad nonce,
 * audience, issuer, or signature) so the verifier is exercised rather than
 * bypassed.
 *
 * Covered properties:
 *   - happy path for each provider shape (OIDC x2, Facebook token debugging)
 *   - state replay, cross-browser state use, expired pending records
 *   - PKCE mismatch, id-token nonce/audience/signature rejection
 *   - exact redirect URI comparison
 *   - unverified provider email rejection
 *   - explicit linking, unlinking, duplicate subject, cross-user takeover
 *   - invite gate and non-enumerating refusal
 *   - disabled provider route absence
 *   - unauthenticated probe of every route
 *   - no secret in a log line or a response body
 *
 * Skips cleanly when Docker is unavailable.
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign as signPayload,
} from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool } = pg;

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const MIGRATE_SCRIPT = `${REPOSITORY_ROOT}scripts/db/migrate.mjs`;
const POSTGRES_IMAGE = 'postgres:18.6-alpine';
const DOCKER_USER = 'habi';
const DOCKER_DATABASE = 'habi';
const SESSION_COOKIE_PATTERN = /^(?:__Host-)?habi_session=/;
const BINDING_COOKIE_PATTERN = /^(?:__Host-)?habi_sso=/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const GOOGLE = 'google';
const MICROSOFT = 'microsoft';
const FACEBOOK = 'facebook';

/* ------------------------------------------------------------------ */
/* Local stub identity provider                                        */
/* ------------------------------------------------------------------ */

const { privateKey: SIGNING_KEY, publicKey: SIGNING_PUBLIC_KEY } =
  generateKeyPairSync('rsa', { modulusLength: 2048 });
const { privateKey: OTHER_KEY } = generateKeyPairSync('rsa', { modulusLength: 2048 });

const KEY_ID = 'stub-key-1';
const PUBLIC_JWK = {
  ...SIGNING_PUBLIC_KEY.export({ format: 'jwk' }),
  kid: KEY_ID,
  alg: 'RS256',
  use: 'sig',
};

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function sha256Base64url(value) {
  return createHash('sha256').update(value, 'ascii').digest('base64url');
}

function signIdToken(claims, key = SIGNING_KEY) {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: KEY_ID }));
  const payload = base64url(JSON.stringify(claims));
  const signature = signPayload('sha256', Buffer.from(`${header}.${payload}`), key);

  return `${header}.${payload}.${signature.toString('base64url')}`;
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function writeJson(response, status, body) {
  const text = JSON.stringify(body);

  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });
  response.end(text);
}

/**
 * One HTTP server, one path prefix per provider. `clients` and
 * `registeredRedirects` are supplied by the test; everything the stub receives
 * that is secret is recorded in `secrets` so the test can prove the app never
 * echoes it.
 */
function createStubIdp() {
  const codes = new Map();
  const accessTokens = new Map();
  const secrets = new Set();
  const clients = new Map();
  const state = { origin: '' };

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', state.origin || 'http://stub.invalid');
      const [provider, action] = url.pathname.split('/').filter(Boolean);

      if (provider === undefined || action === undefined) {
        writeJson(response, 404, { error: 'not_found' });
        return;
      }

      if (action === 'authorize' && request.method === 'GET') {
        handleAuthorize(provider, url, response);
        return;
      }

      if (action === 'token' && request.method === 'POST') {
        const body = new URLSearchParams(await readRequestBody(request));
        handleToken(provider, body, response);
        return;
      }

      if (action === 'jwks' && request.method === 'GET') {
        writeJson(response, 200, { keys: [PUBLIC_JWK] });
        return;
      }

      if (action === 'debug_token' && request.method === 'POST') {
        handleDebugToken(provider, new URLSearchParams(await readRequestBody(request)), response);
        return;
      }

      if (action === 'me' && request.method === 'GET') {
        handleProfile(request, response);
        return;
      }

      writeJson(response, 404, { error: 'not_found' });
    } catch {
      writeJson(response, 500, { error: 'stub_failure' });
    }
  });

  function handleAuthorize(provider, url, response) {
    const client = clients.get(provider);

    if (client === undefined) {
      writeJson(response, 400, { error: 'unknown_provider' });
      return;
    }

    if (url.searchParams.get('client_id') !== client.clientId) {
      writeJson(response, 400, { error: 'invalid_client' });
      return;
    }

    if (url.searchParams.get('response_type') !== 'code') {
      writeJson(response, 400, { error: 'unsupported_response_type' });
      return;
    }

    if (url.searchParams.get('code_challenge_method') !== 'S256') {
      writeJson(response, 400, { error: 'invalid_request', reason: 'pkce_required' });
      return;
    }

    const redirectUri = url.searchParams.get('redirect_uri');
    const challenge = url.searchParams.get('code_challenge');

    if (redirectUri === null || challenge === null) {
      writeJson(response, 400, { error: 'invalid_request' });
      return;
    }

    const code = `code-${provider}-${randomBytes(12).toString('hex')}`;

    codes.set(code, {
      provider,
      redirectUri,
      // Test-only override: lets a second app in this process present its own
      // callback as the provider's registered URI. Production never sends this.
      backChannelRedirect:
        url.searchParams.get('test_registered_redirect') ?? client.redirectUri,
      challenge:
        url.searchParams.get('test_force_bad_challenge') === '1'
          ? `tampered-${challenge}`
          : challenge,
      nonce:
        url.searchParams.get('test_bad_nonce') === '1' ? 'attacker-nonce' : url.searchParams.get('nonce'),
      issuer:
        url.searchParams.get('test_bad_issuer') === '1'
          ? `${state.origin}/wrong-issuer`
          : client.issuer,
      audience:
        url.searchParams.get('test_bad_audience') === '1' ? 'someone-else' : client.clientId,
      badSignature: url.searchParams.get('test_bad_signature') === '1',
      subject: url.searchParams.get('test_subject') ?? `subject-${provider}`,
      email: url.searchParams.get('test_email'),
      emailVerified: url.searchParams.get('test_email_verified') === 'true',
      used: false,
    });
    secrets.add(code);

    const location = new URL(redirectUri);

    location.searchParams.set('code', code);
    location.searchParams.set('state', url.searchParams.get('state') ?? '');

    response.writeHead(302, { location: location.toString() });
    response.end();
  }

  function handleToken(provider, body, response) {
    const client = clients.get(provider);

    if (client === undefined) {
      writeJson(response, 400, { error: 'unknown_provider' });
      return;
    }

    if (body.get('client_id') !== client.clientId || body.get('client_secret') !== client.clientSecret) {
      writeJson(response, 401, { error: 'invalid_client' });
      return;
    }

    const code = body.get('code');
    const verifier = body.get('code_verifier');
    const record = code === null ? undefined : codes.get(code);

    if (record === undefined || record.used) {
      writeJson(response, 400, { error: 'invalid_grant' });
      return;
    }

    if (verifier !== null) {
      secrets.add(verifier);
    }

    // The code was issued for one redirect URI; the exchange must use the same
    // string, and it must be the URI registered for this client.
    if (
      body.get('redirect_uri') !== record.redirectUri ||
      body.get('redirect_uri') !== record.backChannelRedirect
    ) {
      writeJson(response, 400, { error: 'invalid_grant', reason: 'redirect_uri_mismatch' });
      return;
    }

    if (verifier === null || sha256Base64url(verifier) !== record.challenge) {
      writeJson(response, 400, { error: 'invalid_grant', reason: 'pkce_mismatch' });
      return;
    }

    record.used = true;

    if (provider === FACEBOOK) {
      const token = `fb-access-${randomBytes(12).toString('hex')}`;

      accessTokens.set(token, record);
      secrets.add(token);
      writeJson(response, 200, { access_token: token, token_type: 'bearer' });
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    const idToken = signIdToken(
      {
        iss: record.issuer,
        aud: record.audience,
        sub: record.subject,
        nonce: record.nonce ?? '',
        iat: now,
        exp: now + 300,
        ...(record.email === null
          ? {}
          : { email: record.email, email_verified: record.emailVerified }),
      },
      record.badSignature ? OTHER_KEY : SIGNING_KEY,
    );

    secrets.add(idToken);
    writeJson(response, 200, {
      access_token: `oidc-access-${randomBytes(12).toString('hex')}`,
      token_type: 'Bearer',
      id_token: idToken,
    });
  }

  function handleDebugToken(provider, body, response) {
    const client = clients.get(provider);

    if (client === undefined) {
      writeJson(response, 400, { error: 'unknown_provider' });
      return;
    }

    if (body.get('access_token') !== `${client.clientId}|${client.clientSecret}`) {
      writeJson(response, 401, { error: 'invalid_app_token' });
      return;
    }

    const record = accessTokens.get(body.get('input_token') ?? '');

    if (record === undefined) {
      writeJson(response, 400, { error: { message: 'Invalid OAuth access token.' } });
      return;
    }

    writeJson(response, 200, {
      data: { app_id: client.clientId, is_valid: true, user_id: record.subject },
    });
  }

  function handleProfile(request, response) {
    const authorization = request.headers.authorization ?? '';
    const match = /^Bearer (.+)$/.exec(authorization);
    const record = match === null ? undefined : accessTokens.get(match[1]);

    if (record === undefined) {
      writeJson(response, 401, { error: { message: 'Invalid OAuth access token.' } });
      return;
    }

    writeJson(response, 200, {
      id: record.subject,
      ...(record.email === null ? {} : { email: record.email }),
    });
  }

  return {
    server,
    secrets,
    clients,
    start(port) {
      state.origin = `http://127.0.0.1:${port}`;
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
      });
    },
    stop() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

/* ------------------------------------------------------------------ */
/* Harness helpers                                                     */
/* ------------------------------------------------------------------ */

function dockerAvailable() {
  const result = spawnSync('docker', ['info'], { stdio: 'ignore', timeout: 5000 });
  return result.status === 0;
}

function migrate(databaseUrl) {
  return spawnSync(
    process.execPath,
    [MIGRATE_SCRIPT, '--database-url', databaseUrl],
    { cwd: REPOSITORY_ROOT, encoding: 'utf8', timeout: 60000 },
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();

      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate a test port.')));
        return;
      }

      server.close((error) => (error === undefined ? resolve(address.port) : reject(error)));
    });
  });
}

async function waitForDatabase(pool, containerName) {
  const deadline = Date.now() + 60000;
  let lastError;

  while (Date.now() < deadline) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (error) {
      lastError = error;
      await sleep(500);
    }
  }

  const logs = spawnSync('docker', ['logs', containerName], {
    encoding: 'utf8',
    timeout: 10000,
  });

  throw new Error(
    `PostgreSQL did not become ready: ${lastError?.message ?? 'unknown error'}\n${logs.stdout ?? ''}\n${logs.stderr ?? ''}`,
  );
}

function capturingLogger() {
  const lines = [];
  const record = (message, ...rest) => {
    const parts = [message, ...rest].map((value) => {
      if (typeof value === 'string') {
        return value;
      }

      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    });

    lines.push(parts.join(' '));
  };

  return {
    lines,
    logger: {
      log: record,
      error: record,
      warn: record,
      debug: record,
      verbose: record,
      fatal: record,
      setLogLevels() {},
    },
  };
}

function cookiePair(setCookie) {
  return setCookie.split(';')[0];
}

const dockerReady = dockerAvailable();

describe(
  'H-015 SSO identity slice',
  { skip: dockerReady ? false : 'Docker daemon is unavailable' },
  () => {
    let containerName = '';
    let port = 0;
    let password = '';
    let pool;
    let databaseUrl = '';
    let auth;
    let sso;
    let stub;
    let stubPort = 0;
    let stubOrigin = '';
    let mainApp;
    let mainBase = '';
    let mainLogger;
    let googleOnlyApp;
    let googleOnlyBase = '';
    let redirectMismatchApp;
    let redirectMismatchBase = '';
    let closedRegistrationBase = '';
    const extraApps = [];
    const observedResponses = [];
    let googleAccount;

    const stubClients = {
      google: {
        clientId: 'stub-google-client-id',
        clientSecret: `stub-google-secret-${randomBytes(8).toString('hex')}`,
        issuer: '',
        redirectUri: '',
      },
      microsoft: {
        clientId: 'stub-microsoft-client-id',
        clientSecret: `stub-microsoft-secret-${randomBytes(8).toString('hex')}`,
        issuer: '',
        redirectUri: '',
      },
      facebook: {
        clientId: 'stub-facebook-client-id',
        clientSecret: `stub-facebook-secret-${randomBytes(8).toString('hex')}`,
        redirectUri: '',
      },
    };

    function providerEnv(base) {
      return {
        HABI_SSO_GOOGLE_CLIENT_ID: stubClients.google.clientId,
        HABI_SSO_GOOGLE_CLIENT_SECRET: stubClients.google.clientSecret,
        HABI_SSO_GOOGLE_REDIRECT_URI: `${base}/auth/sso/google/callback`,
        HABI_SSO_GOOGLE_AUTHORIZE_URL: `${stubOrigin}/google/authorize`,
        HABI_SSO_GOOGLE_TOKEN_URL: `${stubOrigin}/google/token`,
        HABI_SSO_GOOGLE_ISSUER: `${stubOrigin}/google`,
        HABI_SSO_GOOGLE_JWKS_URL: `${stubOrigin}/google/jwks`,
        HABI_SSO_MICROSOFT_CLIENT_ID: stubClients.microsoft.clientId,
        HABI_SSO_MICROSOFT_CLIENT_SECRET: stubClients.microsoft.clientSecret,
        HABI_SSO_MICROSOFT_REDIRECT_URI: `${base}/auth/sso/microsoft/callback`,
        HABI_SSO_MICROSOFT_AUTHORIZE_URL: `${stubOrigin}/microsoft/authorize`,
        HABI_SSO_MICROSOFT_TOKEN_URL: `${stubOrigin}/microsoft/token`,
        HABI_SSO_MICROSOFT_ISSUER: `${stubOrigin}/microsoft`,
        HABI_SSO_MICROSOFT_JWKS_URL: `${stubOrigin}/microsoft/jwks`,
        HABI_SSO_FACEBOOK_CLIENT_ID: stubClients.facebook.clientId,
        HABI_SSO_FACEBOOK_CLIENT_SECRET: stubClients.facebook.clientSecret,
        HABI_SSO_FACEBOOK_REDIRECT_URI: `${base}/auth/sso/facebook/callback`,
        HABI_SSO_FACEBOOK_AUTHORIZE_URL: `${stubOrigin}/facebook/authorize`,
        HABI_SSO_FACEBOOK_TOKEN_URL: `${stubOrigin}/facebook/token`,
        HABI_SSO_FACEBOOK_DEBUG_TOKEN_URL: `${stubOrigin}/facebook/debug_token`,
        HABI_SSO_FACEBOOK_PROFILE_URL: `${stubOrigin}/facebook/me`,
      };
    }

    async function bootApp(env, base) {
      const { Module } = await import('@nestjs/common');
      const { NestFactory } = await import('@nestjs/core');
      const ssoModule = sso.SsoModule.forRoot(env);

      assert.ok(ssoModule !== undefined, 'SSO module must be configured for this app');

      const RootClass = class TestRootModule {};
      Module({ imports: [auth.AuthModule, ssoModule] })(RootClass);

      const capture = capturingLogger();
      const app = await NestFactory.create(RootClass, {
        logger: capture.logger,
        abortOnError: false,
      });
      const listenPort = Number(new URL(base).port);

      await app.listen(listenPort, '127.0.0.1');

      return { app, logger: capture.lines };
    }

    async function httpRequest(base, path, options = {}) {
      const headers = { ...(options.headers ?? {}) };

      if (options.body !== undefined) {
        headers['content-type'] = 'application/json';
      }

      if (options.cookie !== undefined) {
        headers.cookie = options.cookie;
      }

      if (options.csrf !== undefined) {
        headers['x-csrf-token'] = options.csrf;
      }

      if (options.origin !== undefined) {
        headers.origin = options.origin;
      }

      const response = await fetch(`${base}${path}`, {
        method: options.method ?? 'POST',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        redirect: 'manual',
        signal: AbortSignal.timeout(15000),
      });
      const text = await response.text();
      let body;

      if (text !== '') {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }

      const result = {
        label: `${options.method ?? 'POST'} ${path}`,
        status: response.status,
        headers: response.headers,
        body,
        text,
        setCookies: response.headers.getSetCookie(),
        location: response.headers.get('location'),
      };

      observedResponses.push(result);
      return result;
    }

    function sessionSetCookie(result) {
      return result.setCookies.find((cookie) => SESSION_COOKIE_PATTERN.test(cookie));
    }

    function bindingSetCookie(result) {
      return result.setCookies.find((cookie) => BINDING_COOKIE_PATTERN.test(cookie));
    }

    async function insertInvite(email, token, options = {}) {
      const canonical = auth.canonicalizeEmail(email);

      assert.ok(canonical, `test email must canonicalize: ${email}`);
      await pool.query(
        `INSERT INTO invites (email, token_hash, created_at, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [
          canonical,
          auth.hashToken(token),
          options.createdAt ?? new Date(),
          options.expiresAt ?? new Date(Date.now() + 60 * 60 * 1000),
        ],
      );

      return token;
    }

    async function passwordSignup(email, plainPassword) {
      const invite = auth.mintToken();

      await insertInvite(email, invite);
      const result = await httpRequest(mainBase, '/auth/signup', {
        body: { email, password: plainPassword, inviteToken: invite },
      });

      assert.equal(result.status, 201, result.text);

      const setCookie = sessionSetCookie(result);

      assert.ok(setCookie, 'signup did not set a session cookie');

      return {
        userId: result.body.user.userId,
        cookie: cookiePair(setCookie),
        csrf: result.body.csrfToken,
      };
    }

    function identityParams(identity) {
      const params = {
        ...(identity.subject === undefined ? {} : { test_subject: identity.subject }),
        ...(identity.email === undefined ? {} : { test_email: identity.email }),
        test_email_verified: String(identity.emailVerified ?? false),
        ...(identity.forceBadChallenge === true ? { test_force_bad_challenge: '1' } : {}),
        ...(identity.badNonce === true ? { test_bad_nonce: '1' } : {}),
        ...(identity.badSignature === true ? { test_bad_signature: '1' } : {}),
        ...(identity.badAudience === true ? { test_bad_audience: '1' } : {}),
        ...(identity.badIssuer === true ? { test_bad_issuer: '1' } : {}),
        ...(identity.registeredRedirect === undefined
          ? {}
          : { test_registered_redirect: identity.registeredRedirect }),
      };

      return params;
    }

    /**
     * Plays the browser: POST start, follow the provider redirect manually, and
     * return both the pending-flow binding cookie and the callback URL.
     */
    async function startFlow(base, provider, options = {}) {
      const body = {
        ...(options.inviteToken === undefined ? {} : { inviteToken: options.inviteToken }),
        ...(options.returnTo === undefined ? {} : { returnTo: options.returnTo }),
      };
      const start = await httpRequest(base, `/auth/sso/${provider}/start`, {
        body,
        origin: base,
      });

      if (options.expectStartFailure === true) {
        return { start };
      }

      assert.equal(start.status, 302, start.text);

      const binding = bindingSetCookie(start);

      assert.ok(binding, 'start did not set a browser-binding cookie');
      assert.ok(start.location, 'start did not redirect to the provider');

      const authorize = new URL(start.location);

      for (const [name, value] of Object.entries(identityParams(options.identity ?? {}))) {
        authorize.searchParams.set(name, value);
      }

      const providerResponse = await fetch(authorize, { redirect: 'manual' });

      assert.equal(providerResponse.status, 302, await providerResponse.text());

      const callbackUrl = providerResponse.headers.get('location');

      assert.ok(callbackUrl, 'stub IdP did not redirect to the callback');

      return {
        start,
        authorize,
        binding: cookiePair(binding),
        callbackUrl,
      };
    }

    function finishFlow(base, flow, options = {}) {
      const callback = new URL(flow.callbackUrl);
      const cookies = [];

      if (options.binding !== false) {
        cookies.push(flow.binding);
      }

      if (options.sessionCookie !== undefined) {
        cookies.push(options.sessionCookie);
      }

      return httpRequest(base, `${callback.pathname}${callback.search}`, {
        method: 'GET',
        origin: base,
        ...(cookies.length === 0 ? {} : { cookie: cookies.join('; ') }),
      });
    }

    /** Plays the browser for an authenticated link flow. */
    async function startLinkFlow(base, provider, options) {
      const start = await httpRequest(base, `/auth/sso/${provider}/link/start`, {
        body: options.returnTo === undefined ? {} : { returnTo: options.returnTo },
        cookie: options.cookie,
        csrf: options.csrf,
        origin: base,
      });

      assert.equal(start.status, 302, start.text);

      const binding = bindingSetCookie(start);

      assert.ok(binding, 'link start did not set a binding cookie');

      const authorize = new URL(start.location);

      for (const [name, value] of Object.entries(identityParams(options.identity))) {
        authorize.searchParams.set(name, value);
      }

      const providerResponse = await fetch(authorize, { redirect: 'manual' });

      assert.equal(providerResponse.status, 302, await providerResponse.text());

      return {
        start,
        authorize,
        binding: cookiePair(binding),
        callbackUrl: providerResponse.headers.get('location'),
      };
    }

    function finishLink(base, flow, sessionCookie) {
      const callback = new URL(flow.callbackUrl);

      return httpRequest(base, `${callback.pathname}${callback.search}`, {
        method: 'GET',
        origin: base,
        cookie: `${flow.binding}; ${sessionCookie}`,
      });
    }

    async function stateHash(state) {
      return auth.hashToken(state);
    }

    before(async () => {
      containerName = `habi-h015-${randomBytes(6).toString('hex')}`;
      password = randomBytes(24).toString('hex');

      const container = spawnSync(
        'docker',
        [
          'run',
          '-d',
          '--rm',
          '--tmpfs',
          '/var/lib/postgresql:rw,noexec,nosuid',
          '--name',
          containerName,
          '-e',
          `POSTGRES_PASSWORD=${password}`,
          '-e',
          `POSTGRES_USER=${DOCKER_USER}`,
          '-e',
          `POSTGRES_DB=${DOCKER_DATABASE}`,
          '-p',
          '127.0.0.1::5432',
          POSTGRES_IMAGE,
        ],
        { encoding: 'utf8', timeout: 120000 },
      );

      assert.equal(container.status, 0, container.stderr);

      const portResult = spawnSync('docker', ['port', containerName, '5432/tcp'], {
        encoding: 'utf8',
        timeout: 10000,
      });

      assert.equal(portResult.status, 0, portResult.stderr);

      port = Number.parseInt(portResult.stdout.trim().split(':').pop() ?? '', 10);
      assert.ok(Number.isInteger(port) && port > 0, 'Docker did not publish PostgreSQL');

      pool = new Pool({
        host: '127.0.0.1',
        port,
        user: DOCKER_USER,
        password,
        database: DOCKER_DATABASE,
        max: 8,
      });

      await waitForDatabase(pool, containerName);
      databaseUrl = `postgres://${DOCKER_USER}:${password}@127.0.0.1:${port}/${DOCKER_DATABASE}`;

      const applied = migrate(databaseUrl);

      assert.equal(applied.status, 0, applied.stderr);
      assert.match(applied.stdout, /applied\s+0014_skills\.sql/);
      assert.match(applied.stdout, /applied\s+0015_sso_identities\.sql/);

      process.env.DATABASE_URL = databaseUrl;
      process.env.HABI_AUTH_SPIKE = '1';
      process.env.NODE_ENV = 'test';

      auth = await import('../dist/auth/index.js');
      sso = await import('../dist/auth/sso/index.js');

      const freeStubPort = await getFreePort();

      stubPort = freeStubPort;
      stubOrigin = `http://127.0.0.1:${stubPort}`;
      stub = createStubIdp();

      const freeMainPort = await getFreePort();

      mainBase = `http://127.0.0.1:${freeMainPort}`;

      stubClients.google.issuer = `${stubOrigin}/google`;
      stubClients.google.redirectUri = `${mainBase}/auth/sso/google/callback`;
      stubClients.microsoft.issuer = `${stubOrigin}/microsoft`;
      stubClients.microsoft.redirectUri = `${mainBase}/auth/sso/microsoft/callback`;
      stubClients.facebook.redirectUri = `${mainBase}/auth/sso/facebook/callback`;

      for (const client of Object.values(stubClients)) {
        stub.secrets.add(client.clientSecret);
      }

      // The stub is configured before any app boots so its registered redirect
      // URI is the one every app is compared against.
      stub.clients.set(GOOGLE, stubClients.google);
      stub.clients.set(MICROSOFT, stubClients.microsoft);
      stub.clients.set(FACEBOOK, stubClients.facebook);
      await stub.start(stubPort);

      const main = await bootApp(providerEnv(mainBase), mainBase);

      mainApp = main.app;
      mainLogger = main.logger;

      const googleOnlyPort = await getFreePort();

      googleOnlyBase = `http://127.0.0.1:${googleOnlyPort}`;

      const googleOnlyEnv = providerEnv(googleOnlyBase);

      delete googleOnlyEnv.HABI_SSO_MICROSOFT_CLIENT_ID;
      delete googleOnlyEnv.HABI_SSO_MICROSOFT_CLIENT_SECRET;
      delete googleOnlyEnv.HABI_SSO_MICROSOFT_REDIRECT_URI;
      delete googleOnlyEnv.HABI_SSO_MICROSOFT_ISSUER;
      delete googleOnlyEnv.HABI_SSO_MICROSOFT_AUTHORIZE_URL;
      delete googleOnlyEnv.HABI_SSO_MICROSOFT_TOKEN_URL;
      delete googleOnlyEnv.HABI_SSO_MICROSOFT_JWKS_URL;
      delete googleOnlyEnv.HABI_SSO_FACEBOOK_CLIENT_ID;
      delete googleOnlyEnv.HABI_SSO_FACEBOOK_CLIENT_SECRET;
      delete googleOnlyEnv.HABI_SSO_FACEBOOK_REDIRECT_URI;
      delete googleOnlyEnv.HABI_SSO_FACEBOOK_AUTHORIZE_URL;
      delete googleOnlyEnv.HABI_SSO_FACEBOOK_TOKEN_URL;
      delete googleOnlyEnv.HABI_SSO_FACEBOOK_DEBUG_TOKEN_URL;
      delete googleOnlyEnv.HABI_SSO_FACEBOOK_PROFILE_URL;

      googleOnlyApp = await bootApp(googleOnlyEnv, googleOnlyBase);

      const mismatchPort = await getFreePort();

      redirectMismatchBase = `http://127.0.0.1:${mismatchPort}`;

      // A different origin for the same client: the provider registered the main
      // app's callback, so the exchange must fail rather than be normalized.
      const mismatchApp = await bootApp(providerEnv(redirectMismatchBase), redirectMismatchBase);

      redirectMismatchApp = mismatchApp;

      const closedPort = await getFreePort();

      closedRegistrationBase = `http://127.0.0.1:${closedPort}`;

      const closedApp = await bootApp(
        {
          ...providerEnv(closedRegistrationBase),
          HABI_REGISTRATION_MODE: 'closed',
        },
        closedRegistrationBase,
      );

      for (const app of [
        mainApp,
        googleOnlyApp.app,
        redirectMismatchApp.app,
        closedApp.app,
      ]) {
        extraApps.push(app);
      }
    });

    after(async () => {
      for (const app of extraApps) {
        await app.close().catch(() => {});
      }

      if (stub !== undefined) {
        await stub.stop().catch(() => {});
      }

      if (pool !== undefined) {
        await pool.end().catch(() => {});
      }

      if (containerName !== '') {
        spawnSync('docker', ['rm', '-f', containerName], {
          stdio: 'ignore',
          timeout: 30000,
        });

        const inspect = spawnSync('docker', ['inspect', containerName], {
          stdio: 'ignore',
          timeout: 10000,
        });

        assert.notEqual(inspect.status, 0, 'temporary PostgreSQL container was not removed');
      }
    });

    test('authSpikeModules gates the SSO module behind the auth flag and configuration', () => {
      assert.deepEqual(auth.authSpikeModules({}), []);

      const noProviders = auth.authSpikeModules({ HABI_AUTH_SPIKE: '1' });

      assert.equal(noProviders.length, 1);
      assert.equal(noProviders[0], auth.AuthModule);

      const withProviders = auth.authSpikeModules({
        HABI_AUTH_SPIKE: '1',
        ...providerEnv(mainBase),
      });

      assert.equal(withProviders.length, 2);
      assert.equal(withProviders[0], auth.AuthModule);
      assert.equal(withProviders[1].module, sso.SsoModule);

      // A partial configuration is not a provider.
      const partial = auth.authSpikeModules({
        HABI_AUTH_SPIKE: '1',
        HABI_SSO_GOOGLE_CLIENT_ID: 'id-only',
      });

      assert.equal(partial.length, 1);
    });

    test('providers are advertised with identity-only scopes and no secrets', async () => {
      const result = await httpRequest(mainBase, '/auth/sso/providers', { method: 'GET' });

      assert.equal(result.status, 200, result.text);

      const byId = new Map(result.body.providers.map((provider) => [provider.id, provider]));

      assert.deepEqual([...byId.keys()].sort(), [FACEBOOK, GOOGLE, MICROSOFT]);
      assert.deepEqual(byId.get(GOOGLE).scopes, ['openid', 'email']);
      assert.deepEqual(byId.get(MICROSOFT).scopes, ['openid', 'email']);
      assert.deepEqual(byId.get(FACEBOOK).scopes, ['email']);

      for (const provider of result.body.providers) {
        assert.deepEqual(Object.keys(provider).sort(), ['displayName', 'id', 'scopes']);
      }

      for (const client of Object.values(stubClients)) {
        assert.equal(result.text.includes(client.clientSecret), false);
      }

      assert.equal(result.text.includes(stubOrigin), false, 'advertisement leaked an endpoint URL');
    });

    test('Google signup consumes an invite and issues the shared HttpOnly session', async () => {
      const email = 'sso.google@example.com';
      const invite = auth.mintToken();

      await insertInvite(email, invite);

      const flow = await startFlow(mainBase, GOOGLE, {
        inviteToken: invite,
        identity: { subject: 'google-subject-1', email, emailVerified: true },
      });

      assert.equal(flow.authorize.searchParams.get('redirect_uri'), `${mainBase}/auth/sso/google/callback`);
      assert.equal(flow.authorize.searchParams.get('code_challenge_method'), 'S256');
      assert.equal(flow.authorize.searchParams.get('scope'), 'openid email');
      assert.ok(flow.authorize.searchParams.get('code_challenge'));
      assert.ok(flow.authorize.searchParams.get('nonce'));
      assert.equal(flow.authorize.searchParams.get('client_secret'), null);
      assert.equal(flow.authorize.searchParams.get('code'), null);

      const bindingCookie = bindingSetCookie(flow.start);

      assert.match(bindingCookie, /; HttpOnly/);
      assert.match(bindingCookie, /; SameSite=Lax/);
      assert.match(bindingCookie, /; Path=\//);
      assert.match(bindingCookie, /; Max-Age=\d+/);

      const done = await finishFlow(mainBase, flow);

      assert.equal(done.status, 302, done.text);
      assert.equal(done.location, '/');
      assert.equal(done.text, '');

      const setCookie = sessionSetCookie(done);

      assert.ok(setCookie, 'callback did not issue a session');
      assert.match(setCookie, /; HttpOnly/);
      assert.match(setCookie, /; SameSite=Lax/);
      assert.match(setCookie, /; Path=\//);
      assert.equal(done.headers.get('x-csrf-token')?.length, 43);

      const cleared = done.setCookies.find(
        (cookie) => BINDING_COOKIE_PATTERN.test(cookie) && /Max-Age=0/.test(cookie),
      );

      assert.ok(cleared, 'callback did not clear the browser-binding cookie');

      const me = await httpRequest(mainBase, '/auth/me', {
        method: 'GET',
        cookie: cookiePair(setCookie),
      });

      assert.equal(me.status, 200, me.text);
      assert.equal(me.body.user.email, email);
      assert.match(me.body.user.userId, UUID_PATTERN);

      const user = await pool.query(
        `SELECT id, email, password_hash, email_verified_at
           FROM users
          WHERE email = $1`,
        [email],
      );

      assert.equal(user.rowCount, 1);
      assert.equal(user.rows[0].password_hash, null);
      assert.notEqual(user.rows[0].email_verified_at, null);

      const identity = await pool.query(
        `SELECT user_id, provider, subject, email, email_trusted, revoked_at
           FROM sso_identities
          WHERE provider = $1 AND subject = $2`,
        [GOOGLE, 'google-subject-1'],
      );

      assert.equal(identity.rowCount, 1);
      assert.equal(identity.rows[0].user_id, me.body.user.userId);
      assert.equal(identity.rows[0].email, email);
      assert.equal(identity.rows[0].email_trusted, true);
      assert.equal(identity.rows[0].revoked_at, null);

      const inviteRow = await pool.query('SELECT used_at FROM invites WHERE token_hash = $1', [
        auth.hashToken(invite),
      ]);

      assert.notEqual(inviteRow.rows[0].used_at, null);

      const pending = await pool.query(
        `SELECT consumed_at, code_verifier, nonce, redirect_uri
           FROM sso_pending_authorizations
          WHERE state_hash = $1`,
        [await stateHash(flow.authorize.searchParams.get('state'))],
      );

      assert.equal(pending.rowCount, 1);
      assert.notEqual(pending.rows[0].consumed_at, null);
      assert.match(pending.rows[0].code_verifier, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(pending.rows[0].redirect_uri, `${mainBase}/auth/sso/google/callback`);

      // The verifier and nonce are server-side only.
      assert.equal(done.text.includes(pending.rows[0].code_verifier), false);
      assert.equal(done.text.includes(pending.rows[0].nonce), false);

      googleAccount = { email, userId: me.body.user.userId };
    });

    test('an existing linked identity signs in without a new invite', async () => {
      const account = googleAccount;
      const invitesBefore = await pool.query('SELECT count(*)::int AS count FROM invites');

      const flow = await startFlow(mainBase, GOOGLE, {
        identity: { subject: 'google-subject-1', email: account.email, emailVerified: true },
      });
      const done = await finishFlow(mainBase, flow);

      assert.equal(done.status, 302, done.text);

      const setCookie = sessionSetCookie(done);

      assert.ok(setCookie);

      const me = await httpRequest(mainBase, '/auth/me', {
        method: 'GET',
        cookie: cookiePair(setCookie),
      });

      assert.equal(me.status, 200, me.text);
      assert.equal(me.body.user.userId, account.userId);

      const invitesAfter = await pool.query('SELECT count(*)::int AS count FROM invites');

      assert.equal(invitesAfter.rows[0].count, invitesBefore.rows[0].count);
    });

    test('a replayed state is rejected and produces no second session', async () => {
      const invite = auth.mintToken();

      await insertInvite('replay@example.com', invite);

      const accepted = await startFlow(mainBase, GOOGLE, {
        inviteToken: invite,
        identity: { subject: 'google-replay', email: 'replay@example.com', emailVerified: true },
      });
      const done = await finishFlow(mainBase, accepted);

      assert.equal(done.status, 302, done.text);

      const replay = await finishFlow(mainBase, accepted);

      assert.equal(replay.status, 400, replay.text);
      assert.deepEqual(replay.body, { error: { code: 'sso_state_invalid' } });
      assert.equal(sessionSetCookie(replay), undefined);

      // The refused first flow never created an account either.
      const users = await pool.query('SELECT count(*)::int AS count FROM users WHERE email = $1', [
        'replay@example.com',
      ]);

      assert.equal(users.rows[0].count, 1);
      assert.equal(sessionSetCookie(replay), undefined);
    });

    test('a callback from another browser is rejected without burning the flow', async () => {
      const email = 'cross.browser@example.com';
      const invite = auth.mintToken();

      await insertInvite(email, invite);

      const flow = await startFlow(mainBase, GOOGLE, {
        inviteToken: invite,
        identity: { subject: 'google-cross-browser', email, emailVerified: true },
      });

      const otherBrowser = randomBytes(32).toString('base64url');
      const mismatched = await finishFlow(mainBase, flow, {
        binding: false,
        sessionCookie: `habi_sso=${otherBrowser}`,
      });

      assert.equal(mismatched.status, 400, mismatched.text);
      assert.deepEqual(mismatched.body, { error: { code: 'sso_state_invalid' } });
      assert.equal(sessionSetCookie(mismatched), undefined);

      const pending = await pool.query(
        `SELECT consumed_at
           FROM sso_pending_authorizations
          WHERE state_hash = $1`,
        [await stateHash(flow.authorize.searchParams.get('state'))],
      );

      assert.equal(pending.rows[0].consumed_at, null, 'binding mismatch must not consume the flow');

      // The initiating browser can still complete it.
      const done = await finishFlow(mainBase, flow);

      assert.equal(done.status, 302, done.text);
    });

    test('an expired pending authorization is rejected', async () => {
      const flow = await startFlow(mainBase, GOOGLE, {
        identity: { subject: 'google-expired', email: 'expired.pending@example.com', emailVerified: true },
      });
      const hash = await stateHash(flow.authorize.searchParams.get('state'));

      await pool.query(
        `UPDATE sso_pending_authorizations
            SET created_at = now() - interval '20 minutes',
                expires_at = now() - interval '10 minutes'
          WHERE state_hash = $1`,
        [hash],
      );

      const done = await finishFlow(mainBase, flow);

      assert.equal(done.status, 400, done.text);
      assert.deepEqual(done.body, { error: { code: 'sso_state_invalid' } });

      const users = await pool.query(
        'SELECT count(*)::int AS count FROM users WHERE email = $1',
        ['expired.pending@example.com'],
      );

      assert.equal(users.rows[0].count, 0);
    });

    test('PKCE mismatch and tampered id tokens are rejected', async () => {
      const cases = [
        ['forced PKCE mismatch', { forceBadChallenge: true }],
        ['wrong nonce', { badNonce: true }],
        ['wrong audience', { badAudience: true }],
        ['wrong issuer', { badIssuer: true }],
        ['bad signature', { badSignature: true }],
      ];

      for (const [label, flags] of cases) {
        const email = `tampered.${randomBytes(4).toString('hex')}@example.com`;
        const invite = auth.mintToken();

        await insertInvite(email, invite);

        const flow = await startFlow(mainBase, GOOGLE, {
          inviteToken: invite,
          identity: { subject: `google-tampered-${label}`, email, emailVerified: true, ...flags },
        });
        const done = await finishFlow(mainBase, flow);

        assert.equal(done.status, 401, `${label}: ${done.text}`);
        assert.deepEqual(done.body, { error: { code: 'sso_failed' } }, label);
        assert.equal(sessionSetCookie(done), undefined, label);

        const users = await pool.query('SELECT count(*)::int AS count FROM users WHERE email = $1', [
          email,
        ]);

        assert.equal(users.rows[0].count, 0, `${label} created an account`);
      }
    });

    test('an unverified provider email cannot create an account or a link', async () => {
      const cases = [
        [GOOGLE, { subject: 'google-unverified', email: 'unverified.google@example.com', emailVerified: false }],
        [MICROSOFT, { subject: 'microsoft-unverified', email: 'unverified.microsoft@example.com', emailVerified: false }],
        [FACEBOOK, { subject: 'facebook-unverified', email: 'unverified.facebook@example.com', emailVerified: false }],
      ];

      for (const [provider, identity] of cases) {
        const invite = auth.mintToken();

        await insertInvite(identity.email, invite);

        const flow = await startFlow(mainBase, provider, { inviteToken: invite, identity });
        const done = await finishFlow(mainBase, flow);

        assert.equal(done.status, 403, `${provider}: ${done.text}`);
        assert.deepEqual(done.body, { error: { code: 'sso_email_unverified' } }, provider);
        assert.equal(sessionSetCookie(done), undefined);

        const users = await pool.query('SELECT count(*)::int AS count FROM users WHERE email = $1', [
          identity.email,
        ]);

        assert.equal(users.rows[0].count, 0, `${provider} created an account from an unverified email`);

        const identities = await pool.query(
          'SELECT count(*)::int AS count FROM sso_identities WHERE provider = $1 AND subject = $2',
          [provider, identity.subject],
        );

        assert.equal(identities.rows[0].count, 0);
      }
    });

    test('a new identity is never merged into an existing account by email', async () => {
      const existing = await passwordSignup('merge.victim@example.com', 'a sufficiently long passphrase');
      const flow = await startFlow(mainBase, GOOGLE, {
        identity: {
          subject: 'google-merge-attempt',
          email: 'merge.victim@example.com',
          emailVerified: true,
        },
      });
      const done = await finishFlow(mainBase, flow);

      assert.equal(done.status, 409, done.text);
      assert.deepEqual(done.body, { error: { code: 'signup_unavailable' } });
      assert.doesNotMatch(done.text, /merge\.victim@example\.com/i);
      assert.equal(sessionSetCookie(done), undefined);

      const identity = await pool.query(
        'SELECT count(*)::int AS count FROM sso_identities WHERE provider = $1 AND subject = $2',
        [GOOGLE, 'google-merge-attempt'],
      );

      assert.equal(identity.rows[0].count, 0);

      const sessions = await httpRequest(mainBase, '/auth/me', {
        method: 'GET',
        cookie: existing.cookie,
      });

      assert.equal(sessions.status, 200);
      assert.equal(sessions.body.user.userId, existing.userId);
    });

    test('SSO signup still passes the invite gate and uses the same refusal', async () => {
      // Missing invite.
      const noInvite = await startFlow(mainBase, GOOGLE, {
        identity: { subject: 'google-no-invite', email: 'no.invite@example.com', emailVerified: true },
      });
      const refused = await finishFlow(mainBase, noInvite);

      assert.equal(refused.status, 409, refused.text);
      assert.deepEqual(refused.body, { error: { code: 'signup_unavailable' } });

      // Invite bound to a different address.
      const wrongInvite = auth.mintToken();

      await insertInvite('someone.else@example.com', wrongInvite);

      const mismatchedFlow = await startFlow(mainBase, GOOGLE, {
        inviteToken: wrongInvite,
        identity: { subject: 'google-mismatch', email: 'invite.mismatch@example.com', emailVerified: true },
      });
      const mismatched = await finishFlow(mainBase, mismatchedFlow);

      assert.equal(mismatched.status, 409, mismatched.text);
      assert.deepEqual(mismatched.body, { error: { code: 'signup_unavailable' } });

      const unused = await pool.query('SELECT used_at FROM invites WHERE token_hash = $1', [
        auth.hashToken(wrongInvite),
      ]);

      assert.equal(unused.rows[0].used_at, null, 'a refused activation must not consume the invite');

      // Expired invite.
      const expiredInvite = auth.mintToken();

      await insertInvite('expired.sso@example.com', expiredInvite, {
        createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
        expiresAt: new Date(Date.now() - 60 * 60 * 1000),
      });

      const expiredFlow = await startFlow(mainBase, GOOGLE, {
        inviteToken: expiredInvite,
        identity: { subject: 'google-expired-invite', email: 'expired.sso@example.com', emailVerified: true },
      });
      const expired = await finishFlow(mainBase, expiredFlow);

      assert.equal(expired.status, 409, expired.text);

      for (const email of [
        'no.invite@example.com',
        'invite.mismatch@example.com',
        'expired.sso@example.com',
      ]) {
        const users = await pool.query('SELECT count(*)::int AS count FROM users WHERE email = $1', [email]);

        assert.equal(users.rows[0].count, 0, `${email} should not exist`);
      }
    });

    test('Microsoft follows the same OIDC flow and email-trust predicate', async () => {
      const email = 'sso.microsoft@example.com';
      const invite = auth.mintToken();

      await insertInvite(email, invite);

      const flow = await startFlow(mainBase, MICROSOFT, {
        inviteToken: invite,
        identity: { subject: 'microsoft-subject-1', email, emailVerified: true },
      });

      assert.equal(flow.authorize.searchParams.get('scope'), 'openid email');
      assert.equal(flow.authorize.searchParams.get('response_mode'), 'query');

      const done = await finishFlow(mainBase, flow);

      assert.equal(done.status, 302, done.text);

      const setCookie = sessionSetCookie(done);

      assert.ok(setCookie);

      const me = await httpRequest(mainBase, '/auth/me', {
        method: 'GET',
        cookie: cookiePair(setCookie),
      });

      assert.equal(me.status, 200);
      assert.equal(me.body.user.email, email);

      const identity = await pool.query(
        'SELECT subject, email FROM sso_identities WHERE provider = $1 AND subject = $2',
        [MICROSOFT, 'microsoft-subject-1'],
      );

      assert.equal(identity.rowCount, 1);

      // A second sign-in with no invite is a normal login.
      const again = await startFlow(mainBase, MICROSOFT, {
        identity: { subject: 'microsoft-subject-1', email, emailVerified: true },
      });
      const second = await finishFlow(mainBase, again);

      assert.equal(second.status, 302, second.text);
    });

    test('Facebook signs in an existing identity and refuses to link an unverified one', async () => {
      const email = 'sso.facebook@example.com';

      // Facebook cannot establish email ownership (H-008 §7.1), so the identity
      // is seeded as it would be after Habi verification completed the link.
      const seeded = await passwordSignup(email, 'a sufficiently long passphrase');

      await pool.query(
        `INSERT INTO sso_identities (user_id, provider, subject, email, email_trusted)
         VALUES ($1, $2, $3, $4, true)`,
        [seeded.userId, FACEBOOK, 'facebook-subject-1', email],
      );

      const flow = await startFlow(mainBase, FACEBOOK, {
        identity: { subject: 'facebook-subject-1', email, emailVerified: false },
      });

      assert.equal(flow.authorize.searchParams.get('scope'), 'email');
      assert.equal(flow.authorize.searchParams.get('nonce'), null);

      const done = await finishFlow(mainBase, flow);

      assert.equal(done.status, 302, done.text);

      const setCookie = sessionSetCookie(done);

      assert.ok(setCookie);

      const me = await httpRequest(mainBase, '/auth/me', {
        method: 'GET',
        cookie: cookiePair(setCookie),
      });

      assert.equal(me.status, 200);
      assert.equal(me.body.user.userId, seeded.userId);

      // Explicit linking through an unverified-email provider is refused.
      const linkFlow = await startLinkFlow(mainBase, FACEBOOK, {
        cookie: seeded.cookie,
        csrf: seeded.csrf,
        identity: { subject: 'facebook-subject-2', email, emailVerified: false },
      });
      const linked = await finishLink(mainBase, linkFlow, seeded.cookie);

      assert.equal(linked.status, 403, linked.text);
      assert.deepEqual(linked.body, { error: { code: 'sso_email_unverified' } });

      const identities = await pool.query(
        'SELECT count(*)::int AS count FROM sso_identities WHERE subject = $1',
        ['facebook-subject-2'],
      );

      assert.equal(identities.rows[0].count, 0);
    });

    test('explicit linking attaches a verified identity and unlinking revokes it', async () => {
      const account = await passwordSignup('link.user@example.com', 'a sufficiently long passphrase');
      const linkFlow = await startLinkFlow(mainBase, GOOGLE, {
        cookie: account.cookie,
        csrf: account.csrf,
        returnTo: '/settings',
        identity: {
          subject: 'google-linked-1',
          email: 'link.user@example.com',
          emailVerified: true,
        },
      });

      assert.equal(
        linkFlow.authorize.searchParams.get('redirect_uri'),
        `${mainBase}/auth/sso/google/callback`,
      );

      const linked = await finishLink(mainBase, linkFlow, account.cookie);

      assert.equal(linked.status, 200, linked.text);
      assert.deepEqual(linked.body, { ok: true, provider: GOOGLE });

      const identities = await httpRequest(mainBase, '/auth/sso/identities', {
        method: 'GET',
        cookie: account.cookie,
      });

      assert.equal(identities.status, 200, identities.text);
      assert.equal(identities.body.identities.length, 1);
      assert.equal(identities.body.identities[0].provider, GOOGLE);
      assert.equal(identities.body.identities[0].email, 'link.user@example.com');
      assert.equal(identities.body.identities[0].emailTrusted, true);

      // The linked identity can now sign in.
      const loginFlow = await startFlow(mainBase, GOOGLE, {
        identity: {
          subject: 'google-linked-1',
          email: 'link.user@example.com',
          emailVerified: true,
        },
      });
      const login = await finishFlow(mainBase, loginFlow);

      assert.equal(login.status, 302, login.text);

      const linkedSession = sessionSetCookie(login);

      assert.ok(linkedSession);

      const me = await httpRequest(mainBase, '/auth/me', {
        method: 'GET',
        cookie: cookiePair(linkedSession),
      });

      assert.equal(me.body.user.userId, account.userId);

      // Unlink is owner-scoped and revokes the identity.
      const unlink = await httpRequest(mainBase, '/auth/sso/google/unlink', {
        cookie: account.cookie,
        csrf: account.csrf,
        origin: mainBase,
      });

      assert.equal(unlink.status, 200, unlink.text);
      assert.deepEqual(unlink.body, { ok: true });

      const afterUnlink = await httpRequest(mainBase, '/auth/sso/identities', {
        method: 'GET',
        cookie: account.cookie,
      });

      assert.equal(afterUnlink.body.identities.length, 0);

      const revoked = await pool.query(
        'SELECT revoked_at FROM sso_identities WHERE provider = $1 AND subject = $2',
        [GOOGLE, 'google-linked-1'],
      );

      assert.notEqual(revoked.rows[0].revoked_at, null);

      // A revoked identity cannot sign in again.
      const replay = await startFlow(mainBase, GOOGLE, {
        identity: {
          subject: 'google-linked-1',
          email: 'link.user@example.com',
          emailVerified: true,
        },
      });
      const refused = await finishFlow(mainBase, replay);

      assert.equal(refused.status, 401, refused.text);
      assert.deepEqual(refused.body, { error: { code: 'sso_failed' } });
    });

    test('last-method removal is blocked', async () => {
      const email = 'sso.only@example.com';
      const invite = auth.mintToken();

      await insertInvite(email, invite);

      const flow = await startFlow(mainBase, GOOGLE, {
        inviteToken: invite,
        identity: { subject: 'google-only-method', email, emailVerified: true },
      });
      const done = await finishFlow(mainBase, flow);

      assert.equal(done.status, 302, done.text);

      const setCookie = sessionSetCookie(done);

      assert.ok(setCookie);

      const csrf = done.headers.get('x-csrf-token');
      const unlink = await httpRequest(mainBase, '/auth/sso/google/unlink', {
        cookie: cookiePair(setCookie),
        csrf,
        origin: mainBase,
      });

      assert.equal(unlink.status, 409, unlink.text);
      assert.deepEqual(unlink.body, { error: { code: 'unlink_blocked' } });

      const stillLinked = await pool.query(
        `SELECT count(*)::int AS count
           FROM sso_identities
          WHERE provider = $1 AND subject = $2 AND revoked_at IS NULL`,
        [GOOGLE, 'google-only-method'],
      );

      assert.equal(stillLinked.rows[0].count, 1, 'the last auth method must remain');
    });

    test('account takeover through linking is refused', async () => {
      const victim = await passwordSignup('takeover.victim@example.com', 'a sufficiently long passphrase');
      const attacker = await passwordSignup('takeover.attacker@example.com', 'a sufficiently long passphrase');

      // The victim links their own Google identity.
      const victimFlow = await startLinkFlow(mainBase, GOOGLE, {
        cookie: victim.cookie,
        csrf: victim.csrf,
        identity: {
          subject: 'google-victim',
          email: 'takeover.victim@example.com',
          emailVerified: true,
        },
      });
      const victimDone = await finishLink(mainBase, victimFlow, victim.cookie);

      assert.equal(victimDone.status, 200, victimDone.text);

      // Attempt 1: the attacker presents the victim's provider subject.
      const subjectAttack = await startLinkFlow(mainBase, GOOGLE, {
        cookie: attacker.cookie,
        csrf: attacker.csrf,
        identity: {
          subject: 'google-victim',
          email: 'takeover.attacker@example.com',
          emailVerified: true,
        },
      });
      const firstAttempt = await finishLink(mainBase, subjectAttack, attacker.cookie);

      assert.equal(firstAttempt.status, 409, firstAttempt.text);
      assert.deepEqual(firstAttempt.body, { error: { code: 'link_unavailable' } });

      // Attempt 2: the attacker's provider identity asserts the victim's email.
      const emailAttack = await startLinkFlow(mainBase, GOOGLE, {
        cookie: attacker.cookie,
        csrf: attacker.csrf,
        identity: {
          subject: 'google-attacker',
          email: 'takeover.victim@example.com',
          emailVerified: true,
        },
      });
      const secondAttempt = await finishLink(mainBase, emailAttack, attacker.cookie);

      assert.equal(secondAttempt.status, 409, secondAttempt.text);
      assert.deepEqual(secondAttempt.body, { error: { code: 'link_unavailable' } });

      // Attempt 3: a duplicate (provider, subject) appears after the link
      // started. The commit-time check refuses instead of merging.
      const race = await startLinkFlow(mainBase, GOOGLE, {
        cookie: attacker.cookie,
        csrf: attacker.csrf,
        identity: {
          subject: 'google-race',
          email: 'takeover.attacker@example.com',
          emailVerified: true,
        },
      });

      await pool.query(
        `INSERT INTO sso_identities (user_id, provider, subject, email, email_trusted)
         VALUES ($1, $2, $3, $4, true)`,
        [victim.userId, GOOGLE, 'google-race', 'takeover.victim@example.com'],
      );

      const thirdAttempt = await finishLink(mainBase, race, attacker.cookie);

      assert.equal(thirdAttempt.status, 409, thirdAttempt.text);
      assert.deepEqual(thirdAttempt.body, { error: { code: 'link_unavailable' } });

      // The unique constraint itself holds.
      await assert.rejects(
        pool.query(
          `INSERT INTO sso_identities (user_id, provider, subject, email, email_trusted)
           VALUES ($1, $2, $3, $4, true)`,
          [attacker.userId, GOOGLE, 'google-race', 'takeover.attacker@example.com'],
        ),
        (error) => error.code === '23505',
      );

      const ownership = await pool.query(
        `SELECT user_id FROM sso_identities WHERE provider = $1 AND subject = $2`,
        [GOOGLE, 'google-victim'],
      );

      assert.equal(ownership.rows[0].user_id, victim.userId);

      const attackerIdentities = await pool.query(
        'SELECT count(*)::int AS count FROM sso_identities WHERE user_id = $1',
        [attacker.userId],
      );

      assert.equal(attackerIdentities.rows[0].count, 0);
    });

    test('the unauthenticated surface is closed and reveals nothing', async () => {
      const probes = [
        ['GET', '/auth/sso/identities', 401, 'unauthenticated'],
        ['POST', '/auth/sso/google/link/start', 401, 'unauthenticated'],
        ['POST', '/auth/sso/google/unlink', 401, 'unauthenticated'],
        ['POST', '/auth/sso/google/callback', 404, undefined],
      ];

      for (const [method, path, status, code] of probes) {
        const result = await httpRequest(mainBase, path, { method, origin: mainBase });

        assert.equal(result.status, status, `${method} ${path}: ${result.text}`);

        if (code !== undefined) {
          assert.deepEqual(result.body, { error: { code } }, `${method} ${path}`);
        }

        assert.equal(
          result.text.includes(stubClients.google.clientSecret),
          false,
          `${method} ${path} leaked a client secret`,
        );
      }

      // A session without its CSRF token cannot link or unlink.
      const account = await passwordSignup('csrf.user@example.com', 'a sufficiently long passphrase');

      for (const path of ['/auth/sso/google/link/start', '/auth/sso/google/unlink']) {
        const noCsrf = await httpRequest(mainBase, path, {
          body: {},
          cookie: account.cookie,
          origin: mainBase,
        });

        assert.equal(noCsrf.status, 403, `${path}: ${noCsrf.text}`);
        assert.deepEqual(noCsrf.body, { error: { code: 'csrf_invalid' } });

        const wrongCsrf = await httpRequest(mainBase, path, {
          body: {},
          cookie: account.cookie,
          csrf: 'not-the-token',
          origin: mainBase,
        });

        assert.equal(wrongCsrf.status, 403, `${path}: ${wrongCsrf.text}`);
      }

      // Start is intentionally reachable without a session: it is the login
      // entry point. It must not carry a secret and must set the binding cookie.
      const start = await httpRequest(mainBase, '/auth/sso/google/start', {
        body: {},
        origin: mainBase,
      });

      assert.equal(start.status, 302, start.text);
      assert.match(bindingSetCookie(start), /; HttpOnly/);
      assert.equal(start.location.includes(stubClients.google.clientSecret), false);
      assert.equal(start.location.includes('id_token'), false);

      // A callback with no state, code, or binding is rejected uniformly.
      const bare = await httpRequest(mainBase, '/auth/sso/google/callback', {
        method: 'GET',
        origin: mainBase,
      });

      assert.equal(bare.status, 400, bare.text);
      assert.deepEqual(bare.body, { error: { code: 'sso_state_invalid' } });

      const stateOnly = await startFlow(mainBase, GOOGLE, {
        identity: { subject: 'google-no-binding', email: 'no.binding@example.com', emailVerified: true },
      });
      const callback = new URL(stateOnly.callbackUrl);
      const noBinding = await httpRequest(mainBase, `${callback.pathname}${callback.search}`, {
        method: 'GET',
        origin: mainBase,
      });

      assert.equal(noBinding.status, 400, noBinding.text);

      // Provider mix-up: a state created for Microsoft is not accepted by the
      // Google callback, even with the right binding cookie.
      const microsoftFlow = await startFlow(mainBase, MICROSOFT, {
        identity: {
          subject: 'microsoft-mixup',
          email: 'mixup@example.com',
          emailVerified: true,
        },
      });
      const microsoftCallback = new URL(microsoftFlow.callbackUrl);
      const viaGoogle = await httpRequest(
        mainBase,
        `/auth/sso/google/callback${microsoftCallback.search}`,
        {
          method: 'GET',
          origin: mainBase,
          cookie: microsoftFlow.binding,
        },
      );

      assert.equal(viaGoogle.status, 400, viaGoogle.text);
      assert.deepEqual(viaGoogle.body, { error: { code: 'sso_state_invalid' } });

      // `returnTo` cannot be an external URL.
      for (const returnTo of ['https://evil.example', '//evil.example', '/\\evil.example']) {
        const rejected = await startFlow(mainBase, GOOGLE, {
          returnTo,
          expectStartFailure: true,
        });

        assert.equal(rejected.start.status, 400, `${returnTo}: ${rejected.start.text}`);
        assert.deepEqual(rejected.start.body, { error: { code: 'invalid_request' } });
      }
    });

    test('closed registration refuses a new SSO account but not an existing identity', async () => {
      const email = 'closed.sso@example.com';
      const invite = auth.mintToken();

      await insertInvite(email, invite);

      const refusedFlow = await startFlow(closedRegistrationBase, GOOGLE, {
        inviteToken: invite,
        identity: {
          subject: 'google-closed',
          email,
          emailVerified: true,
          registeredRedirect: `${closedRegistrationBase}/auth/sso/google/callback`,
        },
      });
      const refused = await finishFlow(closedRegistrationBase, refusedFlow);

      assert.equal(refused.status, 403, refused.text);
      assert.deepEqual(refused.body, { error: { code: 'registration_closed' } });
      assert.equal(sessionSetCookie(refused), undefined);

      const created = await pool.query('SELECT count(*)::int AS count FROM users WHERE email = $1', [
        email,
      ]);

      assert.equal(created.rows[0].count, 0);

      const invitation = await pool.query('SELECT used_at FROM invites WHERE token_hash = $1', [
        auth.hashToken(invite),
      ]);

      assert.equal(invitation.rows[0].used_at, null, 'a refused activation must not consume the invite');

      // An existing identity still signs in while registration is closed.
      const seeded = await passwordSignup('closed.existing@example.com', 'a sufficiently long passphrase');

      await pool.query(
        `INSERT INTO sso_identities (user_id, provider, subject, email, email_trusted)
         VALUES ($1, $2, $3, $4, true)`,
        [seeded.userId, GOOGLE, 'google-closed-existing', 'closed.existing@example.com'],
      );

      const loginFlow = await startFlow(closedRegistrationBase, GOOGLE, {
        identity: {
          subject: 'google-closed-existing',
          email: 'closed.existing@example.com',
          emailVerified: true,
          registeredRedirect: `${closedRegistrationBase}/auth/sso/google/callback`,
        },
      });
      const login = await finishFlow(closedRegistrationBase, loginFlow);

      assert.equal(login.status, 302, login.text);

      const setCookie = sessionSetCookie(login);

      assert.ok(setCookie);

      const me = await httpRequest(closedRegistrationBase, '/auth/me', {
        method: 'GET',
        cookie: cookiePair(setCookie),
      });

      assert.equal(me.status, 200);
      assert.equal(me.body.user.userId, seeded.userId);
    });

    test('a redirect URI that does not match registration is refused at exchange', async () => {
      const flow = await startFlow(redirectMismatchBase, GOOGLE, {
        identity: {
          subject: 'google-redirect-mismatch',
          email: 'redirect.mismatch@example.com',
          emailVerified: true,
        },
      });

      // The URI sent to the provider is this app's configured value, verbatim.
      assert.equal(
        flow.authorize.searchParams.get('redirect_uri'),
        `${redirectMismatchBase}/auth/sso/google/callback`,
      );

      const done = await finishFlow(redirectMismatchBase, flow);

      assert.equal(done.status, 401, done.text);
      assert.deepEqual(done.body, { error: { code: 'sso_failed' } });
      assert.equal(sessionSetCookie(done), undefined);
    });

    test('a disabled provider has no routes and is not advertised', async () => {
      const advertised = await httpRequest(googleOnlyBase, '/auth/sso/providers', { method: 'GET' });

      assert.equal(advertised.status, 200, advertised.text);
      assert.deepEqual(advertised.body.providers.map((provider) => provider.id), [GOOGLE]);

      for (const [method, path] of [
        ['POST', '/auth/sso/microsoft/start'],
        ['GET', '/auth/sso/microsoft/callback'],
        ['POST', '/auth/sso/microsoft/link/start'],
        ['POST', '/auth/sso/microsoft/unlink'],
        ['POST', '/auth/sso/facebook/start'],
        ['GET', '/auth/sso/facebook/callback'],
      ]) {
        const result = await httpRequest(googleOnlyBase, path, { method, origin: googleOnlyBase });

        assert.equal(result.status, 404, `${method} ${path} should not exist`);
        assert.equal(
          result.text.includes(stubClients.microsoft.clientSecret),
          false,
          `${method} ${path} leaked a secret`,
        );
        assert.equal(
          result.text.includes(stubClients.facebook.clientSecret),
          false,
          `${method} ${path} leaked a secret`,
        );
      }

      // The enabled provider still has its routes.
      const googleStart = await httpRequest(googleOnlyBase, '/auth/sso/google/start', {
        body: {},
        origin: googleOnlyBase,
      });

      assert.equal(googleStart.status, 302, googleStart.text);
    });

    test('the callback surface is rate limited with Retry-After', async () => {
      let blocked;

      for (let attempt = 0; attempt < 200 && blocked === undefined; attempt += 1) {
        const result = await httpRequest(mainBase, '/auth/sso/google/callback?state=x&code=y', {
          method: 'GET',
          origin: mainBase,
        });

        if (result.status === 429) {
          blocked = result;
        } else {
          assert.equal(result.status, 400, result.text);
        }
      }

      assert.ok(blocked, 'callback rate limit was never enforced');
      assert.deepEqual(blocked.body, { error: { code: 'rate_limited' } });
      assert.match(blocked.headers.get('retry-after') ?? '', /^\d+$/);
    });

    test('production cookie serialization sets Secure, HttpOnly, SameSite=Lax and __Host-', () => {
      const production = sso.serializeSsoBindingCookie('binding-secret', 600, true);

      assert.match(production, /^__Host-habi_sso=binding-secret/);
      assert.match(production, /; Secure/);
      assert.match(production, /; HttpOnly/);
      assert.match(production, /; SameSite=Lax/);
      assert.match(production, /; Path=\//);
      assert.doesNotMatch(production, /Domain=/);

      const development = sso.serializeSsoBindingCookie('binding-secret', 600, false);

      assert.match(development, /^habi_sso=/);
      assert.doesNotMatch(development, /; Secure/);

      const cleared = sso.clearSsoBindingCookie(true);

      assert.match(cleared, /Max-Age=0/);
      assert.match(cleared, /; Secure/);
    });

    test('no secret appears in a log line or a response body', () => {
      const allSecrets = [...stub.secrets, ...Object.values(stubClients).map((c) => c.clientSecret)];

      assert.ok(allSecrets.length >= 6, 'expected the stub to have observed secrets');

      const logOutput = mainLogger.join('\n');

      for (const secret of allSecrets) {
        assert.equal(logOutput.includes(secret), false, 'a secret reached the application log');
      }

      for (const response of observedResponses) {
        for (const secret of allSecrets) {
          assert.equal(
            (response.text ?? '').includes(secret),
            false,
            `${response.label} returned a secret in its body`,
          );
          assert.equal(
            (response.location ?? '').includes(secret),
            false,
            `${response.label} returned a secret in a Location header`,
          );
        }
      }
    });

    test('pending records are short-lived', async () => {
      const flow = await startFlow(mainBase, GOOGLE, {
        identity: { subject: 'google-ttl', email: 'ttl@example.com', emailVerified: true },
      });
      const row = await pool.query(
        `SELECT created_at, expires_at
           FROM sso_pending_authorizations
          WHERE state_hash = $1`,
        [await stateHash(flow.authorize.searchParams.get('state'))],
      );

      assert.equal(row.rowCount, 1);

      const lifetimeMs = row.rows[0].expires_at.getTime() - row.rows[0].created_at.getTime();

      assert.ok(lifetimeMs >= 9 * 60 * 1000 && lifetimeMs <= 11 * 60 * 1000, `lifetime ${lifetimeMs}ms`);
      assert.equal(sso.SSO_PENDING_TTL_MS, 10 * 60 * 1000);
    });
  },
);
