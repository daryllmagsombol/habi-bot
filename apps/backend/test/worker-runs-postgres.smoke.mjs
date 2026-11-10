/**
 * H-0xx worker dispatch integration smoke tests.
 *
 * Starts an ephemeral PostgreSQL 18.6 container on a random loopback port,
 * applies every real migration, and drives the compiled worker claim loop with
 * a stub `HarnessAdapter`. There is no Hermes process, provider network,
 * credential, or paid call. Docker unavailability skips the suite.
 *
 * Coverage:
 *   flag off              the process stays inert and claims nothing
 *   flag on, no adapter   starts without claiming queued Runs
 *   happy path            one claim, one dispatch, ordered replay + settlement
 *   concurrent claimers   distinct Runs, never the same Run twice
 *   cancel mid-run        adapter cancel reached, exactly one terminal outcome
 *   dispatch failure      proven pre-dispatch and ambiguous outcomes, no retry
 *   crash mid-dispatch    abandoned claim recovered without a second dispatch
 *   provider exhaustion   recoverable failure, reservation released, no fallback
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';

const { Pool } = pg;

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const BACKEND_ROOT = fileURLToPath(new URL('../', import.meta.url));
const WORKER_ENTRY = fileURLToPath(new URL('../dist/worker.js', import.meta.url));
const MIGRATE_SCRIPT = `${REPOSITORY_ROOT}scripts/db/migrate.mjs`;
const POSTGRES_IMAGE = 'postgres:18.6-alpine';
const DOCKER_USER = 'habi';
const DOCKER_DATABASE = 'habi';
const READY_TIMEOUT_MS = 20_000;
const EXIT_TIMEOUT_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 20_000;

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

  throw new Error(`Timed out waiting for ${label}. Last value: ${JSON.stringify(last)}`);
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

/**
 * Contract-compliant stub. Every network-touching method is a local function;
 * tests override behavior per case and inspect recorded calls.
 */
