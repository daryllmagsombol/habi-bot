/**
 * Cross-surface session sharing: one `SessionService` per process.
 *
 * Regression for the wiring defect where `AuthModule` and `P1ApiModule` each
 * provided their own in-memory `SessionService`. A cookie minted at
 * `POST /auth/login` was then unknown to every `/api/*` route (401
 * unauthenticated), and `POST /auth/logout` revoked a record the chat surface
 * never consulted.
 *
 * Boots the real `AppModule` in-process with both `HABI_AUTH_SPIKE=1` and
 * `HABI_P1_API=1` against an ephemeral PostgreSQL 18.6 container and the real
 * migrations. Also boots the compiled `main.js` in child processes to prove the
 * flag gates still compose correctly with the shared module.
 *
 * Docker unavailability skips the PostgreSQL half; the flag matrix still runs.
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import net from 'node:net';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool } = pg;

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const ENTRY = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const MIGRATE_SCRIPT = `${REPOSITORY_ROOT}scripts/db/migrate.mjs`;
const POSTGRES_IMAGE = 'postgres:18.6-alpine';
const DOCKER_USER = 'habi';
const DOCKER_DATABASE = 'habi';
const READY_TIMEOUT_MS = 20000;
const EXIT_TIMEOUT_MS = 10000;
const REQUEST_TIMEOUT_MS = 15000;
const PASSWORD = 'correct horse battery staple';
const SESSION_COOKIE_PATTERN = /^(?:__Host-)?habi_session=/;
const UNAUTHENTICATED = { error: { code: 'unauthenticated' } };
const CSRF_INVALID = { error: { code: 'csrf_invalid' } };
const IDLE_EXPIRY_OFFSET_MS = 31 * 60 * 1000;
const ABSOLUTE_EXPIRY_OFFSET_MS = 13 * 60 * 60 * 1000;

function dockerAvailable() {
  return new Promise((resolve) => {
    const child = spawn('docker', ['info'], { stdio: 'ignore' });

    child.once('error', () => resolve(false));
    child.once('exit', (code) => resolve(code === 0));
  });
}

function migrate(databaseUrl) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [MIGRATE_SCRIPT, '--database-url', databaseUrl],
      { cwd: REPOSITORY_ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }

      reject(new Error(`migrations failed (${code}):\n${stdout}\n${stderr}`));
    });
  });
}

function run(command, args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const output = { stdout: '', stderr: '' };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output.stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output.stderr += chunk;
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${command} ${args.join(' ')} timed out\n${output.stderr}`));
    }, timeoutMs);
    timer.unref?.();

    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, ...output });
    });
  });
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

      const { port } = address;

      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(port);
      });
    });
  });
}

async function waitForDatabase(pool) {
  const deadline = Date.now() + 60000;

  while (Date.now() < deadline) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  throw new Error('PostgreSQL did not become ready for the session-sharing suite.');
}

/** Session material from a response: cookie pair plus synchronizer token. */
function readSession(response) {
  const setCookie = response.headers.getSetCookie().find((cookie) =>
    SESSION_COOKIE_PATTERN.test(cookie),
  );

  assert.ok(setCookie, 'response did not set a session cookie');

  return {
    cookie: setCookie.split(';')[0],
    csrfToken: response.headers.get('x-csrf-token'),
    sessionId: setCookie.split(';')[0].slice(setCookie.indexOf('=') + 1),
  };
}

