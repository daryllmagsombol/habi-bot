/**
 * Dispatched-run cancellation smoke tests.
 *
 * Starts an ephemeral PostgreSQL 18.6 container on a random loopback port,
 * applies every real migration, and drives the compiled API service, dispatcher,
 * and claim loop against a stub `HarnessAdapter`. No Hermes process, provider
 * network, credential, or paid call is involved. Docker unavailability skips the
 * suite.
 *
 * Coverage:
 *   mid-stream cancel    one adapter call, one terminal event, hold settled once
 *   API restart          the intent is durable before the worker observes it
 *   adapter failure      honest non-terminal state, bounded retry, later success
 *   retry bound          three attempts, then no further adapter call
 *   already finished     no-op success with no adapter call
 *   cross-user           the existing non-enumerating not-found
 *   undispatched         immediate cancel with exactly one hold release
 *   orphaned intent      the idle sweep cancels a Run whose API never finalized
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
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

const MAX_CANCEL_ATTEMPTS = 3;

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

/**
 * Contract-compliant stub. The `hold` stream emits one event then stays open
 * until the dispatcher aborts its subscription, which is exactly the signal the
 * real adapter's stream honours. Cancellation never reaches a provider.
 */
function createStubAdapter(overrides = {}) {
  const state = {
    createCalls: [],
    cancelCalls: [],
    usageCalls: [],
    subscribeCalls: [],
    cancelImpl:
      overrides.cancelImpl ??
      ((request) => ({
        runId: request.runId,
        status: 'cancelled',
        dispatchState: 'dispatched',
      })),
    eventsImpl:
      overrides.eventsImpl ??
      ((request) => [runEvent(request, 1, 'message.delta', { text: 'partial' })]),
    afterImpl: overrides.afterImpl ?? (() => new Promise(() => {})),
    getRunImpl:
      overrides.getRunImpl ?? ((runId) => ({
        runId,
        status: 'running',
        harnessStatus: 'running',
        lastSeq: 1,
        version: 1,
      })),
    usageImpl: overrides.usageImpl ?? ((runId) => usageRecord(runId)),
  };

  return {
    state,
    async createRun(request) {
      state.createCalls.push(request);

      return {
        runId: request.runId,
        harnessSessionId: `sess-${request.runId}`,
        harnessRunId: `harness-${request.runId}`,
        dispatchState: 'dispatched',
        deduplicated: false,
        acceptedAt: new Date().toISOString(),
      };
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

        if (request.signal?.aborted === true) {
          return;
        }

        // Hold the stream open until the worker aborts it, exactly like a
        // provider that has not produced its next chunk yet.
        await new Promise((resolve) => {
          if (request.signal === undefined) {
            return;
          }

          request.signal.addEventListener('abort', resolve, { once: true });
        });
      })();
    },
    async cancel(request) {
      state.cancelCalls.push(request);
      return state.cancelImpl(request);
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
      return {
        recoveredAt: new Date().toISOString(),
        outcomes: input.runIds.map((runId) => ({
          kind: 'lost',
          runId,
          dispatchState: 'dispatched',
        })),
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
  'dispatched run cancellation',
  { skip: dockerReady ? false : 'Docker daemon is unavailable' },
  () => {
    let containerName = '';
    let pool;
    let databaseUrl = '';
    let ApiService;
    let RunRepository;
    let RunEventStore;
    let UsageLimitService;
    let WorkerRunRepository;
    let RunDispatcher;
    let WorkerRunner;
    let HarnessAdapterError;
    let PersistenceNotFoundError;

    function loopConfig(overrides = {}) {
      return {
        concurrency: 1,
        batchSize: 1,
        idleBackoffMs: 20,
        maxIdleBackoffMs: 50,
        leaseMs: 1_000,
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

    function apiService(targetPool = pool) {
      return new ApiService(targetPool);
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
         VALUES ($1, $2, 'Cancel Test Bot')`,
        [botId, ownerUserId],
      );
      await pool.query(
        `INSERT INTO conversations (id, owner_user_id, bot_id, title)
         VALUES ($1, $2, $3, 'Cancel Test Conversation')`,
        [conversationId, ownerUserId, botId],
      );

      return { botId, conversationId };
    }

    async function seedRun(ownerUserId, options = {}) {
      const { conversationId } = await seedConversation(ownerUserId);
      const messageId = randomUUID();
      const runId = randomUUID();
      const status = options.status ?? 'queued';
      const dispatchState = options.dispatchState ?? 'not_dispatched';

      await pool.query(
        `INSERT INTO messages (
           id, conversation_id, owner_user_id, role, content, seq, status,
           finalized_at
         )
         VALUES ($1, $2, $3, 'user', $4, 1, 'final', now())`,
        [messageId, conversationId, ownerUserId, options.content ?? 'cancel probe'],
      );

      await pool.query(
        `INSERT INTO runs (
           id, owner_user_id, conversation_id, idempotency_key,
           request_fingerprint, status, dispatch_state, usage_status,
           usage_cost_status, finished_at
         )
         VALUES ($1, $2, $3, $4, 'cancel-test-fingerprint', $5, $6, 'unknown',
                 'unknown', $7)`,
        [
          runId,
          ownerUserId,
          conversationId,
          `api-message:${messageId}`,
          status,
          dispatchState,
          status === 'completed' ? new Date() : null,
        ],
      );

      return { runId, messageId, conversationId };
    }

    async function reserve(ownerUserId, runId) {
      return new UsageLimitService(pool).reserve({
        ownerUserId,
        runId,
        estimateTokens: 10_000,
      });
    }

    async function readRun(runId) {
      const result = await pool.query(
        `SELECT id, status, dispatch_state, error_code, finished_at,
                cancel_requested_at, cancel_reason, cancel_attempts,
                cancel_error_code, last_event_seq
           FROM runs
          WHERE id = $1`,
        [runId],
      );

      return result.rows[0];
    }

    async function readEvents(runId) {
      const result = await pool.query(
        `SELECT seq, type FROM run_events
          WHERE run_id = $1
          ORDER BY seq ASC`,
        [runId],
      );

      return result.rows.map((row) => ({ seq: Number(row.seq), type: row.type }));
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

    async function readReservation(runId) {
      const result = await pool.query(
        `SELECT state, charged_tokens, estimated_tokens
           FROM usage_reservations
          WHERE run_id = $1`,
        [runId],
      );

      return result.rows[0];
    }

    async function waitRunning(adapter, runId) {
      await waitFor(
        async () => (await readRun(runId))?.status === 'running',
        `Run ${runId} to be dispatched`,
      );
      await waitFor(
        async () => (await readEvents(runId)).length >= 1,
        'the Run to persist its first event',
      );
      assert.equal(adapter.state.createCalls.length >= 1, true);
    }

    before(async () => {
      containerName = `habi-cancel-${randomBytes(6).toString('hex')}`;
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
      assert.match(applied.stdout, /applied\s+0016_run_cancel_intent\.sql/);

      const runsModule = await import('../dist/runs/index.js');
      const eventsModule = await import('../dist/events/index.js');
      const limitsModule = await import('../dist/limits/index.js');
      const apiModule = await import('../dist/api/api-service.js');
      const claimsModule = await import('../dist/worker/run-claim-repository.js');
      const dispatcherModule = await import('../dist/worker/run-dispatcher.js');
      const runnerModule = await import('../dist/worker/worker-runner.js');
      const adapterModule = await import('../dist/adapters/harness-adapter.js');
      const errorsModule = await import('../dist/persistence/errors.js');

      ApiService = apiModule.ApiService;
      RunRepository = runsModule.RunRepository;
      RunEventStore = eventsModule.RunEventStore;
      UsageLimitService = limitsModule.UsageLimitService;
      WorkerRunRepository = claimsModule.WorkerRunRepository;
      RunDispatcher = dispatcherModule.RunDispatcher;
      WorkerRunner = runnerModule.WorkerRunner;
      HarnessAdapterError = adapterModule.HarnessAdapterError;
      PersistenceNotFoundError = errorsModule.PersistenceNotFoundError;
    });

    after(async () => {
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
      'a mid-stream cancel stops the Run once and settles the hold once',
      { timeout: 40000 },
      async () => {
        const owner = await seedUser();
        const { runId } = await seedRun(owner);
        const reservation = await reserve(owner, runId);
        assert.equal(reservation.state, 'reserved');

        const stub = createStubAdapter();
        const { runner } = createRunner(stub);
        const api = apiService();

        try {
          await runner.start();
          await waitRunning(stub, runId);

          const accepted = await api.cancelRun(owner, runId);

          assert.equal(accepted.status, 'running');
          assert.equal(typeof accepted.cancelRequestedAt, 'string');
          assert.equal(accepted.cancelErrorCode, null);

          // Repeated HTTP requests while the worker has not observed the intent
          // reuse the same request marker. The worker may already have won the
          // race, so either the live or the terminal projection is valid here.
          const repeated = await api.cancelRun(owner, runId);
          assert.ok(['running', 'cancelled'].includes(repeated.status));
          assert.equal(
            repeated.cancelRequestedAt,
            accepted.cancelRequestedAt,
          );

          const cancelled = await waitFor(async () => {
            const row = await readRun(runId);
            return row?.status === 'cancelled' ? row : null;
          }, 'the cancelled Run');

          assert.equal(cancelled.dispatch_state, 'dispatched');
          assert.ok(cancelled.finished_at instanceof Date);
          assert.equal(
            stub.state.cancelCalls.filter((call) => call.runId === runId).length,
            1,
          );
          assert.equal(
            stub.state.cancelCalls.find((call) => call.runId === runId)?.reason,
            'user',
          );

          // The terminal row commits before its events; wait for the side effect.
          await waitFor(
            async () => (await terminalEventCount(runId)) === 1,
            'one terminal event',
          );

          const events = await readEvents(runId);
          assert.equal(events.at(-1)?.type, 'run.cancelled');
          assert.equal(await terminalEventCount(runId), 1);

          const settled = await readReservation(runId);
          assert.equal(settled.state, 'settled');
          assert.equal(Number(settled.charged_tokens), 15);

          // A cancel request after the fact is a no-op success.
          const afterTerminal = await api.cancelRun(owner, runId);
          assert.equal(afterTerminal.status, 'cancelled');
          assert.equal(
            afterTerminal.finishedAt,
            new Date(cancelled.finished_at).toISOString(),
          );

          await sleep(400);
          assert.equal(
            stub.state.cancelCalls.filter((call) => call.runId === runId).length,
            1,
            'no second adapter cancel',
          );
          assert.equal(await terminalEventCount(runId), 1, 'one terminal event');
          assert.equal((await readReservation(runId)).state, 'settled');
        } finally {
          await runner.stop();
        }
      },
    );

    test(
      'the intent survives an API process restart before the worker observes it',
      { timeout: 40000 },
      async () => {
        const owner = await seedUser();
        const { runId } = await seedRun(owner);
        await reserve(owner, runId);

        const stub = createStubAdapter();
        const { runner } = createRunner(stub);

        // A second pool stands in for the separate API process. Closing it before
        // the worker acts proves the marker is durable, not in-memory.
        const apiPool = new Pool({ connectionString: databaseUrl, max: 1 });
        const api = apiService(apiPool);

        try {
          await runner.start();
          await waitRunning(stub, runId);

          const accepted = await api.cancelRun(owner, runId);
          assert.equal(accepted.status, 'running');
          assert.equal(typeof accepted.cancelRequestedAt, 'string');

          await apiPool.end();

          const cancelled = await waitFor(async () => {
            const row = await readRun(runId);
            return row?.status === 'cancelled' ? row : null;
          }, 'the cancelled Run after the API pool closed');

          assert.equal(cancelled.dispatch_state, 'dispatched');
          assert.equal(
            stub.state.cancelCalls.filter((call) => call.runId === runId).length,
            1,
          );

          await waitFor(
            async () => (await terminalEventCount(runId)) === 1,
            'one terminal event after the restarted API',
          );
        } finally {
          await apiPool.end().catch(() => {});
          await runner.stop();
        }
      },
    );

    test(
      'a failed adapter cancel is recoverable and never reported cancelled',
      { timeout: 40000 },
      async () => {
        const owner = await seedUser();
        const { runId } = await seedRun(owner);
        await reserve(owner, runId);

        let attempts = 0;
        const stub = createStubAdapter({
          cancelImpl: (request) => {
            attempts += 1;

            if (attempts === 1) {
              throw new HarnessAdapterError('harness_unavailable', 'dispatched');
            }

            return {
              runId: request.runId,
              status: 'cancelled',
              dispatchState: 'dispatched',
            };
          },
        });
        const { runner } = createRunner(stub);
        const api = apiService();

        try {
          await runner.start();
          await waitRunning(stub, runId);

          const accepted = await api.cancelRun(owner, runId);
          assert.equal(accepted.status, 'running');

          const failed = await waitFor(async () => {
            const row = await readRun(runId);

            return row?.cancel_error_code === 'harness_unavailable' &&
              row.status === 'running'
              ? row
              : null;
          }, 'the recorded cancel failure');

          assert.equal(failed.status, 'running');
          assert.ok(failed.cancel_attempts >= 1);
          assert.equal(await terminalEventCount(runId), 0, 'not a false cancel');

          // The worker retries within the bound; the second attempt succeeds.
          const cancelled = await waitFor(async () => {
            const row = await readRun(runId);
            return row?.status === 'cancelled' ? row : null;
          }, 'the Run cancelled after a retry');

          assert.equal(cancelled.dispatch_state, 'dispatched');
          assert.equal(
            stub.state.cancelCalls.filter((call) => call.runId === runId).length,
            2,
          );

          await waitFor(
            async () => (await terminalEventCount(runId)) === 1,
            'one terminal event after the recovered cancel',
          );

          assert.equal((await readReservation(runId)).state, 'settled');
        } finally {
          await runner.stop();
        }
      },
    );

    test(
      'cancel attempts are bounded when the harness stays unreachable',
      { timeout: 40000 },
      async () => {
        const owner = await seedUser();
        const { runId } = await seedRun(owner);
        await reserve(owner, runId);

        const stub = createStubAdapter({
          cancelImpl: () => {
            throw new HarnessAdapterError('harness_unavailable', 'dispatched');
          },
        });
        const { runner } = createRunner(stub);
        const api = apiService();

        try {
          await runner.start();
          await waitRunning(stub, runId);

          await api.cancelRun(owner, runId);

          const exhausted = await waitFor(async () => {
            const row = await readRun(runId);

            return row?.status === 'execution_uncertain' &&
              row.cancel_attempts >= MAX_CANCEL_ATTEMPTS
              ? row
              : null;
          }, 'the bounded cancel outcome');

          assert.equal(exhausted.dispatch_state, 'dispatched');
          assert.equal(exhausted.error_code, 'harness_unavailable');
          assert.equal(exhausted.cancel_error_code, 'harness_unavailable');
          assert.equal(
            stub.state.cancelCalls.filter((call) => call.runId === runId).length,
            MAX_CANCEL_ATTEMPTS,
          );

          await waitFor(
            async () => (await terminalEventCount(runId)) === 1,
            'one terminal event for the unconfirmed stop',
          );

          // The Run is never reported cancelled; the hold is settled from the
          // honest terminal accounting rather than left dangling.
          assert.equal((await readReservation(runId)).state, 'settled');

          await sleep(700);
          assert.equal(
            stub.state.cancelCalls.filter((call) => call.runId === runId).length,
            MAX_CANCEL_ATTEMPTS,
            'the retry bound stops further adapter calls',
          );
          assert.equal(await terminalEventCount(runId), 1);

          // The API reports the honest state, not a fabricated cancellation.
          const state = await api.cancelRun(owner, runId);
          assert.equal(state.status, 'execution_uncertain');
          assert.equal(state.cancelErrorCode, 'harness_unavailable');
        } finally {
          await runner.stop();
        }
      },
    );

    test(
      'cancel of an already-finished Run is a no-op success',
      { timeout: 20000 },
      async () => {
        const owner = await seedUser();
        const { runId } = await seedRun(owner, {
          status: 'completed',
          dispatchState: 'dispatched',
        });
        const before = await readRun(runId);
        const stub = createStubAdapter();
        const api = apiService();

        const result = await api.cancelRun(owner, runId);

        assert.equal(result.status, 'completed');
        assert.equal(result.finishedAt, before.finished_at.toISOString());
        assert.equal(result.cancelRequestedAt, null);
        assert.equal(stub.state.cancelCalls.length, 0);

        const afterCancel = await readRun(runId);
        assert.equal(afterCancel.cancel_requested_at, null);
        assert.equal(afterCancel.status, 'completed');
      },
    );

    test(
      'cancel from another user is the existing non-enumerating not-found',
      { timeout: 20000 },
      async () => {
        const owner = await seedUser();
        const other = await seedUser();
        const { runId } = await seedRun(owner);
        const api = apiService();

        await assert.rejects(
          () => api.cancelRun(other, runId),
          (error) => {
            assert.ok(error instanceof PersistenceNotFoundError);
            assert.equal(error.code, 'not_found');
            return true;
          },
        );

        const stored = await readRun(runId);
        assert.equal(stored.cancel_requested_at, null);
        assert.equal(stored.status, 'queued');

        // The Run is still claimable; remove it so later worker tests in this
        // container do not dispatch an unrelated fixture.
        await pool.query('DELETE FROM runs WHERE id = $1', [runId]);
      },
    );

    test(
      'cancel before dispatch is immediate and releases the hold once',
      { timeout: 20000 },
      async () => {
        const owner = await seedUser();
        const { runId } = await seedRun(owner);
        await reserve(owner, runId);

        const stub = createStubAdapter();
        const api = apiService();

        const cancelled = await api.cancelRun(owner, runId);

        assert.equal(cancelled.status, 'cancelled');
        assert.equal(cancelled.dispatchState, 'not_dispatched');
        assert.equal(typeof cancelled.finishedAt, 'string');
        assert.equal(stub.state.cancelCalls.length, 0);
        assert.equal(stub.state.createCalls.length, 0);

        const released = await readReservation(runId);
        assert.equal(released.state, 'released');
        assert.equal(Number(released.charged_tokens), 0);

        const repeated = await api.cancelRun(owner, runId);
        assert.equal(repeated.status, 'cancelled');
        assert.equal(repeated.finishedAt, cancelled.finishedAt);
        assert.equal((await readReservation(runId)).state, 'released');
        assert.equal(await terminalEventCount(runId), 0);
      },
    );

    test(
      'an orphaned queued intent is cancelled by the idle worker sweep',
      { timeout: 30000 },
      async () => {
        const owner = await seedUser();
        const { runId } = await seedRun(owner);
        await reserve(owner, runId);

        // Simulates an API process that committed the intent and died before it
        // could terminalize an undispatched Run.
        const runs = new RunRepository(pool);
        const requested = await runs.requestCancel(runId, owner, 'user');
        assert.ok(requested !== null);

        const stub = createStubAdapter();
        const { runner } = createRunner(stub);

        try {
          await runner.start();

          const cancelled = await waitFor(async () => {
            const row = await readRun(runId);
            return row?.status === 'cancelled' ? row : null;
          }, 'the sweep to cancel the orphaned intent');

          assert.equal(cancelled.dispatch_state, 'not_dispatched');
          assert.equal(
            stub.state.createCalls.filter((call) => call.runId === runId).length,
            0,
          );
          assert.equal(
            stub.state.cancelCalls.filter((call) => call.runId === runId).length,
            0,
          );

          // The hold is released before the terminal event is appended.
          await waitFor(
            async () => (await terminalEventCount(runId)) === 1,
            'one terminal event from the sweep',
          );

          assert.equal((await readReservation(runId)).state, 'released');

          const events = await readEvents(runId);
          assert.equal(events.at(-1)?.type, 'run.cancelled');
        } finally {
          await runner.stop();
        }
      },
    );
  },
);