function createStubAdapter(overrides = {}) {
  const state = {
    createCalls: [],
    cancelCalls: [],
    usageCalls: [],
    recoveryCalls: [],
    subscribeCalls: [],
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

  const cancelPromise = new Promise((resolve) => {
    state.resolveCancel = resolve;
  });

  return {
    state,
    cancelPromise,
    async createRun(request) {
      state.createCalls.push(request);
      return state.createImpl(request);
    },
    subscribe(request) {
      state.subscribeCalls.push(request);

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
      state.cancelCalls.push(request);
      state.resolveCancel?.();

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
      state.usageCalls.push(runId);
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

const dockerReady = dockerAvailable();

describe(
  'headless worker run dispatch',
  { skip: dockerReady ? false : 'Docker daemon is unavailable' },
  () => {
    let containerName = '';
    let pool;
    let databaseUrl = '';
    let RunService;
    let RunEventStore;
    let UsageLimitService;
    let WorkerRunRepository;
    let RunDispatcher;
    let WorkerRunner;
    let HarnessAdapterError;
    let childProcesses = [];

    function loopConfig(overrides = {}) {
      return {
        concurrency: 2,
        batchSize: 2,
        idleBackoffMs: 25,
        maxIdleBackoffMs: 100,
        leaseMs: 5_000,
        drainMs: 1_000,
        recoveryLimit: 50,
        sweepIntervalMs: 250,
        ...overrides,
      };
    }

    function createRunner(adapter, overrides = {}) {
      const config = loopConfig(overrides.config);
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
        leaseMs: config.leaseMs,
      });
      const runner = new WorkerRunner({
        pool,
        dispatcher,
        workerRepository,
        logger,
        config,
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
         VALUES ($1, $2, 'Worker Test Bot')`,
        [botId, ownerUserId],
      );
      await pool.query(
        `INSERT INTO conversations (id, owner_user_id, bot_id, title)
         VALUES ($1, $2, $3, 'Worker Test Conversation')`,
        [conversationId, ownerUserId, botId],
      );

      return { botId, conversationId };
    }

    async function seedQueuedRun(ownerUserId, content = 'hello worker') {      const { botId, conversationId } = await seedConversation(ownerUserId);
      const messageId = randomUUID();

      await pool.query(
        `INSERT INTO messages (
           id, conversation_id, owner_user_id, role, content, seq, status,
           finalized_at
         )
         VALUES ($1, $2, $3, 'user', $4, 1, 'final', now())`,
        [messageId, conversationId, ownerUserId, content],
      );

      const runId = randomUUID();

      await pool.query(
        `INSERT INTO runs (
           id, owner_user_id, conversation_id, idempotency_key,
           request_fingerprint, status, dispatch_state, usage_status,
           usage_cost_status
         )
         VALUES ($1, $2, $3, $4, 'worker-test-fingerprint', 'queued',
                 'not_dispatched', 'unknown', 'unknown')`,
        [runId, ownerUserId, conversationId, `api-message:${messageId}`],
      );

      return { runId, messageId, conversationId, botId };
    }

    /**
     * Removes a seeded conversation and its Runs/events/messages. Used by the
     * inert-path tests, whose Runs stay queued on purpose and would otherwise be
     * claimed by the next test's worker.
     */
    async function cleanupConversation(conversationId) {
      await pool.query('DELETE FROM runs WHERE conversation_id = $1', [
        conversationId,
      ]);
      await pool.query('DELETE FROM messages WHERE conversation_id = $1', [
        conversationId,
      ]);
      await pool.query('DELETE FROM conversations WHERE id = $1', [
        conversationId,
      ]);
    }

    async function readRun(runId) {
      const result = await pool.query(
        `SELECT id, owner_user_id, conversation_id, status, dispatch_state,
                error_code, usage_status, usage_gross_prompt_tokens,
                usage_gross_completion_tokens, usage_total_tokens,
                last_event_seq, finished_at
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

    async function terminalEventCount(runId) {
      const result = await pool.query(
        `SELECT count(*)::int AS count
           FROM run_events
          WHERE run_id = $1
            AND type IN ('run.completed', 'run.failed', 'run.cancelled')`,
        [runId],
      );

      return result.rows[0]?.count ?? 0;
    }

    function trackChild(child) {
      childProcesses.push(child);
      return child;
    }

    function spawnNode(args, env) {
      return trackChild(
        spawn(process.execPath, args, {
          cwd: BACKEND_ROOT,
          env: { ...process.env, ...env },
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      );
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

    function waitForLogEvent(child, output, eventName, timeoutMs = READY_TIMEOUT_MS) {
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
          child.off('exit', onExit);
        }

        function check() {
          for (const line of output.stdout.split(/\r?\n/)) {
            if (line.trim().length === 0) {
              continue;
            }

            try {
              const entry = JSON.parse(line);

              if (entry?.event === eventName) {
                cleanup();
                resolve(entry);
                return;
              }
            } catch {
              // Non-JSON output is not a worker log entry.
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

    async function stopChild(child) {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }

      child.kill('SIGKILL');

      try {
        await waitForExit(child, 5000, 'Child process');
      } catch {
        // Already gone.
      }
    }

    before(async () => {
      containerName = `habi-worker-${randomBytes(6).toString('hex')}`;
      const password = randomBytes(24).toString('hex');

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
      assert.match(applied.stdout, /applied\s+0001_conversations\.sql/);
      assert.match(applied.stdout, /applied\s+0005_run_lifecycle\.sql/);
      assert.match(applied.stdout, /applied\s+0009_usage_limits\.sql/);
      assert.match(applied.stdout, /applied\s+0014_skills\.sql/);

      const runsModule = await import('../dist/runs/index.js');
      const eventsModule = await import('../dist/events/index.js');
      const limitsModule = await import('../dist/limits/index.js');
      const claimsModule = await import('../dist/worker/run-claim-repository.js');
      const dispatcherModule = await import('../dist/worker/run-dispatcher.js');
      const runnerModule = await import('../dist/worker/worker-runner.js');
      const adapterModule = await import('../dist/adapters/harness-adapter.js');

      RunService = runsModule.RunService;
      RunEventStore = eventsModule.RunEventStore;
      UsageLimitService = limitsModule.UsageLimitService;
      WorkerRunRepository = claimsModule.WorkerRunRepository;
      RunDispatcher = dispatcherModule.RunDispatcher;
      WorkerRunner = runnerModule.WorkerRunner;
      HarnessAdapterError = adapterModule.HarnessAdapterError;
    });

    after(async () => {
      for (const child of childProcesses) {
        await stopChild(child);
      }

      childProcesses = [];

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
      'flag off keeps the worker inert: nothing is claimed or dispatched',
      { timeout: 40000 },
      async () => {
        const owner = await seedUser();
        const seeded = await seedQueuedRun(owner);
        const { runId } = seeded;
        const child = spawnNode([WORKER_ENTRY], {
          HOST: '127.0.0.1',
          PORT: '0',
          NODE_ENV: 'test',
          DATABASE_URL: databaseUrl,
          HABI_P1_WORKER: '',
          HABI_HERMES_BASE_URL: '',
          HABI_HERMES_GATEWAY_KEY: '',
        });
        const output = captureOutput(child);

        try {
          const ready = await waitForLogEvent(child, output, 'worker.ready');
          assert.equal(ready.service, 'worker');

          await sleep(500);

          const run = await readRun(runId);
          assert.equal(run.status, 'queued');
          assert.equal(run.dispatch_state, 'not_dispatched');
          assert.equal(await terminalEventCount(runId), 0);
          assert.equal(
            output.stdout.includes('worker.runtime.started'),
            false,
            'flag-off worker must not start the runtime',
          );

          child.kill('SIGTERM');
          const exit = await waitForExit(child, EXIT_TIMEOUT_MS, 'Worker');
          assert.deepEqual(exit, { code: 0, signal: null });
        } finally {
          await stopChild(child);
          await cleanupConversation(seeded.conversationId);
        }
      },
    );

    test(
      'flag on without a configured adapter starts but claims nothing',
      { timeout: 40000 },
      async () => {
        const owner = await seedUser();
        const seeded = await seedQueuedRun(owner);
        const { runId } = seeded;
        const child = spawnNode([WORKER_ENTRY], {
          HOST: '127.0.0.1',
          PORT: '0',
          NODE_ENV: 'test',
          DATABASE_URL: databaseUrl,
          HABI_P1_WORKER: '1',
          HABI_HERMES_BASE_URL: '',
          HABI_HERMES_GATEWAY_KEY: '',
        });
        const output = captureOutput(child);

        try {
          await waitForLogEvent(child, output, 'worker.ready');
          await waitForLogEvent(child, output, 'worker.adapter_unconfigured');

          await sleep(500);

          const run = await readRun(runId);
          assert.equal(run.status, 'queued');
          assert.equal(run.dispatch_state, 'not_dispatched');
          assert.equal(await terminalEventCount(runId), 0);

          child.kill('SIGTERM');
          const exit = await waitForExit(child, EXIT_TIMEOUT_MS, 'Worker');
          assert.deepEqual(exit, { code: 0, signal: null });
        } finally {
          await stopChild(child);
          await cleanupConversation(seeded.conversationId);
        }
      },
    );

    test(
      'enabled worker with a configured adapter drains and exits 0 on SIGTERM',
      { timeout: 40000 },
      async () => {
        const child = spawnNode([WORKER_ENTRY], {
          HOST: '127.0.0.1',
          PORT: '0',
          NODE_ENV: 'test',
          DATABASE_URL: databaseUrl,
          HABI_P1_WORKER: '1',
          HABI_HERMES_BASE_URL: 'http://127.0.0.1:9',
          HABI_HERMES_GATEWAY_KEY: 'test-gateway-key',
        });
        const output = captureOutput(child);

        try {
          await waitForLogEvent(child, output, 'worker.runtime.started');
          await waitForLogEvent(child, output, 'worker.ready');

          child.kill('SIGTERM');
          const exit = await waitForExit(child, EXIT_TIMEOUT_MS, 'Worker');
          assert.deepEqual(exit, { code: 0, signal: null });
          assert.ok(
            output.stdout.includes('"event":"worker.stopped"'),
            `worker did not report a clean stop.\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`,
          );
        } finally {
          await stopChild(child);
        }
      },
    );

    test(
      'one queued Run is dispatched once and its events replay in seq order',
      { timeout: 40000 },
      async () => {
        const owner = await seedUser();
        const { runId, messageId } = await seedQueuedRun(owner, 'replay me');
        const limits = new UsageLimitService(pool);
        const reservation = await limits.reserve({
          ownerUserId: owner,
          runId,
          estimateTokens: 1_000,
        });
        const stub = createStubAdapter();
        const { runner } = createRunner(stub);

        try {
          await runner.start();

          const completed = await waitFor(
            async () => {
              const run = await readRun(runId);
              return run?.status === 'completed' ? run : null;
            },
            'completed Run',
          );

          // The terminal event is appended after the terminal state commits, so
          // wait for that second committed write before asserting the stream.
          await waitFor(
            async () => (await terminalEventCount(runId)) === 1,
            'terminal event',
          );

          assert.equal(stub.state.createCalls.length, 1);

          const [request] = stub.state.createCalls;
          assert.equal(request.runId, runId);
          assert.equal(request.ownerUserId, owner);
          assert.deepEqual(
            request.messages.map((message) => [message.role, message.content]),
            [['user', 'replay me']],
          );
          assert.equal(request.messages[0].messageId, messageId);
          assert.equal(request.allowedTools.length, 0);

          const events = await readEvents(runId);
          assert.deepEqual(
            events.map((event) => [event.seq, event.type]),
            [
              [1, 'message.delta'],
              [2, 'message.delta'],
              [3, 'usage.recorded'],
              [4, 'run.completed'],
            ],
          );
          assert.equal(events[0].payload.text, 'a');
          assert.equal(events[1].payload.text, 'b');

          const replay = await new RunEventStore(pool).read(owner, runId);
          assert.deepEqual(
            replay.events.map((event) => event.seq),
            [1, 2, 3, 4],
          );
          assert.equal(replay.terminalEventSeq, 4);
          assert.equal(replay.hasMore, false);

          const tail = await new RunEventStore(pool).read(owner, runId, {
            afterSeq: 2,
          });
          assert.deepEqual(
            tail.events.map((event) => event.type),
            ['usage.recorded', 'run.completed'],
          );

          assert.equal(completed.dispatch_state, 'dispatched');
          assert.equal(Number(completed.usage_gross_prompt_tokens), 10);
          assert.equal(Number(completed.usage_gross_completion_tokens), 5);
          assert.equal(Number(completed.usage_total_tokens), 15);

          await waitFor(
            async () => {
              const result = await pool.query(
                'SELECT state, charged_tokens FROM usage_reservations WHERE id = $1',
                [reservation.id],
              );

              return result.rows[0]?.state === 'settled' ? result.rows[0] : null;
            },
            'settled reservation',
          );

          const bucket = await limits.getUsage(owner);
          assert.equal(bucket.inputTokens, 10);
          assert.equal(bucket.outputTokens, 5);
          assert.equal(bucket.reservedTokens, 0);

          await sleep(150);
          assert.equal(await terminalEventCount(runId), 1);
        } finally {
          await runner.stop();
        }
      },
    );

    test(
      'two concurrent claimers dispatch distinct Runs and never duplicate one',
      { timeout: 40000 },
      async () => {
        const owner = await seedUser();
        const first = await seedQueuedRun(owner, 'first');
        const second = await seedQueuedRun(owner, 'second');
        const stubA = createStubAdapter({
          createImpl: async (request) => {
            await sleep(80);

            return {
              runId: request.runId,
              harnessSessionId: 'sess-a',
              harnessRunId: `harness-${request.runId}`,
              dispatchState: 'dispatched',
              deduplicated: false,
              acceptedAt: new Date().toISOString(),
            };
          },
        });
        const stubB = createStubAdapter();
        const runnerA = createRunner(stubA, {
          config: { concurrency: 1, batchSize: 1 },
        }).runner;
        const runnerB = createRunner(stubB, {
          config: { concurrency: 1, batchSize: 1 },
        }).runner;

        try {
          await Promise.all([runnerA.start(), runnerB.start()]);

          await waitFor(async () => {
            const [a, b] = await Promise.all([
              readRun(first.runId),
              readRun(second.runId),
            ]);

            return a?.status === 'completed' && b?.status === 'completed';
          }, 'both Runs completed');

          await waitFor(async () => {
            const counts = await Promise.all([
              terminalEventCount(first.runId),
              terminalEventCount(second.runId),
            ]);

            return counts.every((count) => count === 1);
          }, 'both terminal events');

          const calls = [...stubA.state.createCalls, ...stubB.state.createCalls];
          assert.equal(calls.length, 2);
          assert.deepEqual(
            new Set(calls.map((call) => call.runId)),
            new Set([first.runId, second.runId]),
          );
          assert.equal(
            calls.filter((call) => call.runId === first.runId).length,
            1,
            'the first Run must be dispatched exactly once',
          );
          assert.equal(
            calls.filter((call) => call.runId === second.runId).length,
            1,
            'the second Run must be dispatched exactly once',
          );

          for (const runId of [first.runId, second.runId]) {
            assert.equal(await terminalEventCount(runId), 1);
          }
        } finally {
          await Promise.all([runnerA.stop(), runnerB.stop()]);
        }
      },
    );

    test(
      'cancel mid-run reaches the adapter and terminalizes exactly once',
      { timeout: 40000 },
      async () => {
        const owner = await seedUser();
        const { runId } = await seedQueuedRun(owner, 'cancel me');
        const stub = createStubAdapter({
          eventsImpl: (request) => [runEvent(request, 1, 'message.delta', { text: 'x' })],
          afterImpl: async () => {
            await stub.cancelPromise;
          },
          getRunImpl: (runIdToRead) =>
            stub.state.cancelCalls.length > 0
              ? snapshot(runIdToRead, 'cancelled')
              : snapshot(runIdToRead, 'running'),
        });
        const { runner } = createRunner(stub);
        const runs = new RunService(pool, stub);

        try {
          await runner.start();

          await waitFor(
            async () => (await readEvents(runId)).length >= 1,
            'first streamed event',
          );

          const cancelled = await runs.cancelRun(owner, runId, 'user');
          assert.equal(cancelled.status, 'cancelled');
          assert.equal(stub.state.cancelCalls.length, 1);
          assert.equal(stub.state.cancelCalls[0].reason, 'user');

          await waitFor(async () => {
            const run = await readRun(runId);
            return run?.status === 'cancelled' ? run : null;
          }, 'cancelled Run');

          await sleep(300);

          const events = await readEvents(runId);
          assert.equal(events.at(-1)?.type, 'run.cancelled');
          assert.equal(await terminalEventCount(runId), 1);
          assert.equal(stub.state.cancelCalls.length, 1);
          assert.equal(stub.state.createCalls.length, 1);
        } finally {
          await runner.stop();
        }
      },
    );

    test(
      'dispatch failures map to failed or execution_uncertain without a retry',
      { timeout: 40000 },
      async () => {
        const owner = await seedUser();
        const preDispatch = await seedQueuedRun(owner, 'exhausted');
        const ambiguous = await seedQueuedRun(owner, 'ambiguous');
        const stub = createStubAdapter({
          createImpl: (request) => {
            if (request.runId === ambiguous.runId) {
              throw new HarnessAdapterError('transport_ambiguous', 'unknown');
            }

            throw new HarnessAdapterError('provider_exhausted', 'not_dispatched');
          },
        });
        const { runner } = createRunner(stub);

        try {
          await runner.start();

          const failed = await waitFor(async () => {
            const run = await readRun(preDispatch.runId);
            return run?.status === 'failed' ? run : null;
          }, 'pre-dispatch failed Run');
          const uncertain = await waitFor(async () => {
            const run = await readRun(ambiguous.runId);
            return run?.status === 'execution_uncertain' ? run : null;
          }, 'ambiguous Run');

          assert.equal(failed.error_code, 'provider_exhausted');
          assert.equal(failed.dispatch_state, 'not_dispatched');
          assert.equal(uncertain.error_code, 'transport_ambiguous');
          assert.equal(uncertain.dispatch_state, 'unknown');

          await sleep(300);

          assert.equal(stub.state.createCalls.length, 2, 'each Run is tried once');          assert.equal(
            stub.state.createCalls.filter(
              (call) => call.runId === ambiguous.runId,
            ).length,
            1,
            'unknown dispatch must never be retried',
          );
          assert.equal(await terminalEventCount(preDispatch.runId), 1);
          assert.equal(await terminalEventCount(ambiguous.runId), 1);

          const failedEvents = await readEvents(preDispatch.runId);
          assert.equal(failedEvents.at(-1)?.type, 'run.failed');
          assert.equal(
            failedEvents.at(-1)?.payload.errorCode,
            'provider_exhausted',
          );
        } finally {
          await runner.stop();
        }
      },
    );

    test(
      'a worker killed mid-dispatch leaves a recoverable Run with no duplicate dispatch',
      { timeout: 60000 },
      async () => {
        const owner = await seedUser();
        const { runId } = await seedQueuedRun(owner, 'kill me');
        const dist = (name) =>
          pathToFileURL(fileURLToPath(new URL(`../dist/${name}`, import.meta.url)))
            .href;

        const childCode = `
import pg from 'pg';
const { Pool } = pg;
const { RunEventStore } = await import(${JSON.stringify(dist('events/index.js'))});
const { UsageLimitService } = await import(${JSON.stringify(dist('limits/index.js'))});
const { WorkerRunRepository } = await import(${JSON.stringify(dist('worker/run-claim-repository.js'))});
const { RunDispatcher } = await import(${JSON.stringify(dist('worker/run-dispatcher.js'))});
const { WorkerRunner } = await import(${JSON.stringify(dist('worker/worker-runner.js'))});

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const logger = { log() {} };
const adapter = {
  async createRun(request) {
    return {
      runId: request.runId,
      harnessSessionId: 'child-session',
      harnessRunId: 'child-harness',
      dispatchState: 'dispatched',
      deduplicated: false,
      acceptedAt: new Date().toISOString(),
    };
  },
  subscribe(request) {
    return (async function* stream() {
      yield {
        id: request.runId + ':1',
        runId: request.runId,
        ownerUserId: request.ownerUserId,
        conversationId: request.conversationId,
        seq: 1,
        type: 'message.delta',
        payload: { text: 'partial' },
        createdAt: new Date().toISOString(),
      };
      await new Promise(() => {});
    })();
  },
  async cancel() {
    return { runId: 'child', status: 'cancelled', dispatchState: 'dispatched' };
  },
  async steer() {
    return { accepted: false, reason: 'not_running' };
  },
  async getRun(runId) {
    return { runId, status: 'running', harnessStatus: 'running', lastSeq: 1, version: 1 };
  },
  async getUsage(runId) {
    return {
      runId,
      usageStatus: 'unknown',
      grossPromptTokens: null,
      grossCompletionTokens: null,
      cachedPromptTokens: null,
      reasoningTokens: null,
      totalTokens: null,
      costStatus: 'unknown',
      raw: {},
    };
  },
  async recoverAfterRestart(input) {
    return {
      recoveredAt: new Date().toISOString(),
      outcomes: input.runIds.map((id) => ({ kind: 'lost', runId: id, dispatchState: 'unknown' })),
    };
  },
  async close() {},
};
const config = {
  concurrency: 1,
  batchSize: 1,
  idleBackoffMs: 25,
  maxIdleBackoffMs: 100,
  leaseMs: 300,
  drainMs: 200,
  recoveryLimit: 10,
  sweepIntervalMs: 200,
};
const workerRepository = new WorkerRunRepository(pool);
const dispatcher = new RunDispatcher({
  pool,
  adapter,
  workerRepository,
  events: new RunEventStore(pool),
  limits: new UsageLimitService(pool),
  logger,
  leaseMs: config.leaseMs,
});
const runner = new WorkerRunner({ pool, dispatcher, workerRepository, logger, config });
await runner.start();
console.log(JSON.stringify({ event: 'worker.child.ready' }));
setInterval(() => {}, 1000);
`;
    const child = spawnNode(['--input-type=module', '-e', childCode], {
      DATABASE_URL: databaseUrl,
      NODE_ENV: 'test',
    });
    // Drain the child's pipes so a diagnostic cannot fill the buffer; this
    // test kills the process, so its output is not asserted.
    captureOutput(child);

        try {
          await waitFor(async () => {
            const run = await readRun(runId);
            return run?.status === 'running' ? run : null;
          }, 'child to accept the dispatch');

          await waitFor(
            async () => (await readEvents(runId)).length >= 1,
            'child to persist the first event',
          );

          child.kill('SIGKILL');
          const exit = await waitForExit(child, 5000, 'Killed worker');
          assert.equal(exit.signal, 'SIGKILL');

          const abandoned = await readRun(runId);
          assert.equal(abandoned.status, 'running');
          assert.equal(abandoned.dispatch_state, 'dispatched');
          assert.equal(await terminalEventCount(runId), 0);

          await sleep(400);

          const recoveryStub = createStubAdapter({
            createImpl: () => {
              throw new Error('recovery must never dispatch');
            },
            recoveryImpl: (input) =>
              input.runIds.map((runIdToRecover) => ({
                kind: 'lost',
                runId: runIdToRecover,
                dispatchState: 'unknown',
              })),
          });
          const { runner: recoveryRunner } = createRunner(recoveryStub, {
            config: { leaseMs: 250, concurrency: 1, batchSize: 1 },
          });

          const summary = await recoveryRunner.recoverAfterRestart();
          assert.equal(summary.outcomes.length, 1);
          assert.equal(summary.outcomes[0].runId, runId);
          assert.equal(summary.outcomes[0].outcome, 'lost');

          const recovered = await readRun(runId);
          assert.equal(recovered.status, 'execution_uncertain');
          assert.equal(recovered.dispatch_state, 'unknown');
          assert.equal(recovered.error_code, 'transport_ambiguous');
          assert.ok(recovered.finished_at !== null);
          assert.equal(recoveryStub.state.createCalls.length, 0);
          assert.equal(await terminalEventCount(runId), 1);

          const second = await recoveryRunner.recoverAfterRestart();
          assert.equal(second.outcomes.length, 0);
          assert.equal(await terminalEventCount(runId), 1);
        } finally {
          await stopChild(child);
        }
      },
    );

    test(
      'provider exhaustion is a recoverable failure that charges no paid provider',
      { timeout: 40000 },
      async () => {
        const owner = await seedUser();
        const { runId } = await seedQueuedRun(owner, 'exhausted credit');
        const limits = new UsageLimitService(pool);
        const reservation = await limits.reserve({
          ownerUserId: owner,
          runId,
          estimateTokens: 2_000,
        });
        const stub = createStubAdapter({
          createImpl: () => {
            throw new HarnessAdapterError('provider_exhausted', 'not_dispatched');
          },
        });
        const { runner } = createRunner(stub);

        try {
          await runner.start();

          const failed = await waitFor(async () => {
            const run = await readRun(runId);
            return run?.status === 'failed' ? run : null;
          }, 'exhausted Run');

          assert.equal(failed.error_code, 'provider_exhausted');
          assert.equal(failed.dispatch_state, 'not_dispatched');
          assert.equal(failed.usage_status, 'unknown');
          assert.equal(stub.state.createCalls.length, 1);

          // The terminal event is appended after the reservation settles, so it
          // proves both committed writes for this Run.
          await waitFor(
            async () => (await terminalEventCount(runId)) === 1,
            'terminal event',
          );

          const reservationRow = await pool.query(
            `SELECT state, charged_tokens
               FROM usage_reservations
              WHERE id = $1`,
            [reservation.id],
          );
          assert.equal(reservationRow.rows[0].state, 'released');
          assert.equal(Number(reservationRow.rows[0].charged_tokens), 0);

          const bucket = await limits.getUsage(owner);
          assert.equal(bucket.inputTokens, 0);
          assert.equal(bucket.outputTokens, 0);
          assert.equal(bucket.reservedTokens, 0);
          assert.equal(bucket.state, 'known');

          // Recoverable: a new Run (new idempotency key) can reserve again and
          // the failed Run did not consume the daily allowance.
          const retryRunId = randomUUID();
          const retry = await limits.reserve({
            ownerUserId: owner,
            runId: retryRunId,
            estimateTokens: 1_000,
          });
          assert.equal(retry.state, 'reserved');

          assert.equal(await terminalEventCount(runId), 1);
          const events = await readEvents(runId);
          assert.equal(events.at(-1)?.type, 'run.failed');
        } finally {
          await runner.stop();
        }
      },
    );
  },
);
