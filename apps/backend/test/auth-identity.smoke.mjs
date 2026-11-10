/**
 * H-014 (#14) first identity slice: PostgreSQL-backed signup, login, logout,
 * recovery, rate limits, and the `HABI_AUTH_SPIKE` gate.
 *
 * Starts an ephemeral PostgreSQL 18.6 container on a random loopback port,
 * applies the real migrations, and boots the built `AuthModule` in-process
 * with the in-memory H-017 session core. Skips cleanly when Docker is absent.
 *
 * No real email is sent and no raw invite/recovery token is returned by any
 * route; the tests inspect hashed rows directly to prove single-use storage.
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool } = pg;

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const MIGRATE_SCRIPT = `${REPOSITORY_ROOT}scripts/db/migrate.mjs`;
const POSTGRES_IMAGE = 'postgres:18.6-alpine';
const DOCKER_USER = 'habi';
const DOCKER_DATABASE = 'habi';
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCRYPT_PATTERN =
  /^scrypt\$1\$32768\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/;
const SESSION_COOKIE_PATTERN = /^(?:__Host-)?habi_session=/;

function dockerAvailable() {
  const result = spawnSync('docker', ['info'], { stdio: 'ignore', timeout: 5000 });
  return result.status === 0;
}

function migrate(databaseUrl, extraArgs = []) {
  return spawnSync(
    process.execPath,
    [MIGRATE_SCRIPT, '--database-url', databaseUrl, ...extraArgs],
    { cwd: REPOSITORY_ROOT, encoding: 'utf8', timeout: 60000 },
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

const dockerReady = dockerAvailable();

describe(
  'H-014 auth identity slice',
  { skip: dockerReady ? false : 'Docker daemon is unavailable' },
  () => {
    let containerName = '';
    let port = 0;
    let password = '';
    let pool;
    let databaseUrl = '';
    let app;
    let base = '';
    let auth;
    let loginCookie = '';
    let loginCsrf = '';
    let loginUserId = '';

    function sessionCookie(setCookies) {
      return setCookies.find((cookie) => SESSION_COOKIE_PATTERN.test(cookie));
    }

    function cookiePair(setCookie) {
      return setCookie.split(';')[0];
    }

    async function http(path, options = {}) {
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

      const response = await fetch(`${base}${path}`, {
        method: options.method ?? 'POST',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
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

      return {
        response,
        status: response.status,
        body,
        text,
        setCookies: response.headers.getSetCookie(),
      };
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

    async function signup(email, plainPassword, inviteToken) {
      return http('/auth/signup', {
        body: { email, password: plainPassword, inviteToken },
      });
    }

    async function login(email, plainPassword) {
      return http('/auth/login', { body: { email, password: plainPassword } });
    }

    before(async () => {
      containerName = `habi-h014-${randomBytes(6).toString('hex')}`;
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
        max: 6,
      });

      await waitForDatabase(pool, containerName);
      databaseUrl = `postgres://${DOCKER_USER}:${password}@127.0.0.1:${port}/${DOCKER_DATABASE}`;

      const pending = migrate(databaseUrl, ['--dry-run']);
      assert.equal(pending.status, 0, pending.stderr);
      assert.match(pending.stdout, /pending\s+0006_auth_identity\.sql/);

      const applied = migrate(databaseUrl);
      assert.equal(applied.status, 0, applied.stderr);
      for (const name of [
        '0001_conversations.sql',
        '0002_runs.sql',
        '0003_messages.sql',
        '0004_bot_profiles.sql',
        '0006_auth_identity.sql',
      ]) {
        assert.match(applied.stdout, new RegExp(`applied\\s+${name.replace('.', '\\.')}`));
      }

      const upToDate = migrate(databaseUrl);
      assert.equal(upToDate.status, 0, upToDate.stderr);
      assert.match(upToDate.stdout, /up to date/);

      auth = await import('../dist/auth/index.js');
      const { NestFactory } = await import('@nestjs/core');

      process.env.DATABASE_URL = databaseUrl;
      process.env.HABI_AUTH_SPIKE = '1';
      process.env.HABI_REGISTRATION_MODE = 'invite';
      process.env.NODE_ENV = 'test';

      app = await NestFactory.create(auth.AuthModule, { logger: false });
      await app.listen(0, '127.0.0.1');
      const address = app.getHttpServer().address();
      base = `http://127.0.0.1:${address.port}`;
    });

    after(async () => {
      if (app !== undefined) {
        await app.close().catch(() => {});
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

    test('signup consumes an email-bound invite and issues an HttpOnly session', async () => {
      const inviteToken = auth.mintToken();
      const canonical = 'signal.user@example.com';

      await insertInvite('Signal.User@Example.com', inviteToken);

      const result = await signup(
        'Signal.User@Example.com',
        'correct horse battery staple',
        inviteToken,
      );

      assert.equal(result.status, 201, result.text);
      assert.deepEqual(Object.keys(result.body).sort(), ['csrfToken', 'user']);
      assert.match(result.body.user.userId, UUID_PATTERN);
      assert.equal(result.body.user.email, canonical);
      assert.equal(result.body.session, undefined);
      assert.doesNotMatch(result.text, /correct horse battery staple/);

      const setCookie = sessionCookie(result.setCookies);
      assert.ok(setCookie, 'signup did not set a session cookie');
      assert.match(setCookie, /; HttpOnly/);
      assert.match(setCookie, /; SameSite=Lax/);
      assert.match(setCookie, /; Path=\//);
      assert.match(setCookie, /; Max-Age=\d+/);
      assert.doesNotMatch(setCookie, /; Secure/);

      const user = await pool.query(
        'SELECT id, email, password_hash, email_verified_at FROM users WHERE email = $1',
        [canonical],
      );
      assert.equal(user.rowCount, 1);
      assert.match(user.rows[0].password_hash, SCRYPT_PATTERN);
      assert.notEqual(user.rows[0].password_hash, 'correct horse battery staple');
      // Email verification is not part of this slice; do not fake a verified
      // timestamp to paper over the gap.
      assert.equal(user.rows[0].email_verified_at, null);

      const invite = await pool.query(
        'SELECT token_hash, used_at FROM invites WHERE email = $1',
        [canonical],
      );
      assert.equal(invite.rows[0].used_at instanceof Date, true);
      assert.match(invite.rows[0].token_hash, /^[0-9a-f]{64}$/);
      assert.notEqual(invite.rows[0].token_hash, inviteToken);

      const me = await http('/auth/me', {
        method: 'GET',
        cookie: cookiePair(setCookie),
      });
      assert.equal(me.status, 200, me.text);
      assert.equal(me.body.user.email, canonical);
      assert.equal(me.body.user.userId, result.body.user.userId);
    });

    test('duplicate signup is generic and leaves the second invite unused', async () => {
      const duplicateToken = auth.mintToken();
      await insertInvite('signal.user@example.com', duplicateToken);

      const result = await signup(
        'signal.user@example.com',
        'yet another long password',
        duplicateToken,
      );

      assert.equal(result.status, 409, result.text);
      assert.deepEqual(result.body, { error: { code: 'signup_unavailable' } });
      assert.doesNotMatch(result.text, /signal\.user@example\.com/i);

      const invite = await pool.query(
        'SELECT used_at FROM invites WHERE token_hash = $1',
        [auth.hashToken(duplicateToken)],
      );
      assert.equal(invite.rows[0].used_at, null);

      const users = await pool.query('SELECT count(*)::int AS count FROM users WHERE email = $1', [
        'signal.user@example.com',
      ]);
      assert.equal(users.rows[0].count, 1);
    });

    test('concurrent signup with one invite creates exactly one account', async () => {
      const token = auth.mintToken();
      await insertInvite('race@example.com', token);

      const [first, second] = await Promise.all([
        signup('race@example.com', 'a sufficiently long passphrase', token),
        signup('race@example.com', 'a sufficiently long passphrase', token),
      ]);

      assert.deepEqual(
        [first.status, second.status].sort((left, right) => left - right),
        [201, 409],
      );

      const users = await pool.query(
        'SELECT count(*)::int AS count FROM users WHERE email = $1',
        ['race@example.com'],
      );
      assert.equal(users.rows[0].count, 1);

      const invites = await pool.query(
        `SELECT count(*)::int AS total, count(used_at)::int AS used
           FROM invites
          WHERE email = $1`,
        ['race@example.com'],
      );
      assert.equal(invites.rows[0].total, 1);
      assert.equal(invites.rows[0].used, 1);
    });

    test('weak and email-matching passwords are rejected without consuming the invite', async () => {
      const token = auth.mintToken();
      await insertInvite('weak@example.com', token);

      const short = await signup('weak@example.com', 'short', token);
      assert.equal(short.status, 400, short.text);
      assert.deepEqual(short.body, { error: { code: 'password_policy' } });

      const matchesEmail = await signup('weak@example.com', 'weak@example.com', token);
      assert.equal(matchesEmail.status, 400, matchesEmail.text);
      assert.deepEqual(matchesEmail.body, { error: { code: 'password_policy' } });

      let invite = await pool.query('SELECT used_at FROM invites WHERE token_hash = $1', [
        auth.hashToken(token),
      ]);
      assert.equal(invite.rows[0].used_at, null);

      const accepted = await signup('weak@example.com', 'a sufficiently long passphrase', token);
      assert.equal(accepted.status, 201, accepted.text);

      invite = await pool.query('SELECT used_at FROM invites WHERE token_hash = $1', [
        auth.hashToken(token),
      ]);
      assert.notEqual(invite.rows[0].used_at, null);
    });

    test('invites must exist, be unused, be unexpired, and match the email', async () => {
      const reuseToken = auth.mintToken();
      await insertInvite('reuse@example.com', reuseToken);

      const first = await signup(
        'reuse@example.com',
        'a sufficiently long passphrase',
        reuseToken,
      );
      assert.equal(first.status, 201, first.text);

      const reused = await signup(
        'reuse@example.com',
        'a sufficiently long passphrase',
        reuseToken,
      );
      assert.equal(reused.status, 409, reused.text);
      assert.deepEqual(reused.body, { error: { code: 'signup_unavailable' } });

      const expiredToken = auth.mintToken();
      await insertInvite('expired@example.com', expiredToken, {
        createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
        expiresAt: new Date(Date.now() - 60 * 60 * 1000),
      });
      const expired = await signup(
        'expired@example.com',
        'a sufficiently long passphrase',
        expiredToken,
      );
      assert.equal(expired.status, 409, expired.text);
      assert.deepEqual(expired.body, { error: { code: 'signup_unavailable' } });

      const boundToken = auth.mintToken();
      await insertInvite('bound@example.com', boundToken);
      const mismatched = await signup(
        'intruder@example.com',
        'a sufficiently long passphrase',
        boundToken,
      );
      assert.equal(mismatched.status, 409, mismatched.text);
      assert.deepEqual(mismatched.body, { error: { code: 'signup_unavailable' } });

      const invite = await pool.query('SELECT used_at FROM invites WHERE token_hash = $1', [
        auth.hashToken(boundToken),
      ]);
      assert.equal(invite.rows[0].used_at, null);

      const intruder = await pool.query('SELECT count(*)::int AS count FROM users WHERE email = $1', [
        'intruder@example.com',
      ]);
      assert.equal(intruder.rows[0].count, 0);
    });

    test('login is uniform for unknown email and wrong password', async () => {
      const token = auth.mintToken();
      await insertInvite('login@example.com', token);
      const created = await signup('login@example.com', 'the login account passphrase', token);
      assert.equal(created.status, 201, created.text);

      const wrong = await login('login@example.com', 'not the right passphrase');
      const unknown = await login('missing@example.com', 'not the right passphrase');

      assert.equal(wrong.status, 401);
      assert.equal(unknown.status, 401);
      assert.deepEqual(wrong.body, { error: { code: 'invalid_credentials' } });
      assert.deepEqual(unknown.body, wrong.body);
      assert.doesNotMatch(wrong.text, /login@example\.com/i);

      const accepted = await login('LOGIN@example.com', 'the login account passphrase');
      assert.equal(accepted.status, 200, accepted.text);
      assert.equal(accepted.body.user.email, 'login@example.com');
      assert.equal(accepted.body.session, undefined);

      const setCookie = sessionCookie(accepted.setCookies);
      assert.ok(setCookie, 'login did not set a session cookie');
      assert.match(setCookie, /; HttpOnly/);

      const me = await http('/auth/me', { method: 'GET', cookie: cookiePair(setCookie) });
      assert.equal(me.status, 200, me.text);
      assert.equal(me.body.user.email, 'login@example.com');

      loginCookie = cookiePair(setCookie);
      loginCsrf = accepted.body.csrfToken;
      loginUserId = accepted.body.user.userId;
    });

    test('logout requires the session CSRF token and revokes the session', async () => {
      const missingCsrf = await http('/auth/logout', {
        cookie: loginCookie,
      });
      assert.equal(missingCsrf.status, 403, missingCsrf.text);
      assert.deepEqual(missingCsrf.body, { error: { code: 'csrf_invalid' } });

      const stillLive = await http('/auth/me', {
        method: 'GET',
        cookie: loginCookie,
      });
      assert.equal(stillLive.status, 200);

      const logout = await http('/auth/logout', {
        cookie: loginCookie,
        csrf: loginCsrf,
      });
      assert.equal(logout.status, 200, logout.text);
      assert.deepEqual(logout.body, { ok: true });

      const cleared = sessionCookie(logout.setCookies);
      assert.ok(cleared, 'logout did not clear the session cookie');
      assert.match(cleared, /Max-Age=0/);

      const revoked = await http('/auth/me', {
        method: 'GET',
        cookie: loginCookie,
      });
      assert.equal(revoked.status, 401, revoked.text);
      assert.deepEqual(revoked.body, { error: { code: 'unauthenticated' } });
    });

    test('recovery is enumeration-safe and records only a hashed single-use token', async () => {
      const userId = loginUserId;

      const before = await pool.query(
        'SELECT count(*)::int AS count FROM password_reset_tokens WHERE user_id = $1',
        [userId],
      );

      const known = await http('/auth/recovery/request', {
        body: { email: 'login@example.com' },
      });
      const unknown = await http('/auth/recovery/request', {
        body: { email: 'nobody@example.com' },
      });

      assert.equal(known.status, 200, known.text);
      assert.equal(unknown.status, 200, unknown.text);
      assert.deepEqual(known.body, { ok: true });
      assert.deepEqual(unknown.body, known.body);
      assert.doesNotMatch(known.text, /token/i);

      const rows = await pool.query(
        `SELECT token_hash, created_at, expires_at, used_at
           FROM password_reset_tokens
          WHERE user_id = $1
          ORDER BY created_at DESC`,
        [userId],
      );
      assert.equal(rows.rowCount, before.rows[0].count + 1);
      assert.match(rows.rows[0].token_hash, /^[0-9a-f]{64}$/);
      assert.equal(rows.rows[0].used_at, null);

      const lifetimeMinutes =
        (rows.rows[0].expires_at.getTime() - rows.rows[0].created_at.getTime()) / 60000;
      assert.ok(lifetimeMinutes > 25 && lifetimeMinutes < 35, `unexpected lifetime ${lifetimeMinutes}`);

      const second = await http('/auth/recovery/request', {
        body: { email: 'login@example.com' },
      });
      assert.equal(second.status, 200, second.text);

      const active = await pool.query(
        `SELECT count(*)::int AS count
           FROM password_reset_tokens
          WHERE user_id = $1 AND used_at IS NULL`,
        [userId],
      );
      assert.equal(active.rows[0].count, 1, 'at most one usable recovery token per user');

      const unusedBefore = await pool.query(
        'SELECT count(*)::int AS count FROM password_reset_tokens WHERE user_id = $1',
        [userId],
      );
      assert.equal(unusedBefore.rows[0].count, before.rows[0].count + 2);
    });

    test('signup, login, and recovery share a fixed-window 429 with Retry-After', async () => {
      const signupToken = 'not-a-real-invite-token';
      let signupBlocked;

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const result = await signup(
          'signup.limit@example.com',
          'a sufficiently long passphrase',
          signupToken,
        );
        assert.equal(result.status, 409, `signup attempt ${attempt}: ${result.text}`);
      }

      signupBlocked = await signup(
        'signup.limit@example.com',
        'a sufficiently long passphrase',
        signupToken,
      );
      assert.equal(signupBlocked.status, 429, signupBlocked.text);
      assert.deepEqual(signupBlocked.body, { error: { code: 'rate_limited' } });
      assert.match(signupBlocked.response.headers.get('retry-after') ?? '', /^\d+$/);

      let loginBlocked;

      for (let attempt = 0; attempt < 10; attempt += 1) {
        const result = await login('rate.limit@example.com', 'a wrong but long password');
        assert.equal(result.status, 401, `login attempt ${attempt}: ${result.text}`);
      }

      loginBlocked = await login('rate.limit@example.com', 'a wrong but long password');
      assert.equal(loginBlocked.status, 429, loginBlocked.text);
      assert.deepEqual(loginBlocked.body, { error: { code: 'rate_limited' } });
      assert.doesNotMatch(loginBlocked.text, /rate\.limit@example\.com/i);
      assert.ok(Number(loginBlocked.response.headers.get('retry-after')) >= 1);

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const result = await http('/auth/recovery/request', {
          body: { email: 'recovery.limit@example.com' },
        });
        assert.equal(result.status, 200, `recovery attempt ${attempt}: ${result.text}`);
      }

      const recoveryBlocked = await http('/auth/recovery/request', {
        body: { email: 'recovery.limit@example.com' },
      });
      assert.equal(recoveryBlocked.status, 429, recoveryBlocked.text);
      assert.deepEqual(recoveryBlocked.body, { error: { code: 'rate_limited' } });
    });

    test('closed registration refuses signup without touching login or recovery', async () => {
      const service = new auth.AuthService({
        repository: {
          createAccountWithInvite: async () => {
            throw new Error('closed registration must not reach storage');
          },
          findActiveCredentialByEmail: async () => undefined,
          findActiveIdentityById: async () => undefined,
          createRecoveryToken: async () => {},
        },
        sessions: {
          issue: () => ({ sessionSecret: 'secret', csrfToken: 'csrf', maxAgeSeconds: 60 }),
          revoke: () => true,
        },
        registrationMode: 'closed',
      });

      await assert.rejects(
        service.signup({
          email: 'closed@example.com',
          password: 'a sufficiently long passphrase',
          inviteToken: 'token',
          clientKey: 'test-client',
        }),
        (error) => {
          assert.equal(error.code, 'registration_closed');
          assert.equal(error.status, 403);
          return true;
        },
      );

      await service.requestRecovery({
        email: 'closed@example.com',
        clientKey: 'test-client',
      });
    });

    test('the auth surface is absent unless HABI_AUTH_SPIKE=1', async () => {
      process.env.HABI_AUTH_SPIKE = '0';

      try {
        const hiddenMe = await http('/auth/me', { method: 'GET' });
        assert.equal(hiddenMe.status, 404, hiddenMe.text);
        assert.deepEqual(hiddenMe.body, { error: { code: 'not_found' } });

        const hiddenLogin = await login('login@example.com', 'the login account passphrase');
        assert.equal(hiddenLogin.status, 404, hiddenLogin.text);
        assert.deepEqual(hiddenLogin.body, { error: { code: 'not_found' } });
      } finally {
        process.env.HABI_AUTH_SPIKE = '1';
      }
    });
  },
);
