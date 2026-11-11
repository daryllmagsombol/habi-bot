/**
 * H-020 (#20) Run event JSON polling fallback smoke tests.
 *
 * Drives the same `GET /api/runs/:runId/events` route as the SSE suite, but
 * with `?after=<seq>&limit=<n>` (or `Accept: application/json`) so the
 * controller answers a bounded JSON page instead of opening a stream. The
 * page comes from the same owner-scoped `RunEventStore.read` the stream
 * replays from, so polling and SSE share ordering, cursor scope, ownership,
 * and terminal replay. The web fallback (`pollRunEvents` in
 * `apps/web/lib/api/browser.ts`) sends exactly this query and advances the
 * same exclusive cursor with `advancePollCursor`.
 *
 * Coverage:
 *   ordering      pages are strictly after the cursor, ascending by seq
 *   exclusivity   re-polling with the advanced cursor repeats nothing
 *   foreign       another account's Run is the same 404 as a guessed id
 *   cursor        malformed `after` is 400 after ownership is proven
 *   limit         absent limit defaults to 50, oversized clamps to 200
 *   terminal      a terminal page is full, stable, and replayable
 *   negotiate     plain JSON Accept polls; bare/SSE Accept stays a stream
 *
 * Boots the real Nest application in-process with `HABI_P1_API=1` against an
 * ephemeral PostgreSQL 18.6 container and the real migrations. Sessions are
 * minted through the H-017 `SessionService` (there is no product login route
 * in this slice). Docker unavailability skips the suite; the container is
 * removed afterwards. No provider, credential, queue, or model call is
 * involved.
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
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
const NOT_FOUND = { error: { code: 'not_found' } };

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

/** Minimal JSON reader: session cookie, no CSRF (this is a GET surface). */
function createClient(base, session) {
  return async function request(path, options = {}) {
    const response = await fetch(`${base}${path}`, {
      method: 'GET',
      headers: {
        cookie: `habi_session=${session.sessionId}`,
        accept: 'application/json',
        ...(options.headers ?? {}),
      },
      signal: AbortSignal.timeout(10000),
    });

    return {
      status: response.status,
      headers: response.headers,
      body: await readBody(response),
    };
  };
}

function expectError(body, code) {
  assert.deepEqual(body, { error: { code } });
}

/**
 * The client's cursor contract in one place: the next poll starts strictly
 * after the highest sequence seen, so a lagging cursor can never duplicate
 * visible output.
 */
function advanceCursor(page, cursor) {
  let next = cursor;

  for (const event of page.events) {
    if (event.seq > next) {
      next = event.seq;
    }
  }

  return next;
}

const dockerReady = dockerAvailable();

