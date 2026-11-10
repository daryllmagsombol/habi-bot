/**
 * Durable session store: restart survival, expiry, revocation, and at-rest
 * shape (PostgreSQL).
 *
 * The gap this suite closes: the session slice used to keep records in a
 * per-process `Map`, so a restart dropped every session and the P1 acceptance
 * runbook had to record "sessions are non-durable" as a residual risk.
 *
 * The headline test creates a session in one compiled API process and
 * authenticates it in a *second* process, then in a third process after both
 * earlier ones have stopped. Everything else here is the contract that must not
 * regress while storage changed:
 *
 *   - idle and absolute expiry still obey the injected clock;
 *   - logout, `revokeAllForUser`, and reuse detection still revoke;
 *   - two users stay separate;
 *   - raw session secrets and CSRF tokens never reach the table, and a client's
 *     CSRF token is still accepted after a restart because only its digest is
 *     compared;
 *   - the bounded sweep removes rows that can no longer authenticate.
 *
 * Docker unavailability skips the PostgreSQL half. The store-selection checks
 * need no database and always run.
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import net from 'node:net';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';

const { Pool } = pg;

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const ENTRY = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const SERVICE_MODULE_URL = pathToFileURL(
  fileURLToPath(new URL('../dist/session/session.service.js', import.meta.url)),
).href;
const STORE_MODULE_URL = pathToFileURL(
  fileURLToPath(new URL('../dist/session/session-postgres-store.js', import.meta.url)),
).href;
const MIGRATE_SCRIPT = `${REPOSITORY_ROOT}scripts/db/migrate.mjs`;
const POSTGRES_IMAGE = 'postgres:18.6-alpine';
const DOCKER_USER = 'habi';
const DOCKER_DATABASE = 'habi';
const READY_TIMEOUT_MS = 20000;
const EXIT_TIMEOUT_MS = 10000;
const REQUEST_TIMEOUT_MS = 15000;
const TASK_TIMEOUT_MS = 30000;
const STORE_VISIBLE_TIMEOUT_MS = 5000;
const PASSWORD = 'correct horse battery staple';
const SESSION_COOKIE_PATTERN = /^(?:__Host-)?habi_session=/;
const UNAUTHENTICATED = { error: { code: 'unauthenticated' } };
const CSRF_INVALID = { error: { code: 'csrf_invalid' } };
const NOT_FOUND = { error: { code: 'not_found' } };
const IDLE_TTL_MS = 30 * 60 * 1000;
const ABSOLUTE_TTL_MS = 12 * 60 * 60 * 1000;
const RETIRED_RETENTION_MS = 24 * 60 * 60 * 1000;
const TEST_CLOCK_HEADER = 'x-session-spike-now-offset-ms';

function dockerAvailable() {
  return new Promise((resolve) => {
    const child = spawn('docker', ['info'], { stdio: 'ignore' });

    child.once('error', () => resolve(false));
    child.once('exit', (code) => resolve(code === 0));
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

function migrate(databaseUrl) {
  return run(process.execPath, [MIGRATE_SCRIPT, '--database-url', databaseUrl]).then(
    (result) => {
      assert.equal(result.code, 0, `migrations failed:\n${result.stdout}\n${result.stderr}`);
      return result.stdout;
    },
  );
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

  throw new Error('PostgreSQL did not become ready for the session durability suite.');
}

function hashHex(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** Session material from a response: cookie pair plus synchronizer token. */
function readSession(response) {
  const setCookie = response.headers
    .getSetCookie()
    .find((cookie) => SESSION_COOKIE_PATTERN.test(cookie));

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

  // SIGTERM runs Nest's shutdown hooks, which flush the store's write queue.
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
async function startApiChild(overrides = {}) {
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
    'HABI_SESSION_STORE',
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

/**
 * Runs one service-level operation against the same database in its own
 * process, then flushes and closes. Used for calls the HTTP surface does not
 * expose (`revokeAllForUser`, the explicit sweep) without reaching into a
 * running child's memory.
 */
function runServiceTask(statements, env) {
  const script = [
    `import { systemClock, SessionService } from ${JSON.stringify(SERVICE_MODULE_URL)};`,
    `import { PostgresSessionStore } from ${JSON.stringify(STORE_MODULE_URL)};`,
    'const store = new PostgresSessionStore({ connectionString: process.env.DATABASE_URL });',
    'await store.hydrate();',
    'const service = new SessionService(systemClock, store);',
    'let result;',
    statements,
    'await store.flush();',
    'await store.close();',
    'process.stdout.write(JSON.stringify(result));',
  ].join('\n');

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = captureOutput(child);

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(
        new Error(`service task timed out.\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`),
      );
    }, TASK_TIMEOUT_MS);
    timer.unref?.();

    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);

      if (code !== 0) {
        reject(
          new Error(`service task failed (${code}).\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`),
        );
        return;
      }

      try {
        resolve(JSON.parse(output.stdout));
      } catch {
        reject(new Error(`service task printed no result.\nstdout:\n${output.stdout}`));
      }
    });
  });
}

