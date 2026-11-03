/**
 * H-022 (#22) durable run controller integration smoke tests.
 *
 * Starts an ephemeral PostgreSQL 18.6 container on a random loopback port,
 * applies the real migrations (0001-0005), and drives RunService against a
 * stub HarnessAdapter. No Hermes process, provider network, credential, or
 * queue is involved. Docker unavailability skips the suite; the container and
 * pool are removed afterwards.
 *
 * Coverage:
 *   duplicate submit             same key + body -> same run, one dispatch
 *   conflicting body             same key + different body -> conflict, no row
 *   owner isolation              foreign/guessed/malformed ids are not found
 *   ambiguous dispatch           unknown -> execution_uncertain, zero retries
 *   cancellation                 idempotent, terminal, adapter cancel stopped
 *   restart reconciliation       terminal / still-running / lost outcomes
 *   usage mapping                known / partial / unknown; unknown is null, not 0
 *   crash shape                  dispatched with no terminal -> lost, no retry
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
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    {
      cwd: REPOSITORY_ROOT,
      encoding: 'utf8',
      timeout: 60000,
    },
  );
}

function dryRun(databaseUrl) {
  return spawnSync(
    process.execPath,
    [MIGRATE_SCRIPT, '--database-url', databaseUrl, '--dry-run'],
    {
      cwd: REPOSITORY_ROOT,
      encoding: 'utf8',
      timeout: 60000,
    },
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rejectsWithCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    return true;
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

function usageRecord(overrides = {}) {
  return {
    runId: 'run-placeholder',
    usageStatus: 'unknown',
    grossPromptTokens: null,
    grossCompletionTokens: null,
    cachedPromptTokens: null,
    reasoningTokens: null,
    totalTokens: null,
    costStatus: 'unknown',
    raw: {},
    ...overrides,
  };
}

function snapshot(runId, status, lastSeq = 0, harnessStatus = status) {
  return {
    runId,
    status,
    harnessStatus,
    lastSeq,
    version: 1,
  };
}

/**
 * Contract-compliant stub adapter. Tests override the `impl` hooks per case and
 * inspect the recorded calls to prove dispatch/retry/cancel behavior.
 */
function createStubAdapter() {
  const state = {
    createCalls: [],
    cancelCalls: [],
    usageCalls: [],
    recoverCalls: [],
    createImpl: (request) => ({
      runId: request.runId,
      harnessSessionId: `sess-${request.runId}`,
      harnessRunId: `harness-${request.runId}`,
      dispatchState: 'dispatched',
      deduplicated: false,
      acceptedAt: new Date().toISOString(),
    }),
    cancelImpl: (request) => ({
      runId: request.runId,
      status: 'cancelled',
      dispatchState: 'dispatched',
    }),
    usageImpl: () => usageRecord(),
    recoveryImpl: () => {
      throw new Error('recoveryImpl was not configured');
    },
  };

  return {
    state,
    get createCallCount() {
      return state.createCalls.length;
    },
    get cancelCallCount() {
      return state.cancelCalls.length;
    },
    async createRun(request) {
      state.createCalls.push(request);
      return state.createImpl(request);
    },
    subscribe() {
      return (async function* emptyStream() {})();
    },
    async cancel(request) {
      state.cancelCalls.push(request);
      return state.cancelImpl(request);
    },
    async steer() {
      return { accepted: false, reason: 'not_running' };
    },
    async getRun(runId) {
      return snapshot(runId, 'running');
    },
    async getUsage(runId) {
      state.usageCalls.push(runId);
      return state.usageImpl(runId);
    },
    async recoverAfterRestart(input) {
      state.recoverCalls.push(input);
      return {
        recoveredAt: new Date().toISOString(),
        outcomes: state.recoveryImpl(input),
      };
    },
    async close() {},
  };
}

const dockerReady = dockerAvailable();

