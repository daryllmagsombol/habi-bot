/**
 * End-to-end Run pipeline smoke tests: POST -> allowance reservation -> worker
 * dispatch -> events -> settle.
 *
 * Boots the real Nest application in-process with `HABI_P1_API=1` against an
 * ephemeral PostgreSQL 18.6 container and the real migrations, then drives the
 * worker claim loop with a stub `HarnessAdapter`. There is no provider call,
 * credential, or network dependency beyond loopback. Docker unavailability
 * skips the suite.
 *
 * Coverage:
 *   happy path        POST, one dispatch, ordered replay, settled allowance
 *   exhaustion        admission refuses before any Run is claimable and
 *                     charges nothing
 *   retry             the same client idempotency key charges once
 *   race              two workers dispatch one Run exactly once
 *   scoped recovery   a fresh reservation stays claimable
 *   unscoped recovery the documented full sweep still terminalizes without a
 *                     provider call
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
const DEFAULT_TIMEOUT_MS = 20_000;
const RUN_ALLOWANCE_ESTIMATE_TOKENS = 10_000;

function dockerAvailable() {
  return (
    spawnSync('docker', ['info'], { stdio: 'ignore', timeout: 5000 }).status === 0
  );
}

function migrate(databaseUrl) {
  return spawnSync(
    process.execPath,
    [MIGRATE_SCRIPT, '--database-url', databaseUrl],
    { cwd: REPOSITORY_ROOT, encoding: 'utf8', timeout: 60000 },
  );
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
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
    `PostgreSQL did not become ready: ${lastError?.message ?? 'unknown error'}\n${logs.stdout ?? ''}`,
  );
}

async function waitFor(predicate, label, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let last;

  while (Date.now() < deadline) {
    last = await predicate();

    if (last) {
      return last;
    }

    await sleep(20);
  }

  throw new Error(
    `Timed out waiting for ${label}. Last value: ${JSON.stringify(last)}`,
  );
}

function snapshot(runId, status, lastSeq = 1) {
  return {
    runId,
    status,
    harnessStatus: status,
    lastSeq,
    version: 1,
  };
}

function usageRecord(runId) {
  return {
    runId,
    usageStatus: 'known',
    grossPromptTokens: 10,
    grossCompletionTokens: 5,
    cachedPromptTokens: 0,
    reasoningTokens: 0,
    totalTokens: 15,
    costStatus: 'unknown',
    raw: {},
  };
}

function runEvent(request, seq, type, payload) {
  return {
    id: `${request.runId}:${seq}`,
    runId: request.runId,
    ownerUserId: request.ownerUserId,
    conversationId: request.conversationId,
    seq,
    type,
    payload,
    createdAt: new Date().toISOString(),
  };
}

function defaultEvents(request) {
  return [
    runEvent(request, 1, 'message.delta', { text: 'a' }),
    runEvent(request, 2, 'message.delta', { text: 'b' }),
    runEvent(request, 3, 'run.completed', {}),
  ];
}

/** Contract-compliant stub. Every network-touching method is a local function. */
function createStubAdapter(overrides = {}) {
  const state = {
    createCalls: [],
    recoveryCalls: [],
    resolveCancel: null,
    createImpl:
      overrides.createImpl ??
      ((request) => ({
        runId: request.runId,
        harnessSessionId: `sess-${request.runId}`,
        harnessRunId: `harness-${request.runId}`,
        dispatchState: 'dispatched',
        deduplicated: false,
        acceptedAt: new Date().toISOString(),
      })),
    eventsImpl: overrides.eventsImpl ?? defaultEvents,
    afterImpl: overrides.afterImpl ?? null,
    getRunImpl: overrides.getRunImpl ?? ((runId) => snapshot(runId, 'completed')),
    usageImpl: overrides.usageImpl ?? ((runId) => usageRecord(runId)),
    recoveryImpl: overrides.recoveryImpl ?? (() => []),
  };

  return {
    state,
    async createRun(request) {
      state.createCalls.push(request);
      return state.createImpl(request);
    },
    subscribe(request) {
      return (async function* stream() {
        for (const event of state.eventsImpl(request)) {
          if (request.signal?.aborted === true) {
            return;
          }

          yield event;
        }

        if (state.afterImpl !== null) {
          await state.afterImpl(request, state);
        }
      })();
    },
    async cancel(request) {
      return (
        overrides.cancelImpl?.(request) ?? {
          runId: request.runId,
          status: 'cancelled',
          dispatchState: 'dispatched',
        }
      );
    },
    async steer() {
      return { accepted: false, reason: 'not_running' };
    },
    async getRun(runId) {
      return state.getRunImpl(runId);
    },
    async getUsage(runId) {
      return state.usageImpl(runId);
    },
    async recoverAfterRestart(input) {
      state.recoveryCalls.push(input);

      return {
        recoveredAt: new Date().toISOString(),
        outcomes: state.recoveryImpl(input),
      };
    },
    async close() {},
  };
}