function createClient(base, session) {
  return async function request(path, options = {}) {
    const headers = { ...(options.headers ?? {}) };

    if (options.cookie !== false && session?.cookie !== undefined) {
      headers.cookie = session.cookie;
    }

    if (options.csrf === true) {
      headers['x-csrf-token'] = session.csrfToken;
    } else if (options.csrf === 'wrong') {
      headers['x-csrf-token'] = 'wrong-csrf-token';
    } else if (typeof options.csrf === 'string') {
      headers['x-csrf-token'] = options.csrf;
    }

    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
    }

    const response = await fetch(`${base}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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

    return { status: response.status, headers: response.headers, body, text };
  };
}

function captureOutput(child) {
  const output = { stdout: '', stderr: '' };

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    output.stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output.stderr += chunk;
  });

  return output;
}

function waitForEvent(child, eventName, output, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Timed out waiting for ${eventName}.\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`,
        ),
      );
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      child.stdout.off('data', check);
      child.stderr.off('data', check);
      child.off('exit', onExit);
    }

    function check() {
      for (const line of `${output.stdout}\n${output.stderr}`.split(/\r?\n/)) {
        if (line.trim() === '') {
          continue;
        }

        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }

        if (typeof event === 'object' && event !== null && event.event === eventName) {
          cleanup();
          resolve(event);
          return;
        }
      }
    }

    function onExit(code, signal) {
      cleanup();
      reject(
        new Error(
          `Process exited before ${eventName} (code=${code}, signal=${signal}).\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`,
        ),
      );
    }

    child.stdout.on('data', check);
    child.stderr.on('data', check);
    child.once('exit', onExit);
    check();
  });
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve();
    }, timeoutMs);
    timer.unref?.();

    function onExit() {
      clearTimeout(timer);
      resolve();
    }

    child.once('exit', onExit);
  });
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  child.kill('SIGTERM');
  await waitForExit(child, EXIT_TIMEOUT_MS);

  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await waitForExit(child, 5000);
  }
}

/**
 * Boots the compiled entry point with a controlled environment. The parent
 * environment never decides which surfaces a child enables.
 */