describe(
  'H-022 durable run controller',
  { skip: dockerReady ? false : 'Docker daemon is unavailable' },
  () => {
    let containerName = '';
    let port = 0;
    let password = '';
    let pool;
    let runs;
    let stub;
    let HarnessAdapterError;
    let databaseUrl = '';
    let userA;
    let userB;

    async function seedConversation(ownerUserId) {
      const botId = randomUUID();
      const conversationId = randomUUID();

      await pool.query(
        `INSERT INTO bots (id, owner_user_id, name)
         VALUES ($1, $2, 'Run Controller Bot')`,
        [botId, ownerUserId],
      );
      await pool.query(
        `INSERT INTO conversations (id, owner_user_id, bot_id, title)
         VALUES ($1, $2, $3, 'Run Controller Conversation')`,
        [conversationId, ownerUserId, botId],
      );

      return { botId, conversationId };
    }

    async function seedUser() {
      const id = randomUUID();
      await pool.query('INSERT INTO users (id) VALUES ($1)', [id]);
      return id;
    }

    function createInput(ownerUserId, conversationId, idempotencyKey, content = 'hello') {
      return {
        ownerUserId,
        conversationId,
        idempotencyKey,
        messages: [
          {
            role: 'user',
            content,
            messageId: randomUUID(),
          },
        ],
      };
    }

    before(async () => {
      containerName = `habi-h022-${randomBytes(6).toString('hex')}`;
      password = randomBytes(24).toString('hex');

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

      const pending = dryRun(databaseUrl);
      assert.equal(pending.status, 0, pending.stderr);
      assert.match(pending.stdout, /pending\s+0005_run_lifecycle\.sql/);

      const applied = migrate(databaseUrl);
      assert.equal(applied.status, 0, applied.stderr);
      assert.match(applied.stdout, /applied\s+0001_conversations\.sql/);
      assert.match(applied.stdout, /applied\s+0002_runs\.sql/);
      assert.match(applied.stdout, /applied\s+0003_messages\.sql/);
      assert.match(applied.stdout, /applied\s+0004_bot_profiles\.sql/);
      assert.match(applied.stdout, /applied\s+0005_run_lifecycle\.sql/);

      const upToDate = migrate(databaseUrl);
      assert.equal(upToDate.status, 0, upToDate.stderr);
      assert.match(upToDate.stdout, /up to date/);

      const adapterModule = await import('../dist/adapters/harness-adapter.js');
      const runsModule = await import('../dist/runs/index.js');
      HarnessAdapterError = adapterModule.HarnessAdapterError;
      stub = createStubAdapter();
      runs = new runsModule.RunService(pool, stub);

      userA = await seedUser();
      userB = await seedUser();
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

    test('migration extends the runs stub without dropping linkage columns', async () => {
      const columns = await pool.query(
        `SELECT column_name
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'runs'`,
      );
      const names = new Set(columns.rows.map((row) => row.column_name));

      for (const required of [
        'id',
        'owner_user_id',
        'conversation_id',
        'status',
        'created_at',
        'updated_at',
        'idempotency_key',
        'request_fingerprint',
        'dispatch_state',
        'harness_run_id',
        'harness_session_id',
        'error_code',
        'usage_status',
        'usage_gross_prompt_tokens',
        'usage_gross_completion_tokens',
        'usage_cached_prompt_tokens',
        'usage_reasoning_tokens',
        'usage_total_tokens',
        'usage_cost_status',
        'usage_raw',
        'started_at',
        'finished_at',
        'last_event_seq',
      ]) {
        assert.ok(names.has(required), `runs.${required} is missing`);
      }

      const constraints = await pool.query(
        `SELECT conname AS constraint_name
           FROM pg_constraint
          WHERE conrelid = 'runs'::regclass`,
      );
      const constraintNames = new Set(
        constraints.rows.map((row) => row.constraint_name),
      );
      assert.ok(constraintNames.has('runs_owner_idempotency_key'));
      assert.ok(constraintNames.has('runs_finished_at_matches_terminal'));
      assert.ok(constraintNames.has('runs_conversation_owner_fk'));

      const indexes = await pool.query(
        `SELECT indexname FROM pg_indexes
          WHERE schemaname = 'public' AND tablename = 'runs'`,
      );
      const indexNames = new Set(indexes.rows.map((row) => row.indexname));
      assert.ok(indexNames.has('runs_owner_status_idx'));
      assert.ok(indexNames.has('runs_status_updated_idx'));
      assert.ok(indexNames.has('runs_owner_created_id_idx'));
    });

    test('duplicate submit returns one run and dispatches once', async () => {
      const { conversationId } = await seedConversation(userA);
      const key = `duplicate-${randomUUID()}`;
      const input = createInput(userA, conversationId, key);
      const beforeCount = stub.createCallCount;

      const first = await runs.createRun(input);

      assert.equal(first.deduplicated, false);
      assert.match(first.run.id, UUID_PATTERN);
      assert.equal(first.run.status, 'running');
      assert.equal(first.run.dispatchState, 'dispatched');
      assert.equal(stub.createCallCount, beforeCount + 1);

      const second = await runs.createRun(input);

      assert.equal(second.deduplicated, true);
      assert.equal(second.run.id, first.run.id);
      assert.equal(second.run.status, 'running');
      assert.equal(stub.createCallCount, beforeCount + 1);

      const rows = await pool.query(
        `SELECT count(*)::int AS count
           FROM runs
          WHERE owner_user_id = $1 AND idempotency_key = $2`,
        [userA, key],
      );
      assert.equal(rows.rows[0].count, 1);
    });

    test('concurrent duplicate submits still dispatch once', async () => {
      const { conversationId } = await seedConversation(userA);
      const key = `concurrent-${randomUUID()}`;
      const input = createInput(userA, conversationId, key);
      const beforeCount = stub.createCallCount;

      const [left, right] = await Promise.all([
        runs.createRun(input),
        runs.createRun(input),
      ]);

      assert.equal(left.run.id, right.run.id);
      assert.equal(
        [left, right].filter((outcome) => outcome.deduplicated === false).length,
        1,
        'exactly one submitter owns the dispatch',
      );
      assert.equal(stub.createCallCount, beforeCount + 1);

      const rows = await pool.query(
        `SELECT count(*)::int AS count
           FROM runs
          WHERE owner_user_id = $1 AND idempotency_key = $2`,
        [userA, key],
      );
      assert.equal(rows.rows[0].count, 1);
    });

    test('same key with a different body conflicts and creates nothing', async () => {
      const { conversationId } = await seedConversation(userA);
      const key = `conflict-${randomUUID()}`;
      const input = createInput(userA, conversationId, key, 'original body');
      const beforeCount = stub.createCallCount;

      const original = await runs.createRun(input);
      assert.equal(original.deduplicated, false);

      await rejectsWithCode(
        runs.createRun(
          createInput(userA, conversationId, key, 'different body'),
        ),
        'idempotency_conflict',
      );

      assert.equal(stub.createCallCount, beforeCount + 1);

      const rows = await pool.query(
        `SELECT count(*)::int AS count
           FROM runs
          WHERE owner_user_id = $1 AND idempotency_key = $2`,
        [userA, key],
      );
      assert.equal(rows.rows[0].count, 1);

      const stored = await runs.getRun(userA, original.run.id);
      assert.equal(stored.status, 'running');
    });

    test('owner isolation hides foreign, guessed, and malformed run ids', async () => {
      const { conversationId } = await seedConversation(userA);
      const owned = await runs.createRun(
        createInput(userA, conversationId, `owner-${randomUUID()}`),
      );

      await rejectsWithCode(runs.getRun(userB, owned.run.id), 'not_found');
      await rejectsWithCode(runs.getRun(userA, randomUUID()), 'not_found');
      await rejectsWithCode(runs.getRun(userA, 'not-a-uuid'), 'not_found');
      await rejectsWithCode(runs.getRun('not-a-uuid', owned.run.id), 'not_found');
      await rejectsWithCode(
        runs.cancelRun(userB, owned.run.id, 'user'),
        'not_found',
      );

      const ownerScoped = await runs.recoverAfterRestart(userB);
      assert.deepEqual(ownerScoped.outcomes, []);

      const stillOwned = await runs.getRun(userA, owned.run.id);
      assert.equal(stillOwned.id, owned.run.id);
    });

    test('ambiguous dispatch becomes execution_uncertain with no retry', async () => {
      const { conversationId } = await seedConversation(userA);
      const key = `ambiguous-${randomUUID()}`;
      const input = createInput(userA, conversationId, key);
      const beforeCount = stub.createCallCount;
      const previousCreateImpl = stub.state.createImpl;

      stub.state.createImpl = () => {
        throw new HarnessAdapterError('transport_ambiguous', 'unknown');
      };

      try {
        const outcome = await runs.createRun(input);

        assert.equal(outcome.deduplicated, false);
        assert.equal(outcome.run.status, 'execution_uncertain');
        assert.equal(outcome.run.dispatchState, 'unknown');
        assert.equal(outcome.run.errorCode, 'transport_ambiguous');
        assert.ok(outcome.run.finishedAt !== null);
        assert.equal(stub.createCallCount, beforeCount + 1);

        // The same submit returns the terminal row; the adapter is not called
        // a second time, so ambiguous provider work is never retried.
        const duplicate = await runs.createRun(input);
        assert.equal(duplicate.deduplicated, true);
        assert.equal(duplicate.run.id, outcome.run.id);
        assert.equal(duplicate.run.status, 'execution_uncertain');
        assert.equal(stub.createCallCount, beforeCount + 1);
      } finally {
        stub.state.createImpl = previousCreateImpl;
      }
    });

    test('a proven not-dispatched failure is failed, not uncertain', async () => {
      const { conversationId } = await seedConversation(userA);
      const previousCreateImpl = stub.state.createImpl;

      stub.state.createImpl = () => {
        throw new HarnessAdapterError('auth_rejected', 'not_dispatched');
      };

      try {
        const outcome = await runs.createRun(
          createInput(userA, conversationId, `not-dispatched-${randomUUID()}`),
        );

        assert.equal(outcome.run.status, 'failed');
        assert.equal(outcome.run.dispatchState, 'not_dispatched');
        assert.equal(outcome.run.errorCode, 'auth_rejected');
        assert.equal(outcome.run.startedAt, null);
        assert.ok(outcome.run.finishedAt !== null);
        assert.equal(outcome.run.usage.status, 'unknown');
      } finally {
        stub.state.createImpl = previousCreateImpl;
      }
    });

    test('cancel is idempotent, terminal, and records adapter usage', async () => {
      const { conversationId } = await seedConversation(userA);
      const previousUsageImpl = stub.state.usageImpl;

      stub.state.usageImpl = () =>
        usageRecord({
          usageStatus: 'known',
          grossPromptTokens: 11,
          grossCompletionTokens: 7,
          cachedPromptTokens: 3,
          reasoningTokens: 2,
          totalTokens: 18,
          costStatus: 'known',
          raw: { vendor: 'stub' },
        });

      try {
        const created = await runs.createRun(
          createInput(userA, conversationId, `cancel-${randomUUID()}`),
        );
        const beforeCancel = stub.cancelCallCount;

        const first = await runs.cancelRun(userA, created.run.id, 'user');

        assert.equal(first.status, 'cancelled');
        assert.ok(first.finishedAt !== null);
        assert.equal(first.usage.status, 'known');
        assert.equal(first.usage.grossPromptTokens, 11);
        assert.equal(first.usage.grossCompletionTokens, 7);
        assert.equal(first.usage.cachedPromptTokens, 3);
        assert.equal(first.usage.reasoningTokens, 2);
        assert.equal(first.usage.totalTokens, 18);
        assert.equal(first.usage.costStatus, 'known');
        assert.equal(stub.cancelCallCount, beforeCancel + 1);

        const second = await runs.cancelRun(userA, created.run.id, 'user');

        assert.equal(second.status, 'cancelled');
        assert.equal(second.finishedAt, first.finishedAt);
        assert.equal(second.updatedAt, first.updatedAt);
        assert.equal(
          stub.cancelCallCount,
          beforeCancel + 1,
          'a terminal run is not cancelled again',
        );

        const stored = await runs.getRun(userA, created.run.id);
        assert.equal(stored.status, 'cancelled');
        assert.equal(stored.finishedAt, first.finishedAt);
      } finally {
        stub.state.usageImpl = previousUsageImpl;
      }
    });

    test('cancel before dispatch does not call the adapter and keeps usage unknown', async () => {
      const { conversationId } = await seedConversation(userA);
      const previousCreateImpl = stub.state.createImpl;

      stub.state.createImpl = (request) => ({
        runId: request.runId,
        harnessSessionId: null,
        harnessRunId: null,
        dispatchState: 'not_dispatched',
        deduplicated: false,
        acceptedAt: new Date().toISOString(),
      });

      try {
        const created = await runs.createRun(
          createInput(userA, conversationId, `queued-cancel-${randomUUID()}`),
        );
        assert.equal(created.run.status, 'queued');
        assert.equal(created.run.dispatchState, 'not_dispatched');

        const beforeCancel = stub.cancelCallCount;
        const cancelled = await runs.cancelRun(userA, created.run.id, 'user');

        assert.equal(cancelled.status, 'cancelled');
        assert.equal(cancelled.dispatchState, 'not_dispatched');
        assert.equal(cancelled.startedAt, null);
        assert.equal(cancelled.usage.status, 'unknown');
        assert.equal(cancelled.usage.grossPromptTokens, null);
        assert.equal(stub.cancelCallCount, beforeCancel);
      } finally {
        stub.state.createImpl = previousCreateImpl;
      }
    });

    test('recovery handles terminal, still-running, and lost runs', async () => {
      const owner = await seedUser();
      const { conversationId } = await seedConversation(owner);
      const previousUsageImpl = stub.state.usageImpl;

      stub.state.usageImpl = () =>
        usageRecord({
          usageStatus: 'known',
          grossPromptTokens: 20,
          grossCompletionTokens: 5,
          totalTokens: 25,
          costStatus: 'unknown',
          raw: { recovered: true },
        });

      const completed = await runs.createRun(
        createInput(owner, conversationId, `recover-completed-${randomUUID()}`),
      );
      const stillRunning = await runs.createRun(
        createInput(owner, conversationId, `recover-running-${randomUUID()}`),
      );
      const lost = await runs.createRun(
        createInput(owner, conversationId, `recover-lost-${randomUUID()}`),
      );
      const lostNotDispatched = await runs.createRun(
        createInput(owner, conversationId, `recover-lost-nd-${randomUUID()}`),
      );
      const createCallsBeforeRecovery = stub.createCallCount;

      stub.state.recoveryImpl = (input) =>
        input.runIds.map((runId) => {
          if (runId === completed.run.id) {
            return {
              kind: 'confirmed_terminal',
              runId,
              snapshot: snapshot(runId, 'completed', 4, 'completed'),
            };
          }

          if (runId === stillRunning.run.id) {
            return {
              kind: 'still_running',
              runId,
              snapshot: snapshot(runId, 'running', 9, 'running'),
              resumeAfterSeq: 7,
            };
          }

          if (runId === lostNotDispatched.run.id) {
            return { kind: 'lost', runId, dispatchState: 'not_dispatched' };
          }

          return { kind: 'lost', runId, dispatchState: 'unknown' };
        });

      try {
        const summary = await runs.recoverAfterRestart(owner);
        const byRun = new Map(
          summary.outcomes.map((outcome) => [outcome.runId, outcome]),
        );

        assert.deepEqual(byRun.get(completed.run.id), {
          runId: completed.run.id,
          outcome: 'confirmed_terminal',
          status: 'completed',
          lastEventSeq: 4,
        });
        assert.deepEqual(byRun.get(stillRunning.run.id), {
          runId: stillRunning.run.id,
          outcome: 'still_running',
          status: 'running',
          lastEventSeq: 9,
        });
        assert.equal(byRun.get(lost.run.id).status, 'execution_uncertain');
        assert.equal(
          byRun.get(lostNotDispatched.run.id).status,
          'execution_uncertain',
        );

        const completedRow = await runs.getRun(owner, completed.run.id);
        const runningRow = await runs.getRun(owner, stillRunning.run.id);
        const lostRow = await runs.getRun(owner, lost.run.id);
        const lostNotDispatchedRow = await runs.getRun(
          owner,
          lostNotDispatched.run.id,
        );

        assert.equal(completedRow.status, 'completed');
        assert.equal(completedRow.usage.status, 'known');
        assert.equal(completedRow.usage.grossPromptTokens, 20);
        assert.ok(completedRow.finishedAt !== null);

        assert.equal(runningRow.status, 'running');
        assert.equal(runningRow.lastEventSeq, 9);
        assert.equal(runningRow.finishedAt, null);

        assert.equal(lostRow.status, 'execution_uncertain');
        assert.equal(lostRow.dispatchState, 'unknown');
        assert.equal(lostRow.errorCode, 'transport_ambiguous');
        assert.ok(lostRow.finishedAt !== null);

        assert.equal(lostNotDispatchedRow.status, 'execution_uncertain');
        assert.equal(lostNotDispatchedRow.dispatchState, 'not_dispatched');

        assert.equal(
          stub.createCallCount,
          createCallsBeforeRecovery,
          'recovery never dispatches a new attempt',
        );

        // A second reconciliation sees only the still-running run. A stale
        // completed outcome must not rewrite the terminal row.
        const completedFinishedAt = completedRow.finishedAt;
        stub.state.recoveryImpl = (input) =>
          input.runIds.map((runId) => ({
            kind: 'still_running',
            runId,
            snapshot: snapshot(runId, 'running', 10, 'running'),
            resumeAfterSeq: 10,
          }));

        const second = await runs.recoverAfterRestart(owner);

        assert.deepEqual(
          second.outcomes.map((outcome) => outcome.runId),
          [stillRunning.run.id],
        );
        assert.equal(completedRow.finishedAt, completedFinishedAt);
        const completedAfter = await runs.getRun(owner, completed.run.id);
        assert.equal(completedAfter.finishedAt, completedFinishedAt);
        assert.equal(completedAfter.usage.grossPromptTokens, 20);
      } finally {
        stub.state.usageImpl = previousUsageImpl;
      }
    });

    test('lost run whose dispatched process never recorded a terminal is not retried', async () => {
      const owner = await seedUser();
      const { conversationId } = await seedConversation(owner);
      const created = await runs.createRun(
        createInput(owner, conversationId, `crash-${randomUUID()}`),
      );

      // Crash shape: the process dispatched and exited before any terminal row
      // was written. The row is running/dispatched with no finish time.
      const crashRow = await pool.query(
        `SELECT status, dispatch_state, finished_at
           FROM runs WHERE id = $1`,
        [created.run.id],
      );
      assert.equal(crashRow.rows[0].status, 'running');
      assert.equal(crashRow.rows[0].dispatch_state, 'dispatched');
      assert.equal(crashRow.rows[0].finished_at, null);

      const createCallsBeforeRecovery = stub.createCallCount;
      stub.state.recoveryImpl = (input) =>
        input.runIds.map((runId) => ({
          kind: 'lost',
          runId,
          dispatchState: 'unknown',
        }));

      const summary = await runs.recoverAfterRestart(owner);

      assert.deepEqual(summary.outcomes, [
        {
          runId: created.run.id,
          outcome: 'lost',
          status: 'execution_uncertain',
          lastEventSeq: 0,
        },
      ]);
      assert.equal(
        stub.createCallCount,
        createCallsBeforeRecovery,
        'no automatic retry after a crash',
      );

      const recovered = await runs.getRun(owner, created.run.id);
      assert.equal(recovered.status, 'execution_uncertain');
      assert.equal(recovered.dispatchState, 'unknown');
      assert.ok(recovered.finishedAt !== null);
    });

    test('unknown usage is stored as null, never zero', async () => {
      const owner = await seedUser();
      const { conversationId } = await seedConversation(owner);
      const previousUsageImpl = stub.state.usageImpl;

      stub.state.usageImpl = () =>
        usageRecord({
          // The adapter says unknown but also sends zeros; they must not be
          // persisted as a fabricated "no charge".
          grossPromptTokens: 0,
          grossCompletionTokens: 0,
          cachedPromptTokens: 0,
          reasoningTokens: 0,
          totalTokens: 0,
          costStatus: 'known',
          raw: { misleading: true },
        });

      try {
        const created = await runs.createRun(
          createInput(owner, conversationId, `usage-unknown-${randomUUID()}`),
        );
        const cancelled = await runs.cancelRun(owner, created.run.id, 'user');

        assert.equal(cancelled.usage.status, 'unknown');
        assert.equal(cancelled.usage.grossPromptTokens, null);
        assert.equal(cancelled.usage.grossCompletionTokens, null);
        assert.equal(cancelled.usage.cachedPromptTokens, null);
        assert.equal(cancelled.usage.reasoningTokens, null);
        assert.equal(cancelled.usage.totalTokens, null);
        assert.equal(cancelled.usage.costStatus, 'unknown');

        const stored = await pool.query(
          `SELECT usage_status, usage_gross_prompt_tokens,
                  usage_gross_completion_tokens, usage_total_tokens
             FROM runs WHERE id = $1`,
          [created.run.id],
        );
        assert.equal(stored.rows[0].usage_status, 'unknown');
        assert.equal(stored.rows[0].usage_gross_prompt_tokens, null);
        assert.equal(stored.rows[0].usage_gross_completion_tokens, null);
        assert.equal(stored.rows[0].usage_total_tokens, null);
      } finally {
        stub.state.usageImpl = previousUsageImpl;
      }
    });

    test('missing usage after cancel is unknown and partial usage stays partial', async () => {
      const owner = await seedUser();
      const { conversationId } = await seedConversation(owner);
      const previousUsageImpl = stub.state.usageImpl;

      try {
        stub.state.usageImpl = () => {
          throw new Error('usage route unavailable');
        };

        const missing = await runs.createRun(
          createInput(owner, conversationId, `usage-missing-${randomUUID()}`),
        );
        const cancelled = await runs.cancelRun(owner, missing.run.id, 'user');

        assert.equal(cancelled.usage.status, 'unknown');
        assert.equal(cancelled.usage.totalTokens, null);

        stub.state.usageImpl = () =>
          usageRecord({
            usageStatus: 'partial',
            grossPromptTokens: 13,
            grossCompletionTokens: null,
            totalTokens: 13,
            costStatus: 'unknown',
          });

        const partial = await runs.createRun(
          createInput(owner, conversationId, `usage-partial-${randomUUID()}`),
        );
        const partialCancelled = await runs.cancelRun(
          owner,
          partial.run.id,
          'user',
        );

        assert.equal(partialCancelled.usage.status, 'partial');
        assert.equal(partialCancelled.usage.grossPromptTokens, 13);
        assert.equal(partialCancelled.usage.grossCompletionTokens, null);
        assert.equal(partialCancelled.usage.totalTokens, 13);
        assert.equal(partialCancelled.usage.costStatus, 'unknown');
      } finally {
        stub.state.usageImpl = previousUsageImpl;
      }
    });
  },
);