function createLogger() {
  const entries = [];

  return {
    entries,
    log(entry) {
      entries.push(entry);
    },
  };
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

      server.close(() => resolve(address.port));
    });
  });
}

/** Minimal in-memory browser: session cookie plus CSRF synchronizer token. */
function createClient(base, session) {
  return async function request(path, options = {}) {
    const headers = {
      ...(options.headers ?? {}),
      cookie: `habi_session=${session.sessionId}`,
    };

    if (options.csrf === true) {
      headers['x-csrf-token'] = session.csrfToken;
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

const dockerReady = dockerAvailable();

describe(
  'POST -> dispatch -> settle run pipeline',
  { skip: dockerReady ? false : 'Docker daemon is unavailable' },
  () => {
    let containerName = '';
    let pool;
    let databaseUrl = '';
    let app;
    let base = '';
    let sessions;
    let RunService;
    let RunEventStore;
    let UsageLimitService;
    let WorkerRunRepository;
    let RunDispatcher;
    let WorkerRunner;

    function createRunner(adapter, overrides = {}) {
      const logger = createLogger();
      const workerRepository = new WorkerRunRepository(pool);
      const events = new RunEventStore(pool);
      const limits = new UsageLimitService(pool);
      const dispatcher = new RunDispatcher({
        pool,
        adapter,
        workerRepository,
        events,
        limits,
        logger,
        leaseMs: overrides.leaseMs ?? 5_000,
      });
      const runner = new WorkerRunner({
        pool,
        dispatcher,
        workerRepository,
        logger,
        config: {
          concurrency: overrides.concurrency ?? 2,
          batchSize: overrides.batchSize ?? 2,
          idleBackoffMs: 25,
          maxIdleBackoffMs: 100,
          leaseMs: overrides.leaseMs ?? 5_000,
          drainMs: 500,
          recoveryLimit: 50,
          sweepIntervalMs: 250,
        },
      });

      return { runner, dispatcher, logger, events, limits, workerRepository };
    }

    async function seedUser() {
      const id = randomUUID();
      await pool.query('INSERT INTO users (id) VALUES ($1)', [id]);
      return id;
    }

    async function seedConversation(ownerUserId) {
      const botId = randomUUID();
      const conversationId = randomUUID();

      await pool.query(
        `INSERT INTO bots (id, owner_user_id, name)
         VALUES ($1, $2, 'Pipeline Test Bot')`,
        [botId, ownerUserId],
      );
      await pool.query(
        `INSERT INTO conversations (id, owner_user_id, bot_id, title)
         VALUES ($1, $2, $3, 'Pipeline Test Conversation')`,
        [conversationId, ownerUserId, botId],
      );

      return { botId, conversationId };
    }

    async function cleanupUser(ownerUserId) {
      await pool.query('DELETE FROM usage_limit_audit WHERE owner_user_id = $1', [
        ownerUserId,
      ]);
      await pool.query('DELETE FROM usage_reservations WHERE owner_user_id = $1', [
        ownerUserId,
      ]);
      await pool.query('DELETE FROM usage_buckets WHERE owner_user_id = $1', [
        ownerUserId,
      ]);
      // `run_events` rejects direct mutation; deleting the Run cascades.
      await pool.query('DELETE FROM runs WHERE owner_user_id = $1', [ownerUserId]);
      await pool.query('DELETE FROM messages WHERE owner_user_id = $1', [
        ownerUserId,
      ]);
      await pool.query('DELETE FROM conversations WHERE owner_user_id = $1', [
        ownerUserId,
      ]);
      await pool.query('DELETE FROM bots WHERE owner_user_id = $1', [ownerUserId]);
      await pool.query('DELETE FROM users WHERE id = $1', [ownerUserId]);
    }

    async function readRun(runId) {
      const result = await pool.query(
        `SELECT id, owner_user_id, conversation_id, status, dispatch_state,
                error_code, usage_status, usage_total_tokens, finished_at
           FROM runs
          WHERE id = $1`,
        [runId],
      );

      return result.rows[0];
    }

    async function readEvents(runId) {
      const result = await pool.query(
        `SELECT seq, type, payload
           FROM run_events
          WHERE run_id = $1
          ORDER BY seq ASC`,
        [runId],
      );

      return result.rows.map((row) => ({
        seq: Number(row.seq),
        type: row.type,
        payload: row.payload,
      }));
    }

    async function reservationFor(runId) {
      const result = await pool.query(
        `SELECT state, charged_tokens, estimated_tokens
           FROM usage_reservations
          WHERE run_id = $1`,
        [runId],
      );

      return result.rows[0] ?? null;
    }

    async function countRuns(ownerUserId, conversationId) {
      const result = await pool.query(
        'SELECT count(*)::int AS count FROM runs WHERE owner_user_id = $1 AND conversation_id = $2',
        [ownerUserId, conversationId],
      );

      return result.rows[0]?.count ?? 0;
    }

    before(async () => {
      containerName = `habi-pipeline-${randomBytes(6).toString('hex')}`;
      const password = randomBytes(24).toString('hex');

      const container = spawnSync(
        'docker',
        [
          'run',
          '-d',
          '--rm',
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

      const port = Number.parseInt(
        portResult.stdout.trim().split(':').pop() ?? '',
        10,
      );
      assert.ok(Number.isInteger(port) && port > 0, 'Docker did not publish PostgreSQL');

      pool = new Pool({
        host: '127.0.0.1',
        port,
        user: DOCKER_USER,
        password,
        database: DOCKER_DATABASE,
        max: 10,
      });

      await waitForDatabase(pool, containerName);
      databaseUrl = `postgres://${DOCKER_USER}:${password}@127.0.0.1:${port}/${DOCKER_DATABASE}`;

      const applied = migrate(databaseUrl);
      assert.equal(applied.status, 0, applied.stderr);
      assert.match(applied.stdout, /applied\s+0009_usage_limits\.sql/);

      process.env.NODE_ENV = 'test';
      process.env.HABI_P1_API = '1';
      process.env.DATABASE_URL = databaseUrl;

      const { AppModule } = await import('../dist/app.module.js');
      const { NestFactory } = await import('@nestjs/core');
      const { SessionService } = await import('../dist/session/session.service.js');
      const runsModule = await import('../dist/runs/index.js');
      const eventsModule = await import('../dist/events/index.js');
      const limitsModule = await import('../dist/limits/index.js');
      const claimsModule = await import('../dist/worker/run-claim-repository.js');
      const dispatcherModule = await import('../dist/worker/run-dispatcher.js');
      const runnerModule = await import('../dist/worker/worker-runner.js');

      RunService = runsModule.RunService;
      RunEventStore = eventsModule.RunEventStore;
      UsageLimitService = limitsModule.UsageLimitService;
      WorkerRunRepository = claimsModule.WorkerRunRepository;
      RunDispatcher = dispatcherModule.RunDispatcher;
      WorkerRunner = runnerModule.WorkerRunner;

      const appPort = await getFreePort();
      app = await NestFactory.create(AppModule, { logger: false });
      await app.listen(appPort, '127.0.0.1');
      base = `http://127.0.0.1:${appPort}`;
      sessions = app.get(SessionService);
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
      }
    });

    test(
      'a posted message dispatches once, settles the allowance, and replays',
      { timeout: 40000 },
      async () => {
        const owner = await seedUser();
        const { conversationId } = await seedConversation(owner);
        const session = sessions.create(owner);
        const request = createClient(base, session);
        const stub = createStubAdapter();
        const { runner } = createRunner(stub);

        try {
          const posted = await request(`/api/threads/${conversationId}/messages`, {
            method: 'POST',
            csrf: true,
            body: { content: 'pipeline happy path', clientMessageId: 'happy-1' },
          });

          assert.equal(posted.status, 201, JSON.stringify(posted.body));
          assert.equal(posted.body.run.status, 'queued');
          assert.equal(posted.body.run.dispatchState, 'not_dispatched');
          const runId = posted.body.runId;

          const reserved = await reservationFor(runId);
          assert.equal(reserved.state, 'reserved');
          assert.equal(
            Number(reserved.estimated_tokens),
            RUN_ALLOWANCE_ESTIMATE_TOKENS,
          );

          await runner.start();

          const completed = await waitFor(async () => {
            const run = await readRun(runId);
            return run?.status === 'completed' ? run : null;
          }, 'completed Run');

          await waitFor(async () => {
            const events = await readEvents(runId);
            return events.some((event) => event.type === 'run.completed');
          }, 'terminal event');

          assert.equal(completed.dispatch_state, 'dispatched');
          assert.equal(Number(completed.usage_total_tokens), 15);
          assert.equal(stub.state.createCalls.length, 1);
          assert.deepEqual(
            stub.state.createCalls[0].messages.map((message) => message.content),
            ['pipeline happy path'],
          );

          const replay = await new RunEventStore(pool).read(owner, runId);
          assert.deepEqual(
            replay.events.map((event) => event.type),
            ['message.delta', 'message.delta', 'usage.recorded', 'run.completed'],
          );
          assert.equal(replay.terminalEventSeq, replay.events.at(-1)?.seq);
          assert.equal(replay.hasMore, false);

          await waitFor(async () => {
            const reservation = await reservationFor(runId);
            return reservation?.state === 'settled' ? reservation : null;
          }, 'settled reservation');

          const settlement = await reservationFor(runId);
          assert.equal(Number(settlement.charged_tokens), 15);

          const bucket = await new UsageLimitService(pool).getUsage(owner);
          assert.equal(bucket.inputTokens, 10);
          assert.equal(bucket.outputTokens, 5);
          assert.equal(bucket.reservedTokens, 0);
        } finally {
          await runner.stop();
          await cleanupUser(owner);
        }
      },
    );

    test(
      'an exhausted allowance refuses admission before dispatch and charges nothing',
      { timeout: 40000 },
      async () => {
        const owner = await seedUser();
        const { conversationId } = await seedConversation(owner);
        const session = sessions.create(owner);
        const request = createClient(base, session);
        const limits = new UsageLimitService(pool);

        try {
          // Leave less than one Run's admission bound.
          await limits.reserve({
            ownerUserId: owner,
            runId: randomUUID(),
            estimateTokens: 95_000,
          });

          const refused = await request(
            `/api/threads/${conversationId}/messages`,
            {
              method: 'POST',
              csrf: true,
              body: { content: 'too much', clientMessageId: 'exhausted-1' },
            },
          );

          assert.equal(refused.status, 429);
          assert.equal(refused.body.error.code, 'allowance_exhausted');
          assert.equal(refused.body.error.remaining, 5_000);

          assert.equal(await countRuns(owner, conversationId), 0);

          const reservations = await pool.query(
            'SELECT count(*)::int AS count FROM usage_reservations WHERE owner_user_id = $1',
            [owner],
          );
          assert.equal(reservations.rows[0].count, 1);

          const bucket = await limits.getUsage(owner);
          assert.equal(bucket.reservedTokens, 95_000);
          assert.equal(bucket.inputTokens, 0);
          assert.equal(bucket.outputTokens, 0);
        } finally {
          await cleanupUser(owner);
        }
      },
    );

    test(
      'a retried client idempotency key reuses the Run and charges once',
      { timeout: 40000 },
      async () => {
        const owner = await seedUser();
        const { conversationId } = await seedConversation(owner);
        const session = sessions.create(owner);
        const request = createClient(base, session);

        try {
          const body = { content: 'retry me', clientMessageId: 'retry-1' };
          const first = await request(
            `/api/threads/${conversationId}/messages`,
            { method: 'POST', csrf: true, body },
          );
          const second = await request(
            `/api/threads/${conversationId}/messages`,
            { method: 'POST', csrf: true, body },
          );

          assert.equal(first.status, 201);
          assert.equal(second.status, 201);
          assert.equal(second.body.message.id, first.body.message.id);
          assert.equal(second.body.run.id, first.body.run.id);

          assert.equal(await countRuns(owner, conversationId), 1);

          const reservations = await pool.query(
            `SELECT run_id, state, estimated_tokens
               FROM usage_reservations
              WHERE owner_user_id = $1`,
            [owner],
          );
          assert.equal(reservations.rows.length, 1);
          assert.equal(reservations.rows[0].run_id, first.body.runId);
          assert.equal(reservations.rows[0].state, 'reserved');

          const bucket = await new UsageLimitService(pool).getUsage(owner);
          assert.equal(bucket.reservedTokens, RUN_ALLOWANCE_ESTIMATE_TOKENS);
        } finally {
          await cleanupUser(owner);
        }
      },
    );

    test(
      'two workers racing one Run dispatch exactly once',
      { timeout: 40000 },
      async () => {
        const owner = await seedUser();
        const { conversationId } = await seedConversation(owner);
        const session = sessions.create(owner);
        const request = createClient(base, session);
        const sessionStubA = createStubAdapter();
        const sessionStubB = createStubAdapter();
        const runnerA = createRunner(sessionStubA, {
          concurrency: 1,
          batchSize: 1,
        }).runner;
        const runnerB = createRunner(sessionStubB, {
          concurrency: 1,
          batchSize: 1,
        }).runner;

        try {
          const posted = await request(
            `/api/threads/${conversationId}/messages`,
            {
              method: 'POST',
              csrf: true,
              body: { content: 'race me', clientMessageId: 'race-1' },
            },
          );
          assert.equal(posted.status, 201);
          const runId = posted.body.runId;

          await Promise.all([runnerA.start(), runnerB.start()]);

          await waitFor(async () => {
            const run = await readRun(runId);
            return run?.status === 'completed' ? run : null;
          }, 'completed Run');

          const calls = [
            ...sessionStubA.state.createCalls,
            ...sessionStubB.state.createCalls,
          ];

          assert.equal(calls.length, 1, 'the Run must be dispatched exactly once');
          assert.equal(calls[0].runId, runId);

          await waitFor(async () => {
            const terminalEvents = await pool.query(
              `SELECT count(*)::int AS count
                 FROM run_events
                WHERE run_id = $1
                  AND type IN ('run.completed', 'run.failed', 'run.cancelled')`,
              [runId],
            );

            return terminalEvents.rows[0].count === 1;
          }, 'single terminal event');

          await waitFor(async () => {
            const reservation = await reservationFor(runId);
            return reservation?.state === 'settled' ? reservation : null;
          }, 'settled reservation');
        } finally {
          await Promise.all([runnerA.stop(), runnerB.stop()]);
          await cleanupUser(owner);
        }
      },
    );

    test(
      'scoped recovery leaves a fresh reservation claimable',
      { timeout: 40000 },
      async () => {
        const owner = await seedUser();
        const { conversationId } = await seedConversation(owner);
        const session = sessions.create(owner);
        const request = createClient(base, session);
        const recoveryStub = createStubAdapter({
          recoveryImpl: (input) =>
            input.runIds.map((runId) => ({
              kind: 'lost',
              runId,
              dispatchState: 'unknown',
            })),
        });
        const recoveryService = new RunService(pool, recoveryStub);

        try {
          const posted = await request(
            `/api/threads/${conversationId}/messages`,
            {
              method: 'POST',
              csrf: true,
              body: { content: 'fresh reservation', clientMessageId: 'scoped-1' },
            },
          );
          assert.equal(posted.status, 201);
          const runId = posted.body.runId;

          const summary = await recoveryService.recoverAfterRestart({
            lease: { staleAfterMs: 60_000 },
          });

          assert.deepEqual(summary.outcomes, []);
          assert.equal(
            recoveryStub.state.recoveryCalls.length,
            0,
            'a fresh reservation is not reconciled',
          );

          const stillClaimable = await readRun(runId);
          assert.equal(stillClaimable.status, 'queued');
          assert.equal(stillClaimable.dispatch_state, 'not_dispatched');

          // The same Run is still dispatchable by the claim loop.
          const stub = createStubAdapter();
          const { runner } = createRunner(stub);

          try {
            await runner.start();

            await waitFor(async () => {
              const run = await readRun(runId);
              return run?.status === 'completed' ? run : null;
            }, 'completed Run after scoped recovery');

            assert.equal(stub.state.createCalls.length, 1);
          } finally {
            await runner.stop();
          }
        } finally {
          await cleanupUser(owner);
        }
      },
    );

    test(
      'unscoped recovery keeps the documented full-sweep behaviour',
      { timeout: 40000 },
      async () => {
        const owner = await seedUser();
        const { conversationId } = await seedConversation(owner);
        const session = sessions.create(owner);
        const request = createClient(base, session);
        const stub = createStubAdapter({
          createImpl: () => {
            throw new Error('recovery must never dispatch');
          },
          usageImpl: (runId) => ({
            runId,
            usageStatus: 'unknown',
            grossPromptTokens: null,
            grossCompletionTokens: null,
            cachedPromptTokens: null,
            reasoningTokens: null,
            totalTokens: null,
            costStatus: 'unknown',
            raw: {},
          }),
          recoveryImpl: (input) =>
            input.runIds.map((runId) => ({
              kind: 'lost',
              runId,
              dispatchState: 'unknown',
            })),
        });
        const events = new RunEventStore(pool);
        const limits = new UsageLimitService(pool);
        const service = new RunService(pool, stub, { events, limits });

        try {
          const posted = await request(
            `/api/threads/${conversationId}/messages`,
            {
              method: 'POST',
              csrf: true,
              body: { content: 'full sweep', clientMessageId: 'unscoped-1' },
            },
          );
          assert.equal(posted.status, 201);
          const runId = posted.body.runId;

          const summary = await service.recoverAfterRestart();

          assert.equal(summary.outcomes.length, 1);
          assert.equal(summary.outcomes[0].runId, runId);
          assert.equal(summary.outcomes[0].outcome, 'lost');

          const recovered = await readRun(runId);
          assert.equal(recovered.status, 'execution_uncertain');
          assert.equal(recovered.dispatch_state, 'unknown');
          assert.ok(recovered.finished_at !== null);
          assert.equal(stub.state.createCalls.length, 0);
          assert.equal(stub.state.recoveryCalls.length, 1);

          const terminal = await pool.query(
            `SELECT count(*)::int AS count
               FROM run_events
              WHERE run_id = $1
                AND type IN ('run.completed', 'run.failed', 'run.cancelled')`,
            [runId],
          );
          assert.equal(terminal.rows[0].count, 1);

          const reservation = await reservationFor(runId);
          assert.equal(reservation.state, 'unknown');
        } finally {
          await cleanupUser(owner);
        }
      },
    );
  },
);