const dockerReady = await dockerAvailable();

describe('store selection is explicit and fails closed', () => {
  async function bootExpectingFailure(flags) {
    const port = await getFreePort();
    const env = { ...process.env, HOST: '127.0.0.1', PORT: String(port), NODE_ENV: 'test' };

    for (const name of ['HABI_SESSION_STORE', 'DATABASE_URL', 'HABI_SESSION_SPIKE']) {
      delete env[name];
    }

    Object.assign(env, flags);

    const child = spawn(process.execPath, [ENTRY], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const output = captureOutput(child);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`process did not exit.\nstdout:\n${output.stdout}`));
      }, READY_TIMEOUT_MS);
      timer.unref?.();

      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        resolve({ code, ...output });
      });
    });
  }

  // Nest aborts the bootstrap on a provider factory error (and, with the
  // logger disabled, prints nothing), so the evidence is: non-zero exit and no
  // `api.ready`. The control below proves that is the store mode and not the
  // absence of a database.
  function assertRefusedToBoot(result, label) {
    assert.equal(result.code, 1, `${label}: expected exit 1, got ${result.code}\n${result.stdout}`);
    assert.equal(
      result.stdout.includes('api.ready'),
      false,
      `${label}: the process served traffic`,
    );
    assert.equal(
      result.stderr.includes('api.ready'),
      false,
      `${label}: the process served traffic`,
    );
  }

  test('HABI_SESSION_STORE=postgres without DATABASE_URL refuses to boot', async () => {
    const result = await bootExpectingFailure({
      HABI_P1_API: '1',
      HABI_SESSION_STORE: 'postgres',
    });

    assertRefusedToBoot(result, 'forced postgres with no database');
  });

  test('an unknown HABI_SESSION_STORE value refuses to boot', async () => {
    const result = await bootExpectingFailure({
      HABI_P1_API: '1',
      HABI_SESSION_STORE: 'redis',
    });

    assertRefusedToBoot(result, 'unknown store mode');
  });

  test('HABI_SESSION_STORE=memory without a database still boots', async () => {
    const api = await startApiChild({ HABI_P1_API: '1', HABI_SESSION_STORE: 'memory' });

    try {
      const bots = await fetch(`${api.base}/api/bots`);
      const me = await fetch(`${api.base}/auth/me`);

      // 401 proves the session guard ran; the auth surface is not registered.
      assert.equal(bots.status, 401);
      assert.equal(me.status, 404);
    } finally {
      await api.stop();
    }
  });
});

