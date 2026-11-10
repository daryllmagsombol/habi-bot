/**
 * H-018 (#18) chat HTTP composition surface smoke tests.
 *
 * Boots the real Nest application in-process with `HABI_P1_API=1` against an
 * ephemeral PostgreSQL 18.6 container and the real migrations. Sessions are
 * minted through the H-017 `SessionService` (there is no product login route in
 * this slice), then every route is driven over HTTP.
 *
 * Coverage:
 *   flag          unset flag means no `/api` routes (child process)
 *   auth          every route rejects no session with 401 unauthenticated
 *   isolation     two accounts, guessed ids, malformed ids, foreign cursors
 *   bots          keyset cursor, purpose fragment, counts, last activity, detail
 *   threads       owner + Bot scoped cursor page
 *   messages      ascending stable pages, before/after cents, read isolation
 *   post          message persistence, run reservation, idempotent replay,
 *                 CSRF, ignored body identity fields, archived conversation
 *   cancel        idempotent local cancel, terminal no-op, dispatched gap
 *   events        SSE replay order, Last-Event-ID/seq resumption, heartbeat,
 *                 terminal close, cross-run cursor
 *
 * Docker unavailability skips the Postgres suite; the container is removed
 * afterwards. No provider, credential, queue, or model call is involved.
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
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
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const READY_TIMEOUT_MS = 15000;
const EXIT_TIMEOUT_MS = 10000;
const UNAUTHENTICATED = { error: { code: 'unauthenticated' } };
const NOT_FOUND = { error: { code: 'not_found' } };
const CSRF_INVALID = { error: { code: 'csrf_invalid' } };

function dockerAvailable() {
  const result = spawnSync('docker', ['info'], {
    stdio: 'ignore',
    timeout: 5000,
  });

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

async function readBody(response) {
  const text = await response.text();

  if (text === '') {
    return undefined;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
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
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
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

    function onData() {
      check();
    }

    function onExit(code, signal) {
      cleanup();
      reject(
        new Error(
          `Process exited before ${eventName} (code=${code}, signal=${signal}).\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`,
        ),
      );
    }

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', onExit);
    check();
  });
}

function waitForExit(child, timeoutMs, label) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      reject(new Error(`${label} did not exit within ${timeoutMs}ms.`));
    }, timeoutMs);

    function onExit(code, signal) {
      clearTimeout(timer);
      resolve({ code, signal });
    }

    child.once('exit', onExit);
  });
}

async function forceStop(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  child.kill('SIGKILL');

  try {
    await waitForExit(child, 5000, 'Child process');
  } catch {
    // Already torn down.
  }
}

async function startChildApi(envOverrides = {}) {
  const port = await getFreePort();
  const env = {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    NODE_ENV: 'test',
  };

  // The parent environment must not decide which surfaces are enabled.
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

  Object.assign(env, envOverrides);

  const child = spawn(process.execPath, [ENTRY], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = captureOutput(child);

  try {
    await waitForEvent(child, 'api.ready', output, READY_TIMEOUT_MS);
  } catch (error) {
    await forceStop(child);
    throw error;
  }

  return {
    base: `http://127.0.0.1:${port}`,
    output,
    async stop() {
      child.kill('SIGTERM');

      try {
        await waitForExit(child, EXIT_TIMEOUT_MS, 'API');
      } catch {
        // Fall through to forceStop.
      }

      await forceStop(child);
    },
  };
}

/** Minimal in-memory browser: session cookie plus CSRF synchronizer token. */
function createClient(base, session) {
  return async function request(path, options = {}) {
    const headers = { ...(options.headers ?? {}), cookie: `habi_session=${session.sessionId}` };

    if (options.csrf === true) {
      headers['x-csrf-token'] = session.csrfToken;
    } else if (options.csrf === 'wrong') {
      headers['x-csrf-token'] = 'wrong-csrf-token';
    }

    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
    }

    const response = await fetch(`${base}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(5000),
    });

    return {
      status: response.status,
      headers: response.headers,
      body: await readBody(response),
    };
  };
}

function parseSseFrame(raw) {
  const frame = {};

  for (const line of raw.split('\n')) {
    if (line.startsWith(':')) {
      frame.comment = line.slice(1).trim();
      continue;
    }

    const separator = line.indexOf(':');

    if (separator === -1) {
      continue;
    }

    const field = line.slice(0, separator);
    const value = line.slice(separator + 1).replace(/^ /, '');

    if (field === 'id' || field === 'event') {
      frame[field] = value;
    } else if (field === 'data') {
      frame.data = value;
      try {
        frame.json = JSON.parse(value);
      } catch {
        // Keep raw data.
      }
    }
  }

  return frame;
}

/** Reads a finite SSE response to completion. */
async function readSse(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const frames = [];
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();

    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      if (raw.trim() !== '') {
        frames.push(parseSseFrame(raw));
      }
    }
  }

  return frames;
}

function eventFrames(frames) {
  return frames.filter((frame) => frame.event !== undefined);
}

function expectError(body, code) {
  assert.deepEqual(body, { error: { code } });
}

const dockerReady = dockerAvailable();

describe(
  'H-018 chat API',
  { skip: dockerReady ? false : 'Docker daemon is unavailable' },
  () => {
    let containerName = '';
    let password = '';
    let databaseUrl = '';
    let pool;
    let app;
    let base = '';
    let sessionA;
    let sessionB;
    let requestA;
    let requestB;
    let runEvents;
    let runOpen;
    let runOther;
    let runCompleted;
    let runDispatched;
    let runB;
    let botA1;
    let botA2;
    let botA3;
    let botB1;
    let threadA1;
    let threadA2;
    let threadA3;
    let threadArchived;
    let threadB1;
    let userA;
    let userB;
    let createdRunId;

    async function seedUser() {
      const id = randomUUID();
      await pool.query('INSERT INTO users (id) VALUES ($1)', [id]);
      return id;
    }

    async function seedBot(owner, { name, description = '', instructions = '', status = 'active' }) {
      const id = randomUUID();

      await pool.query(
        `INSERT INTO bots (
           id, owner_user_id, name, description, instructions_markdown, status, archived_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          id,
          owner,
          name,
          description,
          instructions,
          status,
          status === 'archived' ? new Date() : null,
        ],
      );

      return id;
    }

    async function seedConversation(owner, botId, title, status = 'active') {
      const id = randomUUID();

      await pool.query(
        `INSERT INTO conversations (id, owner_user_id, bot_id, title, status, deleted_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, owner, botId, title, status, status === 'deleted' ? new Date() : null],
      );

      return id;
    }

    async function seedRun(owner, conversationId, status = 'queued', dispatchState = 'not_dispatched') {
      const id = randomUUID();

      await pool.query(
        `INSERT INTO runs (
           id, owner_user_id, conversation_id, status, dispatch_state, finished_at
         )
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          id,
          owner,
          conversationId,
          status,
          dispatchState,
          status === 'completed' ? new Date() : null,
        ],
      );

      return id;
    }

    async function ageBot(botId, minutesAgo) {
      await pool.query(
        `UPDATE bots SET updated_at = now() - ($2::int * interval '1 minute') WHERE id = $1`,
        [botId, minutesAgo],
      );
    }

    async function ageConversation(conversationId, minutesAgo) {
      await pool.query(
        `UPDATE conversations SET updated_at = now() - ($2::int * interval '1 minute') WHERE id = $1`,
        [conversationId, minutesAgo],
      );
    }

    before(async () => {
      containerName = `habi-h018-${randomBytes(6).toString('hex')}`;
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

      const port = Number.parseInt(portResult.stdout.trim().split(':').pop() ?? '', 10);
      assert.ok(Number.isInteger(port) && port > 0, 'Docker did not publish PostgreSQL');

      pool = new Pool({
        host: '127.0.0.1',
        port,
        user: DOCKER_USER,
        password,
        database: DOCKER_DATABASE,
        max: 12,
      });

      await waitForDatabase(pool, containerName);
      databaseUrl = `postgres://${DOCKER_USER}:${password}@127.0.0.1:${port}/${DOCKER_DATABASE}`;

      const applied = migrate(databaseUrl);
      assert.equal(applied.status, 0, applied.stderr);
      assert.match(applied.stdout, /applied\s+0001_conversations\.sql/);
      assert.match(applied.stdout, /applied\s+0014_skills\.sql/);

      // Seed two accounts and their independent data.
      userA = await seedUser();
      userB = await seedUser();

      botA1 = await seedBot(userA, {
        name: 'Alpha',
        description: 'Researches things quickly.',
        instructions: '# Alpha rules\n\n- Be brief',
      });
      botA2 = await seedBot(userA, {
        name: 'Beta',
        instructions: 'Beta first line\nsecond line',
      });
      botA3 = await seedBot(userA, {
        name: 'Gamma',
        description: 'Archived helper.',
        status: 'archived',
      });
      botB1 = await seedBot(userB, { name: 'B Only', description: 'Belongs to B.' });

      threadA1 = await seedConversation(userA, botA1, 'Alpha one');
      threadA2 = await seedConversation(userA, botA1, 'Alpha two');
      threadA3 = await seedConversation(userA, botA2, 'Beta one');
      threadArchived = await seedConversation(
        userA,
        botA2,
        'Archived thread',
        'archived',
      );
      threadB1 = await seedConversation(userB, botB1, 'B thread');

      // Stable list ordering independent of seed timing.
      await ageBot(botA1, 1);
      await ageBot(botA2, 2);
      await ageBot(botA3, 3);
      await ageBot(botB1, 4);

      const { MessageRepository } = await import('../dist/persistence/index.js');
      const messages = new MessageRepository(pool);

      await messages.append(userA, {
        conversationId: threadA1,
        role: 'user',
        content: 'First question',
        clientMessageId: 'seed-1',
      });
      await messages.append(userA, {
        conversationId: threadA1,
        role: 'assistant',
        content: 'First answer',
        clientMessageId: 'seed-2',
      });
      await messages.append(userA, {
        conversationId: threadA1,
        role: 'user',
        content: 'Second question',
        clientMessageId: 'seed-3',
      });

      await ageConversation(threadA1, 1);
      await ageConversation(threadA3, 2);
      await ageConversation(threadA2, 3);
      await ageConversation(threadArchived, 4);
      await ageConversation(threadB1, 5);

      runEvents = await seedRun(userA, threadA1);
      runOpen = await seedRun(userA, threadA1);
      runOther = await seedRun(userA, threadA1);
      runCompleted = await seedRun(userA, threadA1, 'completed', 'dispatched');
      runDispatched = await seedRun(userA, threadA1, 'running', 'dispatched');
      runB = await seedRun(userB, threadB1);

      const { RunEventStore } = await import('../dist/events/index.js');
      const events = new RunEventStore(pool);

      await events.append(userA, {
        runId: runEvents,
        type: 'run.created',
        payload: { dispatchState: 'not_dispatched' },
      });
      await events.append(userA, {
        runId: runEvents,
        type: 'message.delta',
        payload: { text: 'Hel' },
      });
      await events.append(userA, {
        runId: runEvents,
        type: 'run.completed',
        payload: { errorCode: null },
      });

      await events.append(userA, {
        runId: runOpen,
        type: 'run.created',
        payload: { dispatchState: 'not_dispatched' },
      });
      await events.append(userA, {
        runId: runOther,
        type: 'run.created',
        payload: { dispatchState: 'not_dispatched' },
      });
      await events.append(userB, {
        runId: runB,
        type: 'run.created',
        payload: { dispatchState: 'not_dispatched' },
      });
      await events.append(userB, {
        runId: runB,
        type: 'run.completed',
        payload: { errorCode: null },
      });

      // Boot the real application in-process with the flag on.
      process.env.NODE_ENV = 'test';
      process.env.HABI_P1_API = '1';
      process.env.HABI_P1_API_SSE_HEARTBEAT_MS = '300';
      process.env.DATABASE_URL = databaseUrl;

      const { AppModule } = await import('../dist/app.module.js');
      const { NestFactory } = await import('@nestjs/core');
      const { SessionService } = await import('../dist/session/session.service.js');

      app = await NestFactory.create(AppModule, { logger: false });
      await app.listen(0, '127.0.0.1');

      const address = app.getHttpServer().address();
      assert.ok(
        address !== null && typeof address === 'object',
        'API did not bind a TCP port',
      );
      base = `http://127.0.0.1:${address.port}`;

      const sessions = app.get(SessionService);
      sessionA = sessions.create(userA);
      sessionB = sessions.create(userB);
      requestA = createClient(base, sessionA);
      requestB = createClient(base, sessionB);
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
        await pool.query('DELETE FROM users').catch(() => {});
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
        assert.notEqual(
          inspect.status,
          0,
          'temporary PostgreSQL container was not removed',
        );
      }
    });

    test('every route rejects a request with no session as 401', async () => {
      const routes = [
        ['GET', '/api/bots'],
        ['GET', `/api/bots/${botA1}`],
        ['GET', `/api/bots/${botA1}/threads`],
        ['GET', `/api/threads/${threadA1}/messages`],
        ['POST', `/api/threads/${threadA1}/messages`],
        ['GET', `/api/runs/${runEvents}/events`],
        ['POST', `/api/runs/${runEvents}/cancel`],
      ];

      for (const [method, path] of routes) {
        const response = await fetch(`${base}${path}`, {
          method,
          headers: method === 'POST' ? { 'content-type': 'application/json' } : {},
          body: method === 'POST' ? '{}' : undefined,
        });

        assert.equal(response.status, 401, `${method} ${path}`);
        assert.deepEqual(await readBody(response), UNAUTHENTICATED);
      }
    });

    test('bots list is owner scoped, paginated, and projected for the chooser', async () => {
      const first = await requestA('/api/bots');

      assert.equal(first.status, 200);
      assert.equal(first.body.bots.length, 3);
      assert.deepEqual(
        first.body.bots.map((bot) => bot.name),
        ['Alpha', 'Beta', 'Gamma'],
      );
      assert.equal(first.body.nextCursor, null);

      const alpha = first.body.bots[0];
      assert.match(alpha.id, UUID_PATTERN);
      assert.equal(alpha.purpose, 'Researches things quickly.');
      assert.equal(alpha.status, 'active');
      assert.equal(alpha.conversationCount, 2);
      assert.ok(!Number.isNaN(Date.parse(alpha.lastActivityAt)));
      assert.equal('instructionsMarkdown' in alpha, false);
      assert.equal('description' in alpha, false);

      const beta = first.body.bots[1];
      assert.equal(beta.purpose, 'Beta first line');
      assert.equal(beta.conversationCount, 2);

      const gamma = first.body.bots[2];
      assert.equal(gamma.status, 'archived');
      assert.equal(gamma.conversationCount, 0);

      const pageOne = await requestA('/api/bots?limit=2');
      assert.equal(pageOne.status, 200);
      assert.equal(pageOne.body.bots.length, 2);
      assert.equal(typeof pageOne.body.nextCursor, 'string');

      const pageTwo = await requestA(
        `/api/bots?limit=2&cursor=${encodeURIComponent(pageOne.body.nextCursor)}`,
      );
      assert.equal(pageTwo.status, 200);
      assert.equal(pageTwo.body.bots.length, 1);
      assert.equal(pageTwo.body.nextCursor, null);

      const seen = new Set([
        ...pageOne.body.bots.map((bot) => bot.id),
        ...pageTwo.body.bots.map((bot) => bot.id),
      ]);
      assert.equal(seen.size, 3);

      const active = await requestA('/api/bots?status=active');
      assert.equal(active.body.bots.length, 2);
      const archived = await requestA('/api/bots?status=archived');
      assert.equal(archived.body.bots.length, 1);

      const badLimit = await requestA('/api/bots?limit=0');
      assert.equal(badLimit.status, 400);
      expectError(badLimit.body, 'invalid_input');

      const badCursor = await requestA('/api/bots?cursor=not-a-cursor');
      assert.equal(badCursor.status, 400);
      expectError(badCursor.body, 'invalid_cursor');
    });

    test('Bot detail includes instruction text as untrusted data', async () => {
      const response = await requestA(`/api/bots/${botA1}`);

      assert.equal(response.status, 200);
      assert.equal(response.body.bot.id, botA1);
      assert.equal(response.body.bot.instructionsMarkdown, '# Alpha rules\n\n- Be brief');
      assert.equal(response.body.purpose, 'Researches things quickly.');
      assert.equal(response.body.conversationCount, 2);

      const archived = await requestA(`/api/bots/${botA3}`);
      assert.equal(archived.status, 200);
      assert.equal(archived.body.bot.status, 'archived');
      assert.equal(typeof archived.body.bot.archivedAt, 'string');
    });

    test('threads are owner and Bot scoped with a keyset cursor', async () => {
      const response = await requestA(`/api/bots/${botA1}/threads`);

      assert.equal(response.status, 200);
      assert.deepEqual(
        response.body.threads.map((thread) => thread.id),
        [threadA1, threadA2],
      );
      assert.equal(response.body.nextCursor, null);

      const pageOne = await requestA(`/api/bots/${botA1}/threads?limit=1`);
      assert.equal(pageOne.body.threads.length, 1);
      assert.equal(pageOne.body.threads[0].id, threadA1);
      assert.equal(typeof pageOne.body.nextCursor, 'string');

      const pageTwo = await requestA(
        `/api/bots/${botA1}/threads?limit=1&cursor=${encodeURIComponent(pageOne.body.nextCursor)}`,
      );
      assert.equal(pageTwo.body.threads.length, 1);
      assert.equal(pageTwo.body.threads[0].id, threadA2);
      assert.equal(pageTwo.body.nextCursor, null);

      const beta = await requestA(`/api/bots/${botA2}/threads`);
      assert.deepEqual(
        beta.body.threads.map((thread) => thread.id),
        [threadA3, threadArchived],
      );

      const badCursor = await requestA(`/api/bots/${botA1}/threads?cursor=nope`);
      assert.equal(badCursor.status, 400);
      expectError(badCursor.body, 'invalid_cursor');
    });

    test('messages are ascending, stable, and cursor paginated', async () => {
      const response = await requestA(`/api/threads/${threadA1}/messages`);

      assert.equal(response.status, 200);
      assert.deepEqual(
        response.body.messages.map((message) => message.seq),
        [1, 2, 3],
      );
      assert.deepEqual(
        response.body.messages.map((message) => message.role),
        ['user', 'assistant', 'user'],
      );
      assert.equal(response.body.hasMoreAfter, false);
      assert.equal(response.body.hasMoreBefore, false);

      const firstPage = await requestA(`/api/threads/${threadA1}/messages?limit=2`);
      assert.deepEqual(
        firstPage.body.messages.map((message) => message.seq),
        [1, 2],
      );
      assert.equal(firstPage.body.hasMoreAfter, true);
      assert.equal(typeof firstPage.body.afterCursor, 'string');

      const nextPage = await requestA(
        `/api/threads/${threadA1}/messages?after=${encodeURIComponent(firstPage.body.afterCursor)}`,
      );
      assert.deepEqual(
        nextPage.body.messages.map((message) => message.seq),
        [3],
      );
      assert.equal(nextPage.body.hasMoreAfter, false);

      const beforePage = await requestA(
        `/api/threads/${threadA1}/messages?limit=2&before=${encodeURIComponent(nextPage.body.beforeCursor)}`,
      );
      assert.deepEqual(
        beforePage.body.messages.map((message) => message.seq),
        [1, 2],
      );

      const both = await requestA(
        `/api/threads/${threadA1}/messages?before=${encodeURIComponent(firstPage.body.beforeCursor)}&after=${encodeURIComponent(firstPage.body.afterCursor)}`,
      );
      assert.equal(both.status, 400);
      expectError(both.body, 'invalid_input');

      const badCursor = await requestA(`/api/threads/${threadA1}/messages?after=nope`);
      assert.equal(badCursor.status, 400);
      expectError(badCursor.body, 'invalid_cursor');
    });

    test('posting a message persists it and reserves exactly one queued Run', async () => {
      const payload = {
        content: 'What is the weather?',
        clientMessageId: 'client-1',
        // These are deliberately ignored: the actor comes from the session and
        // the role is always the owner's user message.
        ownerUserId: userB,
        role: 'assistant',
        runId: runEvents,
      };

      const first = await requestA(`/api/threads/${threadA2}/messages`, {
        method: 'POST',
        csrf: true,
        body: payload,
      });

      assert.equal(first.status, 201);
      assert.equal(first.body.message.content, 'What is the weather?');
      assert.equal(first.body.message.role, 'user');
      assert.equal(first.body.message.conversationId, threadA2);
      assert.equal(first.body.message.clientMessageId, 'client-1');
      assert.equal(first.body.message.seq, 1);
      assert.equal(first.body.run.status, 'queued');
      assert.equal(first.body.run.dispatchState, 'not_dispatched');
      assert.equal(first.body.run.conversationId, threadA2);
      assert.match(first.body.run.id, UUID_PATTERN);
      assert.equal(first.body.runId, first.body.run.id);

      createdRunId = first.body.run.id;

      const storedMessage = await pool.query(
        'SELECT owner_user_id, role, content FROM messages WHERE id = $1',
        [first.body.message.id],
      );
      assert.equal(storedMessage.rows[0].owner_user_id, userA);
      assert.equal(storedMessage.rows[0].role, 'user');
      assert.equal(storedMessage.rows[0].content, 'What is the weather?');

      const storedRun = await pool.query(
        'SELECT owner_user_id, status, dispatch_state, idempotency_key FROM runs WHERE id = $1',
        [createdRunId],
      );
      assert.equal(storedRun.rows[0].owner_user_id, userA);
      assert.equal(storedRun.rows[0].status, 'queued');
      assert.equal(storedRun.rows[0].dispatch_state, 'not_dispatched');
      assert.equal(
        storedRun.rows[0].idempotency_key,
        `api-message:${first.body.message.id}`,
      );

      const replay = await requestA(`/api/threads/${threadA2}/messages`, {
        method: 'POST',
        csrf: true,
        body: payload,
      });

      assert.equal(replay.status, 201);
      assert.equal(replay.body.message.id, first.body.message.id);
      assert.equal(replay.body.run.id, first.body.run.id);

      const counts = await pool.query(
        `SELECT
           (SELECT count(*)::int FROM messages WHERE conversation_id = $1) AS messages,
           (SELECT count(*)::int FROM runs WHERE conversation_id = $1) AS runs`,
        [threadA2],
      );
      assert.equal(counts.rows[0].messages, 1);
      assert.equal(counts.rows[0].runs, 1);

      const conflict = await requestA(`/api/threads/${threadA2}/messages`, {
        method: 'POST',
        csrf: true,
        body: { content: 'Different text', clientMessageId: 'client-1' },
      });
      assert.equal(conflict.status, 409);
      expectError(conflict.body, 'message_idempotency_conflict');

      const empty = await requestA(`/api/threads/${threadA2}/messages`, {
        method: 'POST',
        csrf: true,
        body: { content: '' },
      });
      assert.equal(empty.status, 400);
      expectError(empty.body, 'invalid_input');

      const noCsrf = await requestA(`/api/threads/${threadA2}/messages`, {
        method: 'POST',
        body: { content: 'No token' },
      });
      assert.equal(noCsrf.status, 403);
      assert.deepEqual(noCsrf.body, CSRF_INVALID);

      const wrongCsrf = await requestA(`/api/threads/${threadA2}/messages`, {
        method: 'POST',
        csrf: 'wrong',
        body: { content: 'Wrong token' },
      });
      assert.equal(wrongCsrf.status, 403);
      assert.deepEqual(wrongCsrf.body, CSRF_INVALID);

      const archivedThread = await requestA(
        `/api/threads/${threadArchived}/messages`,
        { method: 'POST', csrf: true, body: { content: 'Too late' } },
      );
      assert.equal(archivedThread.status, 409);
      expectError(archivedThread.body, 'conversation_archived');
    });

    test('cancel is owner scoped and idempotent without inventing a provider stop', async () => {
      const first = await requestA(`/api/runs/${createdRunId}/cancel`, {
        method: 'POST',
        csrf: true,
      });

      assert.equal(first.status, 200);
      assert.equal(first.body.run.id, createdRunId);
      assert.equal(first.body.run.status, 'cancelled');
      assert.equal(typeof first.body.run.finishedAt, 'string');

      const second = await requestA(`/api/runs/${createdRunId}/cancel`, {
        method: 'POST',
        csrf: true,
      });

      assert.equal(second.status, 200);
      assert.equal(second.body.run.status, 'cancelled');
      assert.equal(second.body.run.finishedAt, first.body.run.finishedAt);

      const stored = await pool.query('SELECT status FROM runs WHERE id = $1', [
        createdRunId,
      ]);
      assert.equal(stored.rows[0].status, 'cancelled');

      // A terminal Run is returned unchanged, never rewritten.
      const completed = await requestA(`/api/runs/${runCompleted}/cancel`, {
        method: 'POST',
        csrf: true,
      });
      assert.equal(completed.status, 200);
      assert.equal(completed.body.run.status, 'completed');

      // A dispatched Run must not be reported stopped by the API process: it
      // records a durable intent and returns the current state. The owning
      // worker performs the adapter call (covered by the worker suite).
      const dispatched = await requestA(`/api/runs/${runDispatched}/cancel`, {
        method: 'POST',
        csrf: true,
      });
      assert.equal(dispatched.status, 200);
      assert.equal(dispatched.body.run.status, 'running');
      assert.equal(typeof dispatched.body.run.cancelRequestedAt, 'string');
      assert.equal(dispatched.body.run.cancelErrorCode, null);

      const stillRunning = await pool.query(
        `SELECT status, cancel_requested_at, cancel_reason, cancel_attempts
           FROM runs WHERE id = $1`,
        [runDispatched],
      );
      assert.equal(stillRunning.rows[0].status, 'running');
      assert.equal(stillRunning.rows[0].cancel_reason, 'user');
      assert.ok(stillRunning.rows[0].cancel_requested_at instanceof Date);
      assert.equal(stillRunning.rows[0].cancel_attempts, 0);

      // Repeating the request is the same outcome: no second adapter attempt is
      // ever authorised by a duplicate HTTP call, and the original request time
      // is preserved.
      const repeated = await requestA(`/api/runs/${runDispatched}/cancel`, {
        method: 'POST',
        csrf: true,
      });
      assert.equal(repeated.status, 200);
      assert.equal(repeated.body.run.status, 'running');
      assert.equal(
        repeated.body.run.cancelRequestedAt,
        dispatched.body.run.cancelRequestedAt,
      );

      const stillOneIntent = await pool.query(
        'SELECT cancel_attempts FROM runs WHERE id = $1',
        [runDispatched],
      );
      assert.equal(stillOneIntent.rows[0].cancel_attempts, 0);

      const noCsrf = await requestA(`/api/runs/${runDispatched}/cancel`, {
        method: 'POST',
      });
      assert.equal(noCsrf.status, 403);
      assert.deepEqual(noCsrf.body, CSRF_INVALID);
    });

    test('SSE stream frames, resumption, heartbeat, and terminal close', async () => {
      const open = await fetch(`${base}/api/runs/${runEvents}/events`, {
        headers: { cookie: `habi_session=${sessionA.sessionId}` },
        signal: AbortSignal.timeout(10000),
      });

      assert.equal(open.status, 200);
      assert.match(open.headers.get('content-type') ?? '', /^text\/event-stream/);

      const frames = await readSse(open);
      const events = eventFrames(frames);

      assert.deepEqual(
        events.map((frame) => frame.json.seq),
        [1, 2, 3],
      );
      assert.deepEqual(
        events.map((frame) => frame.event),
        ['run.created', 'message.delta', 'run.completed'],
      );
      assert.equal(events[0].json.runId, runEvents);
      assert.match(events[0].id, /^e1\./);

      // Resume after the first event using the standard reconnect header.
      const resumed = await fetch(`${base}/api/runs/${runEvents}/events`, {
        headers: {
          cookie: `habi_session=${sessionA.sessionId}`,
          'last-event-id': events[0].id,
        },
        signal: AbortSignal.timeout(10000),
      });

      assert.equal(resumed.status, 200);
      assert.deepEqual(
        eventFrames(await readSse(resumed)).map((frame) => frame.json.seq),
        [2, 3],
      );

      // The `seq` query parameter is the alternate resume hint.
      const bySeq = await fetch(`${base}/api/runs/${runEvents}/events?seq=2`, {
        headers: { cookie: `habi_session=${sessionA.sessionId}` },
        signal: AbortSignal.timeout(10000),
      });
      assert.equal(bySeq.status, 200);
      assert.deepEqual(
        eventFrames(await readSse(bySeq)).map((frame) => frame.json.seq),
        [3],
      );

      // A cursor at the terminal event yields an empty, immediately closed stream.
      const atTerminal = await fetch(`${base}/api/runs/${runEvents}/events`, {
        headers: {
          cookie: `habi_session=${sessionA.sessionId}`,
          'last-event-id': events[2].id,
        },
        signal: AbortSignal.timeout(10000),
      });
      assert.equal(atTerminal.status, 200);
      assert.deepEqual(eventFrames(await readSse(atTerminal)), []);

      // Heartbeat: an open, non-terminal Run receives comment frames.
      const controller = new AbortController();
      const live = await fetch(`${base}/api/runs/${runOpen}/events`, {
        headers: { cookie: `habi_session=${sessionA.sessionId}` },
        signal: controller.signal,
      });
      assert.equal(live.status, 200);

      const reader = live.body.getReader();
      const decoder = new TextDecoder();
      let text = '';
      const deadline = Date.now() + 4000;

      while (!text.includes(': keep-alive') && Date.now() < deadline) {
        const { value, done } = await reader.read();

        if (done) {
          break;
        }

        text += decoder.decode(value, { stream: true });
      }

      controller.abort();
      assert.match(text, /: keep-alive/);
      assert.match(text, /event: run\.created/);
    });

    test('two accounts are isolated on every route, including guessed ids', async () => {
      const otherBots = await requestB('/api/bots');
      assert.equal(otherBots.status, 200);
      assert.deepEqual(
        otherBots.body.bots.map((bot) => bot.name),
        ['B Only'],
      );

      const ownBot = await requestB(`/api/bots/${botB1}`);
      assert.equal(ownBot.status, 200);

      const ownThreads = await requestB(`/api/bots/${botB1}/threads`);
      assert.equal(ownThreads.status, 200);
      assert.deepEqual(
        ownThreads.body.threads.map((thread) => thread.id),
        [threadB1],
      );

      const ownMessages = await requestB(`/api/threads/${threadB1}/messages`);
      assert.equal(ownMessages.status, 200);

      const ownEvents = await fetch(`${base}/api/runs/${runB}/events`, {
        headers: { cookie: `habi_session=${sessionB.sessionId}` },
        signal: AbortSignal.timeout(10000),
      });
      assert.equal(ownEvents.status, 200);
      assert.deepEqual(
        eventFrames(await readSse(ownEvents)).map((frame) => frame.json.seq),
        [1, 2],
      );

      const guessed = randomUUID();
      const foreign = [
        ['GET', `/api/bots/${botA1}`],
        ['GET', `/api/bots/${guessed}`],
        ['GET', `/api/bots/not-a-uuid`],
        ['GET', `/api/bots/${botA1}/threads`],
        ['GET', `/api/bots/${guessed}/threads`],
        ['GET', `/api/threads/${threadA1}/messages`],
        ['GET', `/api/threads/${guessed}/messages`],
        ['GET', `/api/threads/not-a-uuid/messages`],
        ['GET', `/api/runs/${runEvents}/events`],
        ['GET', `/api/runs/${guessed}/events`],
        ['GET', `/api/runs/not-a-uuid/events`],
        ['POST', `/api/threads/${threadA1}/messages`],
        ['POST', `/api/threads/${guessed}/messages`],
        ['POST', `/api/runs/${runEvents}/cancel`],
        ['POST', `/api/runs/${guessed}/cancel`],
        ['POST', `/api/runs/not-a-uuid/cancel`],
      ];

      for (const [method, path] of foreign) {
        const response = await requestB(path, {
          method,
          csrf: method === 'POST',
          body: method === 'POST' ? { content: 'Should not persist' } : undefined,
        });

        assert.equal(response.status, 404, `${method} ${path}`);
        assert.deepEqual(response.body, NOT_FOUND, `${method} ${path}`);
      }

      // A Run-bound cursor from another Run is also not found.
      const first = await fetch(`${base}/api/runs/${runEvents}/events`, {
        headers: {
          cookie: `habi_session=${sessionA.sessionId}`,
          'last-event-id': 'e1.AAAAAAAAAAAAAAA',
        },
        signal: AbortSignal.timeout(10000),
      });
      assert.equal(first.status, 400);
      expectError(await readBody(first), 'invalid_cursor');

      const cursorForOtherRun = `e1.${Buffer.from(`1:${runOther}`, 'utf8').toString('base64url')}`;

      const crossRun = await fetch(`${base}/api/runs/${runEvents}/events`, {
        headers: {
          cookie: `habi_session=${sessionA.sessionId}`,
          'last-event-id': cursorForOtherRun,
        },
        signal: AbortSignal.timeout(10000),
      });
      assert.equal(crossRun.status, 404);
      expectError(await readBody(crossRun), 'not_found');

      const beyond = await fetch(`${base}/api/runs/${runEvents}/events?seq=999`, {
        headers: { cookie: `habi_session=${sessionA.sessionId}` },
        signal: AbortSignal.timeout(10000),
      });
      assert.equal(beyond.status, 404);
      expectError(await readBody(beyond), 'not_found');

      const badSeq = await fetch(`${base}/api/runs/${runEvents}/events?seq=nope`, {
        headers: { cookie: `habi_session=${sessionA.sessionId}` },
        signal: AbortSignal.timeout(10000),
      });
      assert.equal(badSeq.status, 400);
      expectError(await readBody(badSeq), 'invalid_cursor');
    });

    test('a missing database is reported by the runtime as api_unavailable', async () => {
      const { ApiRuntime } = await import('../dist/api/api-runtime.js');
      const previous = process.env.DATABASE_URL;
      delete process.env.DATABASE_URL;

      try {
        const runtime = new ApiRuntime();
        assert.throws(
          () => runtime.getService(),
          (error) => {
            assert.equal(error.code, 'api_unavailable');
            assert.equal(error.status, 503);
            return true;
          },
        );
      } finally {
        if (previous !== undefined) {
          process.env.DATABASE_URL = previous;
        }
      }
    });
  },
);

describe('H-018 chat API flag gate', () => {
  test('HABI_P1_API unset registers no /api routes', async () => {
    const server = await startChildApi();

    try {
      const health = await fetch(`${server.base}/health`);
      assert.equal(health.status, 200);

      const routes = [
        ['GET', '/api/bots'],
        ['GET', `/api/bots/${randomUUID()}`],
        ['GET', `/api/bots/${randomUUID()}/threads`],
        ['GET', `/api/threads/${randomUUID()}/messages`],
        ['POST', `/api/threads/${randomUUID()}/messages`],
        ['GET', `/api/runs/${randomUUID()}/events`],
        ['POST', `/api/runs/${randomUUID()}/cancel`],
      ];

      for (const [method, path] of routes) {
        const response = await fetch(`${server.base}${path}`, {
          method,
          headers: method === 'POST' ? { 'content-type': 'application/json' } : {},
          body: method === 'POST' ? '{}' : undefined,
        });

        // If the route existed, the session guard would answer 401. A 404
        // proves the module was not imported.
        assert.equal(response.status, 404, `${method} ${path}`);
      }
    } finally {
      await server.stop();
    }
  });
});
