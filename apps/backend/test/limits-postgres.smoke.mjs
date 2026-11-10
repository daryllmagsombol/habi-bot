/**
 * H-023 (#23) daily allowance and run-creation rate-limit integration tests.
 *
 * Starts an ephemeral PostgreSQL 18.6 container on a random loopback port and
 * applies the real migrations (0001-0009). No provider, HTTP route, queue,
 * secret, or deployment is involved. Docker unavailability skips the suite; the
 * container and pool are removed afterwards.
 *
 * Coverage:
 *   schema guards             columns, unique-per-run key, non-negative and
 *                             state/value consistency constraints
 *   reservation atomicity     12 parallel reservations cannot exceed 100,000
 *   last-unit race            two concurrent reserves for the final unit admit
 *                             exactly one; the loser is 429 with no overspend
 *   boundary                  exactly 100,000 admitted, next unit refused;
 *                             settled usage counts toward the same cap, and a
 *                             refusal near Manila midnight retries in 1 s
 *   over-limit                an estimate above the cap writes nothing
 *   refusal shape             429 allowance_exhausted body carries limit,
 *                             remaining, and retryAfterSeconds; a release
 *                             frees the cap for a fresh full reservation
 *   unknown block             fail closed, then owner reconcile + audit
 *   accounting                known/partial/unknown mapping never zeroes
 *   overrun                   provider usage above the estimate is recorded
 *   release                   pre-dispatch failure frees the hold, idempotent
 *   day reset                 00:00 Asia/Manila with an injected clock
 *   cross-user isolation      buckets, reservations, and audit reads
 *   rate limit                uniform 429 metadata, window reset, bounded map
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
const ALLOWANCE = 100_000;

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

async function rejectsWithCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

async function rejectsWithPgCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

function knownUsage(overrides = {}) {
  return {
    status: 'known',
    grossPromptTokens: 600,
    grossCompletionTokens: 200,
    totalTokens: 800,
    cachedPromptTokens: null,
    reasoningTokens: null,
    ...overrides,
  };
}

const dockerReady = dockerAvailable();

describe(
  'H-023 usage limits',
  { skip: dockerReady ? false : 'Docker daemon is unavailable' },
  () => {
    let containerName = '';
    let port = 0;
    let password = '';
    let pool;
    let databaseUrl = '';
    let limits;
    let clock;
    let service;

    const at = (iso) => new Date(iso);

    async function seedUser() {
      const id = randomUUID();
      await pool.query('INSERT INTO users (id) VALUES ($1)', [id]);
      return id;
    }

    function serviceWithClock(now) {
      return new limits.UsageLimitService(pool, { now });
    }

    async function bucketRow(ownerUserId, dayBucket) {
      const result = await pool.query(
        `SELECT input_tokens, output_tokens, reserved_tokens, state
           FROM usage_buckets
          WHERE owner_user_id = $1 AND day_bucket = $2`,
        [ownerUserId, dayBucket],
      );

      return result.rows[0] ?? null;
    }

    async function reservationRows(ownerUserId) {
      const result = await pool.query(
        `SELECT id, run_id, estimated_tokens, charged_tokens, state,
                usage_status, settled_at, released_at, reconciled_at
           FROM usage_reservations
          WHERE owner_user_id = $1
          ORDER BY created_at ASC, id ASC`,
        [ownerUserId],
      );

      return result.rows;
    }

    before(async () => {
      containerName = `habi-h023-${randomBytes(6).toString('hex')}`;
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
        max: 20,
      });

      await waitForDatabase(pool, containerName);
      databaseUrl = `postgres://${DOCKER_USER}:${password}@127.0.0.1:${port}/${DOCKER_DATABASE}`;

      const applied = migrate(databaseUrl);
      assert.equal(applied.status, 0, applied.stderr);
      assert.match(applied.stdout, /applied\s+0009_usage_limits\.sql/);

      const upToDate = migrate(databaseUrl);
      assert.equal(upToDate.status, 0, upToDate.stderr);
      assert.match(upToDate.stdout, /up to date/);

      limits = await import('../dist/limits/index.js');
      clock = at('2026-11-03T02:00:00.000Z');
      service = serviceWithClock(() => clock);
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

    test('migration adds the allowance tables, keys, and consistency guards', async () => {
      const columns = await pool.query(
        `SELECT table_name, column_name
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name IN (
              'usage_buckets',
              'usage_reservations',
              'usage_limit_audit'
            )`,
      );
      const present = new Set(
        columns.rows.map((row) => `${row.table_name}.${row.column_name}`),
      );

      for (const required of [
        'usage_buckets.owner_user_id',
        'usage_buckets.day_bucket',
        'usage_buckets.input_tokens',
        'usage_buckets.output_tokens',
        'usage_buckets.reserved_tokens',
        'usage_buckets.state',
        'usage_buckets.updated_at',
        'usage_reservations.id',
        'usage_reservations.owner_user_id',
        'usage_reservations.run_id',
        'usage_reservations.estimated_tokens',
        'usage_reservations.charged_tokens',
        'usage_reservations.state',
        'usage_reservations.created_at',
        'usage_reservations.settled_at',
        'usage_reservations.released_at',
        'usage_limit_audit.owner_user_id',
        'usage_limit_audit.actor_user_id',
        'usage_limit_audit.tokens_delta',
        'usage_limit_audit.note',
      ]) {
        assert.ok(present.has(required), `${required} is missing`);
      }

      // `day_bucket` must be a plain date, not a timestamp: the day is resolved
      // once in Asia/Manila by the service.
      const dayBucket = await pool.query(
        `SELECT data_type
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'usage_buckets'
            AND column_name = 'day_bucket'`,
      );
      assert.equal(dayBucket.rows[0].data_type, 'date');

      const constraints = await pool.query(
        `SELECT conname AS constraint_name
           FROM pg_constraint
          WHERE conrelid IN (
            'usage_buckets'::regclass,
            'usage_reservations'::regclass
          )`,
      );
      const names = new Set(constraints.rows.map((row) => row.constraint_name));
      assert.ok(names.has('usage_buckets_pkey'));
      assert.ok(names.has('usage_buckets_state_matches_values'));
      assert.ok(names.has('usage_reservations_owner_run_key'));
      assert.ok(names.has('usage_reservations_state_matches_values'));
      assert.ok(names.has('usage_reservations_reconciliation_shape'));

      // Direct SQL cannot store impossible accounting.
      const owner = await seedUser();

      await rejectsWithPgCode(
        pool.query(
          `INSERT INTO usage_buckets (owner_user_id, day_bucket, input_tokens)
           VALUES ($1, '2026-11-03', -1)`,
          [owner],
        ),
        '23514',
      );
      await rejectsWithPgCode(
        pool.query(
          `INSERT INTO usage_buckets (owner_user_id, day_bucket, state)
           VALUES ($1, '2026-11-03', 'partial')`,
          [owner],
        ),
        '23514',
      );
      await rejectsWithPgCode(
        pool.query(
          `INSERT INTO usage_buckets (owner_user_id, day_bucket, state)
           VALUES ($1, '2026-11-03', 'unknown')`,
          [owner],
        ),
        '23514',
      );
    });

    test('reserves an upper bound and reuses it for a duplicate run id', async () => {
      const owner = await seedUser();
      const runId = randomUUID();

      const reserved = await service.reserve({
        ownerUserId: owner,
        runId,
        estimateTokens: 10_000,
      });

      assert.equal(reserved.state, 'reserved');
      assert.equal(reserved.estimatedTokens, 10_000);
      assert.equal(reserved.chargedTokens, 0);
      assert.match(reserved.id, /^[0-9a-f-]{36}$/);

      const duplicate = await service.reserve({
        ownerUserId: owner,
        runId,
        estimateTokens: 10_000,
      });
      assert.equal(duplicate.id, reserved.id, 'same run id reuses the reservation');

      const snapshot = await service.getUsage(owner);
      assert.equal(snapshot.usedTokens, 10_000);
      assert.equal(snapshot.reservedTokens, 10_000);
      assert.equal(snapshot.remainingTokens, 90_000);
      assert.equal(snapshot.state, 'known');
      assert.equal(snapshot.blocked, false);
      assert.equal(snapshot.dayBucket, '2026-11-03');

      const rows = await reservationRows(owner);
      assert.equal(rows.length, 1);
    });

    test('12 parallel reservations cannot jointly exceed the allowance', async () => {
      const owner = await seedUser();
      const estimates = Array.from({ length: 12 }, () => ({
        ownerUserId: owner,
        runId: randomUUID(),
        estimateTokens: 10_000,
      }));

      const outcomes = await Promise.allSettled(
        estimates.map((input) => service.reserve(input)),
      );
      const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
      const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');

      assert.equal(fulfilled.length, 10, 'exactly ten 10k reservations fit');
      assert.equal(rejected.length, 2);
      for (const outcome of rejected) {
        assert.equal(outcome.reason.code, 'allowance_exhausted');
      }

      const bucket = await bucketRow(owner, '2026-11-03');
      assert.equal(Number(bucket.reserved_tokens), ALLOWANCE);
      assert.equal(Number(bucket.input_tokens), 0);
      assert.equal(Number(bucket.output_tokens), 0);
      assert.equal(bucket.state, 'known');

      const rows = await reservationRows(owner);
      assert.equal(rows.length, 10);
      assert.ok(rows.every((row) => row.state === 'reserved'));
    });

    test('admits exactly 100,000 units and refuses the next one', async () => {
      const owner = await seedUser();

      const almost = await service.reserve({
        ownerUserId: owner,
        runId: randomUUID(),
        estimateTokens: 99_999,
      });
      assert.equal(almost.estimatedTokens, 99_999);
      assert.equal((await service.getUsage(owner)).remainingTokens, 1);

      const exact = await service.reserve({
        ownerUserId: owner,
        runId: randomUUID(),
        estimateTokens: 1,
      });
      assert.equal(exact.estimatedTokens, 1);

      const snapshot = await service.getUsage(owner);
      assert.equal(snapshot.usedTokens, ALLOWANCE);
      assert.equal(snapshot.remainingTokens, 0);

      await assert.rejects(
        service.reserve({
          ownerUserId: owner,
          runId: randomUUID(),
          estimateTokens: 1,
        }),
        (error) => {
          assert.equal(error.code, 'allowance_exhausted');
          assert.equal(error.status, 429);
          assert.equal(error.remaining, 0);
          assert.equal(error.limit, ALLOWANCE);
          assert.ok(error.retryAfterSeconds > 0);
          assert.ok(error.retryAfterSeconds <= 86_400);
          return true;
        },
      );
    });

    test('two concurrent reserves for the final unit admit exactly one', async () => {
      const owner = await seedUser();

      await service.reserve({
        ownerUserId: owner,
        runId: randomUUID(),
        estimateTokens: ALLOWANCE - 1,
      });

      const contenders = [
        { ownerUserId: owner, runId: randomUUID(), estimateTokens: 1 },
        { ownerUserId: owner, runId: randomUUID(), estimateTokens: 1 },
      ];
      const outcomes = await Promise.allSettled(
        contenders.map((input) => service.reserve(input)),
      );
      const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
      const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');

      assert.equal(fulfilled.length, 1, 'exactly one contender takes the last unit');
      assert.equal(rejected.length, 1);
      const refusal = rejected[0].reason;
      assert.equal(refusal.code, 'allowance_exhausted');
      assert.equal(refusal.status, 429);

      const bucket = await bucketRow(owner, '2026-11-03');
      assert.equal(Number(bucket.reserved_tokens), ALLOWANCE);
      assert.equal(Number(bucket.input_tokens) + Number(bucket.output_tokens), 0);

      const rows = await reservationRows(owner);
      assert.equal(rows.length, 2);
      assert.ok(rows.every((row) => row.state === 'reserved'));
      assert.equal((await service.getUsage(owner)).remainingTokens, 0);
    });

    test('a refusal just before the Manila reset retries in one second', async () => {
      const owner = await seedUser();
      const evening = serviceWithClock(() => at('2026-11-03T15:59:59.000Z'));

      await evening.reserve({
        ownerUserId: owner,
        runId: randomUUID(),
        estimateTokens: ALLOWANCE,
      });

      try {
        await evening.reserve({
          ownerUserId: owner,
          runId: randomUUID(),
          estimateTokens: 1,
        });
        assert.fail('the over-cap reserve should have been refused');
      } catch (error) {
        assert.equal(error.code, 'allowance_exhausted');
        assert.equal(error.status, 429);
        assert.equal(error.retryAfterSeconds, 1);

        const body = limits.usageLimitErrorBody(error);
        assert.equal(body.error.code, 'allowance_exhausted');
        assert.equal(body.error.limit, ALLOWANCE);
        assert.equal(body.error.remaining, 0);
        assert.equal(body.error.retryAfterSeconds, 1);
      }
    });

    test('releasing a hold restores the full allowance', async () => {
      const owner = await seedUser();

      const held = await service.reserve({
        ownerUserId: owner,
        runId: randomUUID(),
        estimateTokens: ALLOWANCE,
      });
      await rejectsWithCode(
        service.reserve({
          ownerUserId: owner,
          runId: randomUUID(),
          estimateTokens: 1,
        }),
        'allowance_exhausted',
      );

      const released = await service.release(held.id, { ownerUserId: owner });
      assert.equal(released.state, 'released');
      assert.equal((await service.getUsage(owner)).usedTokens, 0);

      const fresh = await service.reserve({
        ownerUserId: owner,
        runId: randomUUID(),
        estimateTokens: ALLOWANCE,
      });
      assert.equal(fresh.state, 'reserved');
      assert.equal((await service.getUsage(owner)).remainingTokens, 0);
    });

    test('an estimate above the whole allowance writes nothing', async () => {
      const owner = await seedUser();

      await rejectsWithCode(
        service.reserve({
          ownerUserId: owner,
          runId: randomUUID(),
          estimateTokens: ALLOWANCE + 1,
        }),
        'allowance_exhausted',
      );

      assert.deepEqual(await reservationRows(owner), []);
      assert.equal((await service.getUsage(owner)).usedTokens, 0);
    });

    test('unknown usage blocks the bucket until the owner reconciles it', async () => {
      const owner = await seedUser();
      const other = await seedUser();

      const reserved = await service.reserve({
        ownerUserId: owner,
        runId: randomUUID(),
        estimateTokens: 5_000,
      });

      // A provider that answers "unknown" with zero-looking counters is still
      // unknown, and the full estimate stays held.
      const settlement = await service.settle(
        reserved.id,
        { status: 'unknown', grossPromptTokens: 0, grossCompletionTokens: 0 },
        { ownerUserId: owner },
      );
      assert.equal(settlement.state, 'unknown');
      assert.equal(settlement.usageStatus, 'unknown');
      assert.equal(settlement.chargedTokens, 5_000);

      const blocked = await service.getUsage(owner);
      assert.equal(blocked.state, 'unknown');
      assert.equal(blocked.blocked, true);
      assert.equal(blocked.usedTokens, 5_000, 'unknown is held, never counted as zero');

      await rejectsWithCode(
        service.reserve({
          ownerUserId: owner,
          runId: randomUUID(),
          estimateTokens: 1,
        }),
        'usage_unknown',
      );

      // Only the owner may reconcile, and a note is mandatory.
      await rejectsWithCode(
        service.reconcile(owner, '2026-11-03', {
          actorUserId: other,
          resolvedTokens: 1_200,
          note: 'foreign attempt',
        }),
        'reconcile_not_authorized',
      );
      await rejectsWithCode(
        service.reconcile(owner, '2026-02-31', {
          actorUserId: owner,
          resolvedTokens: 1_200,
          note: 'impossible day',
        }),
        'invalid_input',
      );
      await rejectsWithCode(
        service.reconcile(owner, '2026-11-03', {
          actorUserId: owner,
          resolvedTokens: 1_200,
          note: '   ',
        }),
        'invalid_input',
      );

      const reconciled = await service.reconcile(owner, '2026-11-03', {
        actorUserId: owner,
        resolvedTokens: 1_200,
        note: 'provider invoice shows 1,200 units',
      });
      assert.equal(reconciled.state, 'known');
      assert.equal(reconciled.provisionalTokens, 5_000);
      assert.equal(reconciled.resolvedTokens, 1_200);
      assert.equal(reconciled.deltaTokens, -3_800);
      assert.equal(reconciled.reconciledReservations, 1);

      const afterReconcile = await service.getUsage(owner);
      assert.equal(afterReconcile.blocked, false);
      assert.equal(afterReconcile.state, 'known');
      assert.equal(afterReconcile.usedTokens, 1_200);
      assert.equal(afterReconcile.reservedTokens, 0);

      // The audit trail is durable, owner-scoped, and append-only through the API.
      const audit = await service.listAudit(owner, '2026-11-03');
      assert.equal(audit.length, 1);
      assert.equal(audit[0].tokensDelta, -3_800);
      assert.equal(audit[0].actorUserId, owner);
      assert.match(audit[0].note, /provider invoice/);
      assert.deepEqual(await service.listAudit(other, '2026-11-03'), []);

      const rows = await reservationRows(owner);
      assert.equal(rows[0].state, 'unknown');
      assert.equal(rows[0].usage_status, 'unknown');
      assert.ok(rows[0].reconciled_at instanceof Date);

      await rejectsWithCode(
        service.reconcile(owner, '2026-11-03', {
          actorUserId: owner,
          resolvedTokens: 1_200,
          note: 'second attempt',
        }),
        'reconcile_not_required',
      );

      const resumed = await service.reserve({
        ownerUserId: owner,
        runId: randomUUID(),
        estimateTokens: 98_800,
      });
      assert.equal(resumed.state, 'reserved');
    });

    test('partial usage charges the largest defensible total, never zero', async () => {
      const owner = await seedUser();

      const partial = await service.reserve({
        ownerUserId: owner,
        runId: randomUUID(),
        estimateTokens: 1_000,
      });

      const settlement = await service.settle(
        partial.id,
        {
          status: 'partial',
          grossPromptTokens: 300,
          grossCompletionTokens: null,
          totalTokens: 500,
          cachedPromptTokens: 120,
          reasoningTokens: null,
        },
        { ownerUserId: owner },
      );

      assert.equal(settlement.state, 'settled');
      assert.equal(settlement.usageStatus, 'partial');
      assert.equal(settlement.chargedTokens, 500);

      const snapshot = await service.getUsage(owner);
      assert.equal(snapshot.inputTokens, 500);
      assert.equal(snapshot.outputTokens, 0);
      assert.equal(snapshot.usedTokens, 500);
      assert.equal(snapshot.state, 'partial');
      assert.equal(snapshot.reservedTokens, 0, 'the hold is released after settlement');

      // A zero-only report from a dispatched request cannot settle as zero.
      const zeroOwner = await seedUser();
      const zeroReservation = await service.reserve({
        ownerUserId: zeroOwner,
        runId: randomUUID(),
        estimateTokens: 700,
      });

      const zeroSettlement = await service.settle(
        zeroReservation.id,
        {
          status: 'partial',
          grossPromptTokens: 0,
          grossCompletionTokens: 0,
          totalTokens: 0,
        },
        { ownerUserId: zeroOwner },
      );

      assert.equal(zeroSettlement.state, 'unknown');
      assert.equal(zeroSettlement.chargedTokens, 700);
      assert.equal((await service.getUsage(zeroOwner)).usedTokens, 700);
    });

    test('known usage counts gross input plus output without double counting subsets', async () => {
      const owner = await seedUser();

      const reservation = await service.reserve({
        ownerUserId: owner,
        runId: randomUUID(),
        estimateTokens: 1_000,
      });

      const settlement = await service.settle(
        reservation.id,
        knownUsage({ cachedPromptTokens: 500, reasoningTokens: 100 }),
        { ownerUserId: owner },
      );

      assert.equal(settlement.state, 'settled');
      assert.equal(settlement.usageStatus, 'known');
      assert.equal(settlement.chargedTokens, 800);

      const snapshot = await service.getUsage(owner);
      assert.equal(snapshot.inputTokens, 600);
      assert.equal(snapshot.outputTokens, 200);
      assert.equal(snapshot.usedTokens, 800);

      // An inconsistent total is downgraded to partial and charged at the
      // larger, conservative value rather than the favourable one.
      const inconsistent = await service.reserve({
        ownerUserId: owner,
        runId: randomUUID(),
        estimateTokens: 1_000,
      });

      const partial = await service.settle(
        inconsistent.id,
        knownUsage({ totalTokens: 700 }),
        { ownerUserId: owner },
      );
      assert.equal(partial.usageStatus, 'partial');
      assert.equal(partial.chargedTokens, 800);
    });

    test('a provider overrun is recorded, not truncated to the estimate', async () => {
      const owner = await seedUser();

      const reservation = await service.reserve({
        ownerUserId: owner,
        runId: randomUUID(),
        estimateTokens: 1_000,
      });

      const settlement = await service.settle(
        reservation.id,
        knownUsage({
          grossPromptTokens: 900,
          grossCompletionTokens: 900,
          totalTokens: 1_800,
        }),
        { ownerUserId: owner },
      );

      assert.equal(settlement.chargedTokens, 1_800);
      assert.equal((await service.getUsage(owner)).usedTokens, 1_800);

      await rejectsWithCode(
        service.reserve({
          ownerUserId: owner,
          runId: randomUUID(),
          estimateTokens: 98_201,
        }),
        'allowance_exhausted',
      );
    });

    test('release frees the hold only for a pre-dispatch failure', async () => {
      const owner = await seedUser();

      const reservation = await service.reserve({
        ownerUserId: owner,
        runId: randomUUID(),
        estimateTokens: 750,
      });
      assert.equal((await service.getUsage(owner)).reservedTokens, 750);

      const released = await service.release(reservation.id, { ownerUserId: owner });
      assert.equal(released.state, 'released');
      assert.ok(released.releasedAt !== null);

      const repeated = await service.release(reservation.id, { ownerUserId: owner });
      assert.equal(repeated.id, released.id, 'release is idempotent');

      const snapshot = await service.getUsage(owner);
      assert.equal(snapshot.reservedTokens, 0);
      assert.equal(snapshot.usedTokens, 0);

      await rejectsWithCode(
        service.settle(reservation.id, knownUsage(), { ownerUserId: owner }),
        'reservation_not_reserved',
      );
    });

    test('day boundary resets at 00:00 Asia/Manila with an injected clock', async () => {
      const owner = await seedUser();

      assert.equal(
        (await service.getUsage(owner, at('2026-11-02T15:59:59.999Z'))).dayBucket,
        '2026-11-02',
      );
      assert.equal(
        (await service.getUsage(owner, at('2026-11-02T16:00:00.000Z'))).dayBucket,
        '2026-11-03',
      );

      const lateNight = serviceWithClock(() =>
        at('2026-11-03T15:59:59.999Z'),
      );
      const beforeReset = await lateNight.getUsage(owner);
      assert.equal(beforeReset.dayBucket, '2026-11-03');
      assert.equal(beforeReset.resetsAt, '2026-11-03T16:00:00.000Z');
      assert.equal(beforeReset.remainingTokens, ALLOWANCE);

      // Reserve the whole allowance before the boundary; it can be finalized
      // after it and still lands in the day it was admitted in.
      const reserved = await lateNight.reserve({
        ownerUserId: owner,
        runId: randomUUID(),
        estimateTokens: ALLOWANCE,
      });
      assert.equal((await lateNight.getUsage(owner)).reservedTokens, ALLOWANCE);

      await rejectsWithCode(
        lateNight.reserve({
          ownerUserId: owner,
          runId: randomUUID(),
          estimateTokens: 1,
        }),
        'allowance_exhausted',
      );

      const afterMidnight = serviceWithClock(() =>
        at('2026-11-03T16:00:00.001Z'),
      );
      await afterMidnight.settle(reserved.id, knownUsage(), { ownerUserId: owner });

      const oldDay = await lateNight.getUsage(owner);
      assert.equal(oldDay.dayBucket, '2026-11-03');
      assert.equal(oldDay.usedTokens, 800, 'the late settlement stays on its own day');

      const newDay = await afterMidnight.getUsage(owner);
      assert.equal(newDay.dayBucket, '2026-11-04');
      assert.equal(newDay.usedTokens, 0, 'unused units do not carry over');
      assert.equal(newDay.remainingTokens, ALLOWANCE);
      assert.equal(newDay.resetsAt, '2026-11-04T16:00:00.000Z');

      const fresh = await afterMidnight.reserve({
        ownerUserId: owner,
        runId: randomUUID(),
        estimateTokens: ALLOWANCE,
      });
      assert.equal(fresh.dayBucket, '2026-11-04');
    });

    test('one user cannot spend, settle, release, or read another user allowance', async () => {
      const owner = await seedUser();
      const other = await seedUser();

      const reservation = await service.reserve({
        ownerUserId: owner,
        runId: randomUUID(),
        estimateTokens: 2_000,
      });

      assert.equal((await service.getUsage(other)).usedTokens, 0);

      await rejectsWithCode(
        service.settle(reservation.id, knownUsage(), { ownerUserId: other }),
        'reservation_not_found',
      );
      await rejectsWithCode(
        service.release(reservation.id, { ownerUserId: other }),
        'reservation_not_found',
      );

      // The foreign attempts changed nothing.
      assert.equal((await service.getUsage(owner)).reservedTokens, 2_000);
      const rows = await reservationRows(owner);
      assert.equal(rows[0].state, 'reserved');

      // The other user still has the full allowance.
      const otherReservation = await service.reserve({
        ownerUserId: other,
        runId: randomUUID(),
        estimateTokens: 50_000,
      });
      assert.equal(otherReservation.state, 'reserved');
      assert.equal((await service.getUsage(other)).usedTokens, 50_000);
    });

    test('run creation limiter refuses with uniform 429 metadata', async () => {
      let now = at('2026-11-03T02:00:00.000Z');
      const limiter = new limits.RunCreationRateLimiter({ now: () => now });
      const owner = randomUUID();
      const other = randomUUID();

      for (let index = 0; index < 30; index += 1) {
        const decision = limiter.check(owner);
        assert.equal(decision.allowed, true);
        assert.equal(decision.remaining, 29 - index);
      }

      await assert.rejects(
        (async () => limiter.assert(owner))(),
        (error) => {
          assert.equal(error.name, 'RateLimitError');
          assert.equal(error.code, 'rate_limited');
          assert.equal(error.status, 429);
          assert.deepEqual(error.metadata, {
            code: 'rate_limited',
            limit: 30,
            retryAfterSeconds: 60,
          });
          return true;
        },
      );

      // The metadata shape is identical for a different user, and it never
      // contains the caller's id.
      await assert.rejects(
        (async () => {
          for (let index = 0; index < 31; index += 1) {
            limiter.assert(other);
          }
        })(),
        (error) => {
          assert.deepEqual(error.metadata, {
            code: 'rate_limited',
            limit: 30,
            retryAfterSeconds: 60,
          });
          assert.doesNotMatch(JSON.stringify(error.metadata), /[0-9a-f-]{36}/);
          return true;
        },
      );

      // The fixed window does not slide, and it reopens exactly at reset.
      now = at('2026-11-03T02:00:59.000Z');
      assert.equal(limiter.check(owner).allowed, false);
      now = at('2026-11-03T02:01:00.000Z');
      const reopened = limiter.check(owner);
      assert.equal(reopened.allowed, true);
      assert.equal(reopened.remaining, 29);

      // The tracked-key map is bounded rather than growing with unique ids.
      const bounded = new limits.RunCreationRateLimiter({
        maxTrackedKeys: 3,
        now: () => now,
      });
      for (let index = 0; index < 5; index += 1) {
        bounded.check(randomUUID());
      }
      assert.ok(bounded.trackedKeys <= 3);
    });
  },
);
