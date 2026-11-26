/**
 * H-013 (#13) queue-health aggregate: real PostgreSQL behaviour.
 *
 * The wiring suite covers the failure path and the gauge call with doubles.
 * This one runs the actual `QUEUE_HEALTH` SQL against a migrated database,
 * because the interesting failure mode of a new aggregate is not the
 * TypeScript around it — it is the predicate disagreeing with the claim
 * query, or the age arithmetic reporting a bucket that is not waiting work.
 *
 * Asserts:
 *   - an empty table reports zero depth and a null age, not a zero age (the
 *     difference matters: a zero age reads as "just arrived");
 *   - depth counts exactly what `claimBatch` could select — queued and
 *     `not_dispatched` — and excludes running, terminal, dispatched, and
 *     cancel-requested rows;
 *   - age is measured from the oldest claimable row only;
 *   - a queued Run that gains a cancel intent drops out of the gauge.
 *
 * Skips when Docker is unavailable, like the other Postgres suites.
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
const CASE_TIMEOUT_MS = 60_000;

function dockerAvailable() {
  const result = spawnSync('docker', ['info'], {
    stdio: 'ignore',
    timeout: 5000,
  });

  return result.status === 0;
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

async function waitForDatabase(pool, containerName) {
  const deadline = Date.now() + 60_000;
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
    timeout: 10_000,
  });

  throw new Error(
    `PostgreSQL did not become ready: ${lastError?.message ?? 'unknown error'}\n${logs.stdout ?? ''}\n${logs.stderr ?? ''}`,
  );
}

const dockerReady = dockerAvailable();

describe(
  'H-013 queue health aggregate',
  { skip: dockerReady ? false : 'Docker daemon is unavailable' },
  () => {
    let containerName = '';
    let password = '';
    let databaseUrl = '';
    let pool;
    let WorkerRunRepository;

    async function seedOwner() {
      const id = randomUUID();
      await pool.query('INSERT INTO users (id) VALUES ($1)', [id]);
      return id;
    }

    async function seedConversation(owner) {
      const botId = randomUUID();
      const conversationId = randomUUID();

      await pool.query(
        `INSERT INTO bots (id, owner_user_id, name) VALUES ($1, $2, 'Queue Bot')`,
        [botId, owner],
      );
      await pool.query(
        `INSERT INTO conversations (id, owner_user_id, bot_id, title)
         VALUES ($1, $2, $3, 'Queue Conversation')`,
        [conversationId, owner, botId],
      );

      return conversationId;
    }

    /** Seeds one Run with an explicit status/dispatch state and created_at. */
    async function seedRun(owner, conversationId, options = {}) {
      const id = randomUUID();
      const status = options.status ?? 'queued';
      const dispatchState = options.dispatchState ?? 'not_dispatched';
      const cancelRequested = options.cancelRequested === true;
      const ageSeconds = options.ageSeconds ?? 0;

      // The schema ties `finished_at` to a terminal status, so a seeded
      // terminal row must carry it or the insert is rejected.
      const terminal = [
        'completed',
        'failed',
        'cancelled',
        'timed_out',
        'execution_uncertain',
      ].includes(status);

      await pool.query(
        `INSERT INTO runs (id, owner_user_id, conversation_id, status,
                           dispatch_state, created_at, cancel_requested_at,
                           cancel_reason, finished_at)
         VALUES ($1, $2, $3, $4, $5, now() - ($6 || ' seconds')::interval,
                 CASE WHEN $7 THEN now() ELSE NULL END,
                 CASE WHEN $7 THEN 'user' ELSE NULL END,
                 CASE WHEN $8 THEN now() ELSE NULL END)`,
        [
          id,
          owner,
          conversationId,
          status,
          dispatchState,
          String(ageSeconds),
          cancelRequested,
          terminal,
        ],
      );

      return id;
    }

    /**
     * Each case asserts an absolute depth, so it must start from an empty
     * `runs` table rather than inheriting the previous case's rows.
     */
    async function resetRuns() {
      await pool.query('DELETE FROM runs');
    }

    before(
      async () => {
        containerName = `habi-h013-queue-${randomBytes(6).toString('hex')}`;
        password = randomBytes(18).toString('base64url');
        const port = await getFreePort();

        databaseUrl = `postgresql://${DOCKER_USER}:${password}@127.0.0.1:${port}/${DOCKER_DATABASE}`;

        const run = spawnSync(
          'docker',
          [
            'run',
            '--detach',
            '--name',
            containerName,
            '--publish',
            `127.0.0.1:${port}:5432`,
            '--env',
            `POSTGRES_USER=${DOCKER_USER}`,
            '--env',
            `POSTGRES_PASSWORD=${password}`,
            '--env',
            `POSTGRES_DB=${DOCKER_DATABASE}`,
            POSTGRES_IMAGE,
          ],
          { encoding: 'utf8', timeout: 60_000 },
        );

        assert.equal(
          run.status,
          0,
          `docker run failed: ${run.stderr ?? ''}`,
        );

        pool = new Pool({ connectionString: databaseUrl, max: 4 });
        await waitForDatabase(pool, containerName);

        const migration = spawnSync(
          process.execPath,
          [MIGRATE_SCRIPT, '--database-url', databaseUrl],
          { cwd: REPOSITORY_ROOT, encoding: 'utf8', timeout: 120_000 },
        );

        assert.equal(
          migration.status,
          0,
          `migration failed: ${migration.stdout ?? ''}${migration.stderr ?? ''}`,
        );

        const module = await import('../dist/worker/run-claim-repository.js');
        WorkerRunRepository = module.WorkerRunRepository;
      },
      { timeout: CASE_TIMEOUT_MS },
    );

    after(async () => {
      await pool?.end().catch(() => {});

      if (containerName !== '') {
        spawnSync('docker', ['rm', '--force', containerName], {
          stdio: 'ignore',
          timeout: 30_000,
        });
      }
    });

    test(
      'an empty queue reports zero depth and a null age',
      { timeout: CASE_TIMEOUT_MS },
      async () => {
        await resetRuns();
        const repository = new WorkerRunRepository(pool);
        const health = await repository.readQueueHealth();

        assert.equal(health.depth, 0);
        // Null, not zero: a zero age would read as "a Run just arrived".
        assert.equal(health.oldestAgeMs, null);
      },
    );

    test(
      'depth counts only what the claim query could select',
      { timeout: CASE_TIMEOUT_MS },
      async () => {
        await resetRuns();
        const owner = await seedOwner();
        const conversation = await seedConversation(owner);

        // Claimable: two queued/not_dispatched rows.
        await seedRun(owner, conversation, { ageSeconds: 120 });
        await seedRun(owner, conversation, { ageSeconds: 30 });

        // Not claimable, for one distinct reason each.
        await seedRun(owner, conversation, { status: 'running', dispatchState: 'unknown' });
        await seedRun(owner, conversation, { status: 'completed', dispatchState: 'unknown' });
        await seedRun(owner, conversation, { dispatchState: 'unknown' });
        await seedRun(owner, conversation, { cancelRequested: true });

        const repository = new WorkerRunRepository(pool);
        const health = await repository.readQueueHealth();

        assert.equal(health.depth, 2);

        // Age is the oldest claimable row (120 s), never the newest.
        assert.ok(
          health.oldestAgeMs >= 120_000 && health.oldestAgeMs < 180_000,
          `expected ~120000 ms, got ${health.oldestAgeMs}`,
        );

        // The gauge and the claim must agree, which is the point of sharing a
        // predicate: the number of claimable rows is the reported depth.
        const claimed = await repository.claimBatch(10);
        assert.equal(claimed.length, 2);
      },
    );

    test(
      'a cancel intent removes a queued Run from the gauge',
      { timeout: CASE_TIMEOUT_MS },
      async () => {
        await resetRuns();
        const owner = await seedOwner();
        const conversation = await seedConversation(owner);
        const runId = await seedRun(owner, conversation, { ageSeconds: 10 });

        const repository = new WorkerRunRepository(pool);

        const beforeCancel = await repository.readQueueHealth();
        assert.equal(beforeCancel.depth, 1);

        // The schema ties `cancel_requested_at` to a non-null reason, so a
        // real intent is written as the pair it actually is.
        await pool.query(
          `UPDATE runs
              SET cancel_requested_at = now(), cancel_reason = 'user'
            WHERE id = $1`,
          [runId],
        );

        const afterCancel = await repository.readQueueHealth();
        assert.equal(afterCancel.depth, 0);
        assert.equal(afterCancel.oldestAgeMs, null);
      },
    );
  },
);