async function startChildApi(overrides = {}) {
  const port = await getFreePort();
  const env = {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    NODE_ENV: 'test',
  };

  for (const name of [
    'HABI_SPIKE_MODE',
    'HABI_SESSION_SPIKE',
    'HABI_SESSION_SPIKE_TEST_CLOCK',
    'HABI_AUTH_SPIKE',
    'HABI_P1_API',
    'HABI_P1_API_SSE_HEARTBEAT_MS',
    'DATABASE_URL',
  ]) {
    delete env[name];
  }

  Object.assign(env, overrides);

  const child = spawn(process.execPath, [ENTRY], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = captureOutput(child);

  try {
    await waitForEvent(child, 'api.ready', output, READY_TIMEOUT_MS);
  } catch (error) {
    await stopChild(child);
    throw error;
  }

  return {
    base: `http://127.0.0.1:${port}`,
    async stop() {
      await stopChild(child);
    },
  };
}

const dockerReady = await dockerAvailable();

describe(
  'P1 chat accepts auth login sessions (PostgreSQL)',
  { skip: dockerReady ? false : 'Docker daemon is unavailable' },
  () => {
    let containerName = '';
    let pool;
    let databaseUrl = '';
    let app;
    let base = '';
    let sessions;
    let request;
    let userA;
    let userB;
    let botA;
    let botB;

    async function insertInvite(email) {
      const token = randomBytes(32).toString('base64url');
      const tokenHash = createHash('sha256').update(token).digest('hex');

      await pool.query(
        `INSERT INTO invites (email, token_hash, expires_at)
         VALUES ($1, $2, now() + interval '1 hour')`,
        [email, tokenHash],
      );

      return token;
    }

    async function signup(email) {
      const inviteToken = await insertInvite(email);
      const response = await request('/auth/signup', {
        method: 'POST',
        cookie: false,
        body: { email, password: PASSWORD, inviteToken },
      });

      assert.equal(response.status, 201, response.text);

      return { session: readSession(response), user: response.body.user };
    }

    async function login(email) {
      const response = await request('/auth/login', {
        method: 'POST',
        cookie: false,
        body: { email, password: PASSWORD },
      });

      assert.equal(response.status, 200, response.text);

      return readSession(response);
    }

    before(async () => {
      containerName = `habi-session-sharing-${randomBytes(6).toString('hex')}`;
      const password = randomBytes(24).toString('hex');
      const container = await run('docker', [
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
      ]);

      assert.equal(container.code, 0, container.stderr);

      const published = await run('docker', ['port', containerName, '5432/tcp']);
      assert.equal(published.code, 0, published.stderr);

      const port = Number.parseInt(
        published.stdout.trim().split(':').pop() ?? '',
        10,
      );
      assert.ok(Number.isInteger(port) && port > 0, 'Docker did not publish PostgreSQL');

      pool = new Pool({
        host: '127.0.0.1',
        port,
        user: DOCKER_USER,
        password,
        database: DOCKER_DATABASE,
        max: 6,
      });

      await waitForDatabase(pool);
      databaseUrl = `postgres://${DOCKER_USER}:${password}@127.0.0.1:${port}/${DOCKER_DATABASE}`;
      await migrate(databaseUrl);

      process.env.NODE_ENV = 'test';
      process.env.HABI_AUTH_SPIKE = '1';
      process.env.HABI_P1_API = '1';
      // Expiry is exercised through the test-only clock header; it is honoured
      // only with this flag, so a normal deployment cannot shift its windows.
      process.env.HABI_SESSION_SPIKE_TEST_CLOCK = '1';
      process.env.DATABASE_URL = databaseUrl;

      const { AppModule } = await import('../dist/app.module.js');
      const { NestFactory } = await import('@nestjs/core');
      const { SessionService } = await import('../dist/session/session.service.js');

      app = await NestFactory.create(AppModule, { logger: false });
      await app.listen(0, '127.0.0.1');

      const address = app.getHttpServer().address();
      assert.ok(
        address !== null && typeof address === 'object',
        'the app did not bind a TCP port',
      );
      base = `http://127.0.0.1:${address.port}`;
      sessions = app.get(SessionService);
      request = createClient(base);

      const signedUpA = await signup('session-a@example.test');
      const signedUpB = await signup('session-b@example.test');

      userA = signedUpA.user;
      userB = signedUpB.user;
      botA = randomUUID();
      botB = randomUUID();

      await pool.query(
        `INSERT INTO bots (id, owner_user_id, name, description, instructions_markdown, status)
         VALUES ($1, $2, 'Bot A', '', '', 'active'), ($3, $4, 'Bot B', '', '', 'active')`,
        [botA, userA.userId, botB, userB.userId],
      );

      // The signup cookies must also be the same records the chat surface
      // validates; do not leave them live for later checks.
      for (const signedUp of [signedUpA, signedUpB]) {
        const loggedOut = await createClient(base, signedUp.session)('/auth/logout', {
          method: 'POST',
          csrf: true,
        });

        assert.equal(loggedOut.status, 200, loggedOut.text);
      }
    });

    after(async () => {
      if (app !== undefined) {
        await app.close().catch(() => {});
      }

      if (pool !== undefined) {
        await pool.query('DELETE FROM run_events').catch(() => {});
        await pool.query('DELETE FROM runs').catch(() => {});
        await pool.query('DELETE FROM messages').catch(() => {});
        await pool.query('DELETE FROM conversations').catch(() => {});
        await pool.query('DELETE FROM bots').catch(() => {});
        await pool.query('DELETE FROM invites').catch(() => {});
        await pool.query('DELETE FROM auth_sessions').catch(() => {});
        await pool.query('DELETE FROM users').catch(() => {});
        await pool.end().catch(() => {});
      }

      if (containerName !== '') {
        await run('docker', ['rm', '-f', containerName], 30000);
      }
    });

    test('login cookie is accepted by GET /api/bots', async () => {
      const session = await login('session-a@example.test');
      const response = await createClient(base, session)('/api/bots');

      assert.equal(
        response.status,
        200,
        `login session reached /api/bots as ${response.status}: ${response.text}`,
      );
      assert.deepEqual(
        response.body.bots.map((bot) => bot.id),
        [botA],
      );
    });

    test('the login CSRF token is accepted by a chat mutation', async () => {
      const session = await login('session-a@example.test');
      const client = createClient(base, session);

      const accepted = await client(`/api/runs/${randomUUID()}/cancel`, {
        method: 'POST',
        csrf: true,
      });

      // The token passed both guards; ownership resolves the unknown Run 404.
      assert.equal(accepted.status, 404, accepted.text);
      assert.deepEqual(accepted.body, { error: { code: 'not_found' } });

      const wrong = await client(`/api/runs/${randomUUID()}/cancel`, {
        method: 'POST',
        csrf: 'wrong',
      });

      assert.equal(wrong.status, 403, wrong.text);
      assert.deepEqual(wrong.body, CSRF_INVALID);

      const missing = await client(`/api/runs/${randomUUID()}/cancel`, {
        method: 'POST',
      });

      assert.equal(missing.status, 403, missing.text);
      assert.deepEqual(missing.body, CSRF_INVALID);
    });

    test('a CSRF token from another session is rejected', async () => {
      const sessionA = await login('session-a@example.test');
      const sessionB = await login('session-b@example.test');

      const crossed = await createClient(base, sessionA)('/api/runs/x/cancel', {
        method: 'POST',
        csrf: sessionB.csrfToken,
      });

      assert.equal(crossed.status, 403, crossed.text);
      assert.deepEqual(crossed.body, CSRF_INVALID);
    });

    test('logout revokes the session on /api/* and /auth/me immediately', async () => {
      const session = await login('session-a@example.test');
      const client = createClient(base, session);
      const logout = await client('/auth/logout', { method: 'POST', csrf: true });

      assert.equal(logout.status, 200, logout.text);
      assert.deepEqual(logout.body, { ok: true });

      const bots = await client('/api/bots');
      assert.equal(bots.status, 401, bots.text);
      assert.deepEqual(bots.body, UNAUTHENTICATED);

      const me = await client('/auth/me');
      assert.equal(me.status, 401, me.text);
      assert.deepEqual(me.body, UNAUTHENTICATED);
    });

    test('a session revoked through the shared service is rejected by /api/*', async () => {
      const session = await login('session-a@example.test');

      assert.equal(sessions.revoke(session.sessionId), true);

      const bots = await createClient(base, session)('/api/bots');
      assert.equal(bots.status, 401, bots.text);
      assert.deepEqual(bots.body, UNAUTHENTICATED);
    });

    test('an idle-expired session is rejected by /api/*', async () => {
      const session = await login('session-a@example.test');
      const expired = await createClient(base, session)('/api/bots', {
        headers: {
          'x-session-spike-now-offset-ms': String(IDLE_EXPIRY_OFFSET_MS),
        },
      });

      assert.equal(expired.status, 401, expired.text);
      assert.deepEqual(expired.body, UNAUTHENTICATED);
    });

    test('an absolutely expired session is rejected by /api/*', async () => {
      const session = await login('session-a@example.test');
      const expired = await createClient(base, session)('/api/bots', {
        headers: {
          'x-session-spike-now-offset-ms': String(ABSOLUTE_EXPIRY_OFFSET_MS),
        },
      });

      assert.equal(expired.status, 401, expired.text);
      assert.deepEqual(expired.body, UNAUTHENTICATED);
    });

    test('two users hold separate sessions and cannot see each other', async () => {
      const sessionA = await login('session-a@example.test');
      const sessionB = await login('session-b@example.test');
      const clientA = createClient(base, sessionA);
      const clientB = createClient(base, sessionB);

      const listA = await clientA('/api/bots');
      const listB = await clientB('/api/bots');

      assert.equal(listA.status, 200, listA.text);
      assert.equal(listB.status, 200, listB.text);
      assert.deepEqual(listA.body.bots.map((bot) => bot.id), [botA]);
      assert.deepEqual(listB.body.bots.map((bot) => bot.id), [botB]);

      const foreignA = await clientB(`/api/bots/${botA}`);
      const foreignB = await clientA(`/api/bots/${botB}`);

      assert.equal(foreignA.status, 404, foreignA.text);
      assert.equal(foreignB.status, 404, foreignB.text);
    });
  },
);

describe('flag boot matrix with the shared session core', () => {
  async function bootAndProbe(flags) {
    const server = await startChildApi(flags);

    try {
      const health = await fetch(`${server.base}/health`);
      const login = await fetch(`${server.base}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      const bots = await fetch(`${server.base}/api/bots`);

      return {
        health: health.status,
        login: login.status,
        bots: bots.status,
      };
    } finally {
      await server.stop();
    }
  }

  test('both flags unset expose no auth or /api routes', async () => {
    const probe = await bootAndProbe({});

    assert.deepEqual(probe, { health: 200, login: 404, bots: 404 });
  });

  test('HABI_AUTH_SPIKE alone registers auth routes only', async () => {
    const probe = await bootAndProbe({ HABI_AUTH_SPIKE: '1' });

    // 400 invalid_request proves the route exists and runs the flag guard.
    assert.deepEqual(probe, { health: 200, login: 400, bots: 404 });
  });

  test('HABI_P1_API alone registers /api routes only', async () => {
    const probe = await bootAndProbe({ HABI_P1_API: '1' });

    // 401 proves the shared session guard runs; the login route is absent.
    assert.deepEqual(probe, { health: 200, login: 404, bots: 401 });
  });

  test('both flags on register both surfaces over one session core', async () => {
    const probe = await bootAndProbe({ HABI_AUTH_SPIKE: '1', HABI_P1_API: '1' });

    assert.deepEqual(probe, { health: 200, login: 400, bots: 401 });
  });
});