describe(
  'durable session store (PostgreSQL)',
  { skip: dockerReady ? false : 'Docker daemon is unavailable' },
  () => {
    let containerName = '';
    let pool;
    let databaseUrl = '';
    let emailCounter = 0;

    async function insertInvite(email) {
      const token = randomBytes(32).toString('base64url');

      await pool.query(
        `INSERT INTO invites (email, token_hash, expires_at)
         VALUES ($1, $2, now() + interval '1 hour')`,
        [email, hashHex(token)],
      );

      return token;
    }

    async function signup(base, email) {
      const inviteToken = await insertInvite(email);
      const response = await createClient(base)('/auth/signup', {
        method: 'POST',
        cookie: false,
        body: { email, password: PASSWORD, inviteToken },
      });

      assert.equal(response.status, 201, response.text);

      return { session: readSession(response), user: response.body.user };
    }

    async function login(base, email) {
      const response = await createClient(base)('/auth/login', {
        method: 'POST',
        cookie: false,
        body: { email, password: PASSWORD },
      });

      assert.equal(response.status, 200, response.text);

      return readSession(response);
    }

    function nextEmail(label) {
      emailCounter += 1;

      return `${label}-${emailCounter}@example.test`;
    }

    function startApi() {
      return startApiChild({
        HABI_AUTH_SPIKE: '1',
        HABI_P1_API: '1',
        HABI_SESSION_SPIKE_TEST_CLOCK: '1',
        DATABASE_URL: databaseUrl,
      });
    }

    /**
     * Waits until the row for a session is visible. Writes are behind the
     * synchronous session call, so the row can lag the response by a few
     * milliseconds; a caller that inspects storage must wait for it.
     */
    async function waitForStoredSession(sessionId) {
      const verifier = hashHex(sessionId);
      const deadline = Date.now() + STORE_VISIBLE_TIMEOUT_MS;

      while (Date.now() < deadline) {
        const result = await pool.query(
          'SELECT 1 FROM auth_sessions WHERE verifier_hash = $1',
          [verifier],
        );

        if (result.rowCount === 1) {
          return verifier;
        }

        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      throw new Error('the session was never written to auth_sessions');
    }

    async function sessionRow(verifier) {
      const result = await pool.query('SELECT * FROM auth_sessions WHERE verifier_hash = $1', [
        verifier,
      ]);

      assert.equal(result.rowCount, 1, 'the session row is missing');

      return result.rows[0];
    }

    before(async () => {
      containerName = `habi-session-durability-${randomBytes(6).toString('hex')}`;
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

      const port = Number.parseInt(published.stdout.trim().split(':').pop() ?? '', 10);
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
    });

    after(async () => {
      if (pool !== undefined) {
        await pool.query('DELETE FROM auth_sessions').catch(() => {});
        await pool.query('DELETE FROM invites').catch(() => {});
        await pool.query('DELETE FROM users').catch(() => {});
        await pool.end().catch(() => {});
      }

      if (containerName !== '') {
        await run('docker', ['rm', '-f', containerName], 30000);
      }
    });

    test('a session created in one process authenticates in a second process', async () => {
      // Process A mints the session and keeps running.
      const first = await startApi();
      let signedUp;

      try {
        signedUp = await signup(first.base, nextEmail('durable-cross-process'));

        const onFirst = await createClient(first.base, signedUp.session)('/api/bots');

        assert.equal(onFirst.status, 200, onFirst.text);

        // A separately booted process B hydrates from the same database. It
        // knows nothing about A's memory, so the row is the whole handoff.
        const second = await startApi();

        try {
          const onSecond = await createClient(second.base, signedUp.session)('/api/bots');

          assert.equal(
            onSecond.status,
            200,
            `a second process rejected a live session as ${onSecond.status}: ${onSecond.text}`,
          );
          assert.deepEqual(onSecond.body.bots, []);

          // A stays authoritative for itself while B agrees on the same row.
          const stillOnFirst = await createClient(first.base, signedUp.session)('/auth/me');

          assert.equal(stillOnFirst.status, 200, stillOnFirst.text);
          assert.equal(stillOnFirst.body.user.userId, signedUp.user.userId);
        } finally {
          await second.stop();
        }
      } finally {
        await first.stop();
      }

      // Restart survival: both earlier processes are gone, a third still knows
      // the session because the row, not the process, is the authority.
      const third = await startApi();

      try {
        const me = await createClient(third.base, signedUp.session)('/auth/me');

        assert.equal(me.status, 200, me.text);
        assert.equal(me.body.user.userId, signedUp.user.userId);
        assert.equal(me.body.user.email, signedUp.user.email);
      } finally {
        await third.stop();
      }
    });

    test('an idle-expired session is rejected after a restart, and slides before that', async () => {
      const first = await startApi();
      let signedUp;

      try {
        signedUp = await signup(first.base, nextEmail('durable-idle'));
      } finally {
        await first.stop();
      }

      const second = await startApi();

      try {
        const live = await createClient(second.base, signedUp.session)('/api/bots');

        assert.equal(live.status, 200, live.text);

        const expired = await createClient(second.base, signedUp.session)('/api/bots', {
          headers: { [TEST_CLOCK_HEADER]: String(IDLE_TTL_MS + 60 * 1000) },
        });

        assert.equal(expired.status, 401, expired.text);
        assert.deepEqual(expired.body, UNAUTHENTICATED);
      } finally {
        await second.stop();
      }

      // The graceful stop flushed the revocation write.
      const row = await sessionRow(hashHex(signedUp.session.sessionId));

      assert.equal(row.revoked_reason, 'idle_expired');
    });

    test('an absolutely expired session is rejected after a restart', async () => {
      const first = await startApi();
      let signedUp;

      try {
        signedUp = await signup(first.base, nextEmail('durable-absolute'));
      } finally {
        await first.stop();
      }

      const second = await startApi();

      try {
        const expired = await createClient(second.base, signedUp.session)('/api/bots', {
          headers: { [TEST_CLOCK_HEADER]: String(ABSOLUTE_TTL_MS + 60 * 1000) },
        });

        assert.equal(expired.status, 401, expired.text);
        assert.deepEqual(expired.body, UNAUTHENTICATED);
      } finally {
        await second.stop();
      }

      const row = await sessionRow(hashHex(signedUp.session.sessionId));

      assert.equal(row.revoked_reason, 'absolute_expired');
    });

    test('logout revokes durably for every session-aware surface', async () => {
      const first = await startApi();
      let signedUp;

      try {
        signedUp = await signup(first.base, nextEmail('durable-logout'));
        const logout = await createClient(first.base, signedUp.session)('/auth/logout', {
          method: 'POST',
          csrf: true,
        });

        assert.equal(logout.status, 200, logout.text);
        assert.deepEqual(logout.body, { ok: true });
      } finally {
        await first.stop();
      }

      const row = await sessionRow(hashHex(signedUp.session.sessionId));

      assert.equal(row.revoked_reason, 'logout');

      const second = await startApi();

      try {
        const bots = await createClient(second.base, signedUp.session)('/api/bots');
        const me = await createClient(second.base, signedUp.session)('/auth/me');

        assert.equal(bots.status, 401, bots.text);
        assert.deepEqual(bots.body, UNAUTHENTICATED);
        assert.equal(me.status, 401, me.text);
        assert.deepEqual(me.body, UNAUTHENTICATED);
      } finally {
        await second.stop();
      }
    });

    test('revokeAllForUser removes every live session and leaves another user alone', async () => {
      const first = await startApi();
      let ownerA;
      let ownerB;
      let sessionsA;
      let sessionsB;

      try {
        ownerA = await signup(first.base, nextEmail('durable-revoke-all-a'));
        sessionsA = [ownerA.session, await login(first.base, ownerA.user.email)];
        ownerB = await signup(first.base, nextEmail('durable-revoke-all-b'));
        sessionsB = [ownerB.session, await login(first.base, ownerB.user.email)];
      } finally {
        await first.stop();
      }

      const result = await runServiceTask(
        'result = { revoked: service.revokeAllForUser(process.env.TARGET_USER) };',
        { DATABASE_URL: databaseUrl, TARGET_USER: ownerA.user.userId },
      );

      assert.equal(result.revoked, 2);

      const revokedRows = await pool.query(
        `SELECT revoked_reason
           FROM auth_sessions
          WHERE owner_user_id = $1`,
        [ownerA.user.userId],
      );

      assert.equal(revokedRows.rowCount, 2);
      assert.deepEqual(
        revokedRows.rows.map((row) => row.revoked_reason),
        ['logout_all', 'logout_all'],
      );

      const second = await startApi();

      try {
        for (const session of sessionsA) {
          const response = await createClient(second.base, session)('/api/bots');

          assert.equal(response.status, 401, response.text);
          assert.deepEqual(response.body, UNAUTHENTICATED);
        }

        for (const session of sessionsB) {
          const response = await createClient(second.base, session)('/auth/me');

          assert.equal(response.status, 200, response.text);
          assert.equal(response.body.user.userId, ownerB.user.userId);
        }
      } finally {
        await second.stop();
      }
    });

    test('two users stay separate across a restart', async () => {
      const first = await startApi();
      let userA;
      let userB;

      try {
        userA = await signup(first.base, nextEmail('durable-two-users-a'));
        userB = await signup(first.base, nextEmail('durable-two-users-b'));
      } finally {
        await first.stop();
      }

      const second = await startApi();

      try {
        const meA = await createClient(second.base, userA.session)('/auth/me');
        const meB = await createClient(second.base, userB.session)('/auth/me');

        assert.equal(meA.status, 200, meA.text);
        assert.equal(meB.status, 200, meB.text);
        assert.equal(meA.body.user.userId, userA.user.userId);
        assert.equal(meB.body.user.userId, userB.user.userId);
        assert.notEqual(userA.user.userId, userB.user.userId);
      } finally {
        await second.stop();
      }

      const owners = await pool.query(
        `SELECT owner_user_id
           FROM auth_sessions
          WHERE verifier_hash = ANY($1::text[])`,
        [
          [hashHex(userA.session.sessionId), hashHex(userB.session.sessionId)],
        ],
      );

      assert.deepEqual(
        owners.rows.map((row) => row.owner_user_id).sort(),
        [userA.user.userId, userB.user.userId].sort(),
      );
    });

    test('a raw session secret or CSRF token is never present in the table', async () => {
      const api = await startApi();
      let signedUp;

      try {
        signedUp = await signup(api.base, nextEmail('durable-at-rest'));
      } finally {
        await api.stop();
      }

      const verifier = await waitForStoredSession(signedUp.session.sessionId);
      const row = await sessionRow(verifier);

      // Only the digests are stored, and they are the digests of the values
      // the client holds.
      assert.equal(row.verifier_hash, hashHex(signedUp.session.sessionId));
      assert.equal(row.csrf_hash, hashHex(signedUp.session.csrfToken));
      assert.match(row.verifier_hash, /^[0-9a-f]{64}$/);
      assert.match(row.csrf_hash, /^[0-9a-f]{64}$/);

      const leaked = await pool.query(
        `SELECT count(*)::int AS hits
           FROM auth_sessions t
          WHERE position($1 IN to_jsonb(t)::text) > 0
             OR position($2 IN to_jsonb(t)::text) > 0`,
        [signedUp.session.sessionId, signedUp.session.csrfToken],
      );

      assert.equal(leaked.rows[0].hits, 0, 'raw session or CSRF material reached the table');

      const byRawSecret = await pool.query(
        'SELECT count(*)::int AS hits FROM auth_sessions WHERE verifier_hash = $1',
        [signedUp.session.sessionId],
      );

      assert.equal(byRawSecret.rows[0].hits, 0);
    });

    test('a client CSRF token is still accepted after a restart', async () => {
      const first = await startApi();
      let signedUp;

      try {
        signedUp = await signup(first.base, nextEmail('durable-csrf'));
      } finally {
        await first.stop();
      }

      const second = await startApi();

      try {
        const client = createClient(second.base, signedUp.session);
        const accepted = await client(`/api/runs/${randomUUID()}/cancel`, {
          method: 'POST',
          csrf: true,
        });

        // The token passed both guards; ownership resolves the unknown Run 404.
        assert.equal(accepted.status, 404, accepted.text);
        assert.deepEqual(accepted.body, NOT_FOUND);

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
      } finally {
        await second.stop();
      }
    });

    test('the bounded sweep removes rows that can no longer authenticate', async () => {
      const now = Date.now();
      const retired = `retired-${randomUUID()}`;
      const expired = `expired-${randomUUID()}`;
      const owner = randomUUID();
      const liveSessionId = randomBytes(32).toString('base64url');

      await pool.query('INSERT INTO users (id) VALUES ($1)', [owner]);

      function insertRow({ id, verifier, createdAt, absoluteExpiresAt, revokedAt, reason }) {
        return pool.query(
          `INSERT INTO auth_sessions (
             id, session_family_id, verifier_hash, owner_user_id, created_at, last_seen_at,
             idle_expires_at, absolute_expires_at, rotated_from_id, revoked_at, revoked_reason,
             csrf_hash, user_agent_hash, ip_hash
           ) VALUES (
             $1::uuid, $2::uuid, $3, $4::uuid, $5::timestamptz, $5::timestamptz,
             $6::timestamptz, $6::timestamptz, NULL, $7::timestamptz, $8,
             $9, NULL, NULL
           )`,
          [
            id,
            randomUUID(),
            verifier,
            owner,
            new Date(createdAt),
            new Date(absoluteExpiresAt),
            revokedAt === null ? null : new Date(revokedAt),
            reason,
            hashHex(randomUUID()),
          ],
        );
      }

      await insertRow({
        id: randomUUID(),
        verifier: hashHex(liveSessionId),
        createdAt: now,
        absoluteExpiresAt: now + ABSOLUTE_TTL_MS,
        revokedAt: null,
        reason: null,
      });
      await insertRow({
        id: randomUUID(),
        verifier: hashHex(retired),
        createdAt: now - RETIRED_RETENTION_MS - 2 * 60 * 60 * 1000,
        absoluteExpiresAt: now - 60 * 60 * 1000,
        revokedAt: now - RETIRED_RETENTION_MS - 60 * 60 * 1000,
        reason: 'logout',
      });
      await insertRow({
        id: randomUUID(),
        verifier: hashHex(expired),
        createdAt: now - RETIRED_RETENTION_MS - 2 * 60 * 60 * 1000,
        absoluteExpiresAt: now - RETIRED_RETENTION_MS - 60 * 60 * 1000,
        revokedAt: null,
        reason: null,
      });

      // The explicit cleanup entry point, flushed before the row counts.
      await runServiceTask('result = { swept: service.sweepExpired() };', {
        DATABASE_URL: databaseUrl,
      });

      const remaining = await pool.query(
        `SELECT verifier_hash
           FROM auth_sessions
          WHERE verifier_hash = ANY($1::text[])`,
        [[hashHex(liveSessionId), hashHex(retired), hashHex(expired)]],
      );

      assert.deepEqual(
        remaining.rows.map((row) => row.verifier_hash),
        [hashHex(liveSessionId)],
      );

      // The surviving row is a real session: it still authenticates.
      const api = await startApi();

      try {
        const response = await createClient(api.base, {
          cookie: `habi_session=${liveSessionId}`,
        })('/api/bots');

        assert.equal(response.status, 200, response.text);
      } finally {
        await api.stop();
      }
    });

    test('the in-memory store keeps the contract the slice shipped with', async () => {
      const { SessionService, SESSION_IDLE_TTL_MS, SESSION_ABSOLUTE_TTL_MS, csrfTokenMatches } =
        await import('../dist/session/session.service.js');

      let clock = 1_000;
      const service = new SessionService({ now: () => clock });
      const issued = service.create('user-a');

      assert.match(issued.sessionId, /^[A-Za-z0-9_-]{43}$/);
      assert.notEqual(issued.csrfToken, issued.sessionId);
      assert.equal(service.validate(issued.sessionId).ok, true);
      assert.equal(csrfTokenMatches(issued.csrfToken, issued.csrfToken), true);
      assert.equal(csrfTokenMatches(issued.csrfToken, `${issued.csrfToken}x`), false);
      assert.equal(csrfTokenMatches(issued.csrfToken, undefined), false);

      clock = SESSION_IDLE_TTL_MS - 1;
      assert.equal(service.validate(issued.sessionId).ok, true);
      clock = SESSION_IDLE_TTL_MS + 19 * 60 * 1000;
      assert.equal(service.validate(issued.sessionId).ok, true);
      clock = SESSION_IDLE_TTL_MS + 50 * 60 * 1000;
      assert.equal(service.validate(issued.sessionId).ok, false);

      const rotatedAt = clock;
      clock = SESSION_ABSOLUTE_TTL_MS - 1;
      const survivor = service.create('user-b');
      const rotated = service.rotate(survivor.sessionId);

      assert.ok(rotated);
      assert.notEqual(rotated.sessionId, survivor.sessionId);
      assert.equal(rotated.record.absoluteExpiresAt, survivor.record.absoluteExpiresAt);
      assert.equal(service.validate(survivor.sessionId).ok, false);
      assert.equal(service.validate(rotated.sessionId).ok, false);

      clock = rotatedAt;
      const first = service.create('user-c');
      const second = service.create('user-c');

      assert.equal(service.listForUser('user-c').length, 2);
      assert.equal(service.revoke(first.sessionId), true);
      assert.equal(service.listForUser('user-c').length, 1);
      assert.equal(service.revokeAllForUser('user-c'), 1);
      assert.equal(service.validate(second.sessionId).ok, false);

      // The in-memory sweep drops records past the retention window only.
      const sweepService = new SessionService({ now: () => 0 });
      const retired = sweepService.create('user-d');

      sweepService.revoke(retired.sessionId);
      assert.equal(sweepService.sweepExpired(RETIRED_RETENTION_MS - 1), 0);
      assert.equal(sweepService.sweepExpired(RETIRED_RETENTION_MS), 1);
      assert.equal(sweepService.validate(retired.sessionId).ok, false);
    });
  },
);