describe(
  'H-020 run event polling fallback',
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
    let userA;
    let userB;
    let threadA;
    let threadB;
    let runId;
    let runB;
    let foreignRun;

    async function seedUser() {
      const id = randomUUID();
      await pool.query('INSERT INTO users (id) VALUES ($1)', [id]);
      return id;
    }

    async function seedConversation(owner) {
      const botId = randomUUID();
      const conversationId = randomUUID();

      await pool.query(
        `INSERT INTO bots (id, owner_user_id, name)
         VALUES ($1, $2, 'Poll Bot')`,
        [botId, owner],
      );
      await pool.query(
        `INSERT INTO conversations (id, owner_user_id, bot_id, title)
         VALUES ($1, $2, $3, 'Poll Conversation')`,
        [conversationId, owner, botId],
      );

      return conversationId;
    }

    async function seedRun(owner, conversationId) {
      const id = randomUUID();

      await pool.query(
        `INSERT INTO runs (id, owner_user_id, conversation_id, status)
         VALUES ($1, $2, $3, 'running')`,
        [id, owner, conversationId],
      );

      return id;
    }

    async function poll(path, headers) {
      return requestA(path, headers === undefined ? {} : { headers });
    }

    before(async () => {
      containerName = `habi-h020-poll-${randomBytes(6).toString('hex')}`;
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
      assert.match(applied.stdout, /applied\s+0008_run_events\.sql/);

      userA = await seedUser();
      userB = await seedUser();
      threadA = await seedConversation(userA);
      threadB = await seedConversation(userB);

      runId = await seedRun(userA, threadA);
      runB = await seedRun(userB, threadB);
      foreignRun = await seedRun(userB, threadB);

      const { RunEventStore } = await import('../dist/events/index.js');
      const events = new RunEventStore(pool);

      await events.append(userA, {
        runId,
        type: 'run.created',
        payload: { dispatchState: 'dispatched' },
      });
      await events.append(userA, {
        runId,
        type: 'message.delta',
        payload: { text: 'Hel' },
      });
      await events.append(userA, {
        runId,
        type: 'message.delta',
        payload: { text: 'lo' },
      });
      await events.append(userA, {
        runId,
        type: 'run.completed',
        payload: { errorCode: null },
      });
      await events.append(userB, {
        runId: runB,
        type: 'run.created',
        payload: { dispatchState: 'dispatched' },
      });
      await events.append(userB, {
        runId: foreignRun,
        type: 'run.created',
        payload: { dispatchState: 'dispatched' },
      });

      process.env.NODE_ENV = 'test';
      process.env.HABI_P1_API = '1';
      process.env.DATABASE_URL = databaseUrl;

      const { AppModule } = await import('../dist/app.module.js');
      const { NestFactory } = await import('@nestjs/core');
      const { SessionService } = await import('../dist/session/session.service.js');

      const serverPort = await getFreePort();
      app = await NestFactory.create(AppModule, { logger: false });
      await app.listen(serverPort, '127.0.0.1');
      base = `http://127.0.0.1:${serverPort}`;

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

    test('a poll page is ordered strictly after the cursor', async () => {
      const first = await poll(`/api/runs/${runId}/events?after=0&limit=2`);

      assert.equal(first.status, 200);
      assert.equal(first.headers.get('cache-control'), 'no-store');
      assert.equal(first.body.runId, runId);
      assert.equal(first.body.afterSeq, 0);
      assert.deepEqual(
        first.body.events.map((event) => event.seq),
        [1, 2],
      );
      assert.deepEqual(
        first.body.events.map((event) => event.type),
        ['run.created', 'message.delta'],
      );
      assert.equal(first.body.hasMore, true);
      assert.equal(first.body.lastEventSeq, 4);
      assert.equal(first.body.terminalEventSeq, 4);

      const next = await poll(
        `/api/runs/${runId}/events?after=${advanceCursor(first.body, 0)}&limit=10`,
      );

      assert.equal(next.status, 200);
      assert.equal(next.body.afterSeq, 2);
      assert.deepEqual(
        next.body.events.map((event) => event.seq),
        [3, 4],
      );
      assert.equal(next.body.hasMore, false);

      // The cursor sits at the terminal sequence: the terminal is replayed,
      // not skipped, and a cursor past it answers not_found like the stream.
      const atTerminal = await poll(`/api/runs/${runId}/events?after=4`);

      assert.equal(atTerminal.status, 200);
      assert.deepEqual(atTerminal.body.events, []);
      assert.equal(atTerminal.body.hasMore, false);

      const beyond = await poll(`/api/runs/${runId}/events?after=99`);

      assert.equal(beyond.status, 404);
      assert.deepEqual(beyond.body, NOT_FOUND);
    });

    test('re-polling with the advanced cursor repeats nothing', async () => {
      const seen = new Set();
      let cursor = 0;
      const delivered = [];

      for (let round = 0; round < 4; round += 1) {
        const page = await poll(`/api/runs/${runId}/events?after=${cursor}&limit=1`);

        assert.equal(page.status, 200);

        for (const event of page.body.events) {
          assert.equal(seen.has(event.seq), false, `seq ${event.seq} repeated`);
          seen.add(event.seq);
          delivered.push(event.seq);
        }

        cursor = advanceCursor(page.body, cursor);

        if (page.body.hasMore === false) {
          break;
        }
      }

      assert.deepEqual(delivered, [1, 2, 3, 4]);

      const again = await poll(`/api/runs/${runId}/events?after=${cursor}`);

      assert.equal(again.status, 200);
      assert.deepEqual(again.body.events, []);
    });

    test('polling a foreign, unknown, or malformed Run is 404', async () => {
      const foreign = await requestB(`/api/runs/${runId}/events?after=0`);
      assert.equal(foreign.status, 404);
      assert.deepEqual(foreign.body, NOT_FOUND);

      const guessed = await poll(`/api/runs/${randomUUID()}/events?after=0`);
      assert.equal(guessed.status, 404);
      assert.deepEqual(guessed.body, NOT_FOUND);

      const malformed = await requestA('/api/runs/not-a-uuid/events?after=0');

      assert.equal(malformed.status, 404);
      assert.deepEqual(malformed.body, NOT_FOUND);

      // A checks the poll path of B's own Run through A's session: still 404.
      const crossOwner = await poll(`/api/runs/${foreignRun}/events?after=0`);
      assert.equal(crossOwner.status, 404);
      assert.deepEqual(crossOwner.body, NOT_FOUND);
    });

    test('a malformed cursor is 400 only after ownership is proven', async () => {
      const malformed = await poll(`/api/runs/${runId}/events?after=nope`);
      assert.equal(malformed.status, 400);
      expectError(malformed.body, 'invalid_cursor');

      const negative = await poll(`/api/runs/${runId}/events?after=-1`);
      assert.equal(negative.status, 400);
      expectError(negative.body, 'invalid_cursor');

      // Ownership is checked first: the same bad cursor on a foreign Run is
      // the non-enumerating 404, not a cursor hint.
      const foreignBad = await requestB(`/api/runs/${runId}/events?after=nope`);
      assert.equal(foreignBad.status, 404);
      assert.deepEqual(foreignBad.body, NOT_FOUND);

      const limitBad = await poll(`/api/runs/${runId}/events?after=0&limit=nope`);
      assert.equal(limitBad.status, 400);
      expectError(limitBad.body, 'invalid_input');

      const limitZero = await poll(`/api/runs/${runId}/events?after=0&limit=0`);
      assert.equal(limitZero.status, 400);
      expectError(limitZero.body, 'invalid_input');
    });

    test('the page bound defaults to 50 and clamps to 200', async () => {
      const eventsModule = await import('../dist/events/index.js');

      assert.equal(eventsModule.DEFAULT_POLL_LIMIT, 50);
      assert.equal(eventsModule.MAX_POLL_LIMIT, 200);
      assert.equal(eventsModule.normalizePollLimit(undefined), 50);
      assert.equal(eventsModule.normalizePollLimit(10), 10);
      assert.equal(eventsModule.normalizePollLimit(500), 200);

      const many = await seedRun(userA, threadA);

      for (let index = 0; index < 60; index += 1) {
        const { RunEventStore } = await import('../dist/events/index.js');
        const store = new RunEventStore(pool);

        await store.append(userA, {
          runId: many,
          type: 'message.delta',
          payload: { text: `chunk-${index}` },
        });
      }

      const implicit = await poll(`/api/runs/${many}/events?after=0`);

      assert.equal(implicit.status, 200);
      assert.equal(implicit.body.events.length, 50);
      assert.equal(implicit.body.hasMore, true);
      assert.deepEqual(
        implicit.body.events.map((event) => event.seq),
        Array.from({ length: 50 }, (_, index) => index + 1),
      );

      const clamped = await poll(`/api/runs/${many}/events?after=0&limit=500`);

      assert.equal(clamped.status, 200);
      assert.equal(clamped.body.events.length, 60);
      assert.equal(clamped.body.hasMore, false);
    });

    test('the terminal page is full, stable, and replayable', async () => {
      const first = await poll(`/api/runs/${runId}/events?after=0&limit=50`);

      assert.equal(first.status, 200);
      assert.deepEqual(
        first.body.events.map((event) => event.type).at(-1),
        'run.completed',
      );
      assert.equal(first.body.terminalEventSeq, 4);
      assert.equal(first.body.lastEventSeq, 4);

      // Replay from the start returns the identical page, terminal included.
      const replay = await poll(`/api/runs/${runId}/events?after=0&limit=50`);

      assert.equal(replay.status, 200);
      assert.deepEqual(replay.body, first.body);

      // Walking to the terminal leaves no remainder.
      const tail = await poll(`/api/runs/${runId}/events?after=3`);

      assert.equal(tail.status, 200);
      assert.deepEqual(
        tail.body.events.map((event) => event.seq),
        [4],
      );
      assert.equal(tail.body.events[0].type, 'run.completed');
      assert.equal(tail.body.hasMore, false);
    });

    test('a JSON Accept polls; a bare request stays on the stream', async () => {
      const raw = await fetch(`${base}/api/runs/${runId}/events`, {
        headers: { cookie: `habi_session=${sessionA.sessionId}` },
        signal: AbortSignal.timeout(10000),
      });

      assert.equal(raw.status, 200);
      assert.match(raw.headers.get('content-type') ?? '', /text\/event-stream/);
      await raw.text();

      const json = await poll(`/api/runs/${runId}/events?after=0&limit=1`);

      assert.equal(json.status, 200);
      assert.match(json.headers.get('content-type') ?? '', /application\/json/);
      assert.equal(json.body.events.length, 1);
      assert.equal(json.body.events[0].seq, 1);

      // Accept alone also names polling: no query, but an explicit JSON
      // preference answers the same page the query form would.
      const acceptOnly = await requestA(`/api/runs/${runId}/events`, {
        headers: { accept: 'application/json' },
      });

      assert.equal(acceptOnly.status, 200);
      assert.deepEqual(
        (acceptOnly.body.events ?? []).map((event) => event.seq),
        [1, 2, 3, 4],
      );
    });
  },
);
