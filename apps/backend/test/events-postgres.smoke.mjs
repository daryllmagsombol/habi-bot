/**
 * H-020 (#20) Run event persistence and stream integration smoke tests.
 *
 * Starts an ephemeral PostgreSQL 18.6 container on a random loopback port,
 * applies the real migrations (0001-0008), and drives RunEventStore /
 * RunEventStream. No HTTP route, SSE encoder, provider, credential, or queue is
 * involved. Docker unavailability skips the suite; the container and pool are
 * removed afterwards.
 *
 * Coverage:
 *   schema              ordered columns, scope FK, checks, unique, immutability
 *   append ordering     contiguous seq, envelope scope, update/delete rejected
 *   concurrency         parallel appends produce unique contiguous sequences
 *   idempotency         duplicate event id returns the stored event, no new seq
 *   replay              0 / afterSeq / cursor / terminal / bounded pages
 *   reconnect           live delivery, gap markers, shared dedupe by (run, seq)
 *   terminal            stable, last, replayable; no append after it
 *   isolation           foreign user, unknown run, cross-run and bad cursors
 *   cleanup             events disappear only through the parent Run cascade
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
    { cwd: REPOSITORY_ROOT, encoding: 'utf8', timeout: 60000 },
  );
}

function dryRun(databaseUrl) {
  return spawnSync(
    process.execPath,
    [MIGRATE_SCRIPT, '--database-url', databaseUrl, '--dry-run'],
    { cwd: REPOSITORY_ROOT, encoding: 'utf8', timeout: 60000 },
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function expectCode(promise, code) {
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

async function nextItem(subscription) {
  const result = await subscription.next();
  return result.done === true ? null : result.value;
}

const dockerReady = dockerAvailable();

describe(
  'H-020 run events',
  { skip: dockerReady ? false : 'Docker daemon is unavailable' },
  () => {
    let containerName = '';
    let port = 0;
    let password = '';
    let pool;
    let store;
    let stream;
    let cursorFor;
    let isTerminalEvent;
    let streamClosedErrorName;
    let databaseUrl = '';
    let userA;
    let userB;
    let conversationA;
    let conversationB;

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
         VALUES ($1, $2, 'Event Bot')`,
        [botId, ownerUserId],
      );
      await pool.query(
        `INSERT INTO conversations (id, owner_user_id, bot_id, title)
         VALUES ($1, $2, $3, 'Event Conversation')`,
        [conversationId, ownerUserId, botId],
      );

      return conversationId;
    }

    async function seedRun(ownerUserId, conversationId, status = 'queued') {
      const id = randomUUID();
      await pool.query(
        `INSERT INTO runs (id, owner_user_id, conversation_id, status)
         VALUES ($1, $2, $3, $4)`,
        [id, ownerUserId, conversationId, status],
      );
      return id;
    }

    async function append(runId, type, payload = {}, eventId = undefined) {
      return store.append(userA, {
        runId,
        type,
        payload,
        ...(eventId === undefined ? {} : { eventId }),
      });
    }

    async function runEventCount(runId) {
      const result = await pool.query(
        'SELECT count(*)::int AS count FROM run_events WHERE run_id = $1',
        [runId],
      );
      return result.rows[0].count;
    }

    async function lastEventSeq(runId) {
      const result = await pool.query(
        'SELECT last_event_seq FROM runs WHERE id = $1',
        [runId],
      );
      return Number(result.rows[0].last_event_seq);
    }

    before(async () => {
      containerName = `habi-h020-${randomBytes(6).toString('hex')}`;
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
        max: 12,
      });

      await waitForDatabase(pool, containerName);
      databaseUrl = `postgres://${DOCKER_USER}:${password}@127.0.0.1:${port}/${DOCKER_DATABASE}`;

      const pending = dryRun(databaseUrl);
      assert.equal(pending.status, 0, pending.stderr);
      assert.match(pending.stdout, /pending\s+0008_run_events\.sql/);

      const applied = migrate(databaseUrl);
      assert.equal(applied.status, 0, applied.stderr);
      for (const migration of [
        '0001_conversations.sql',
        '0002_runs.sql',
        '0003_messages.sql',
        '0004_bot_profiles.sql',
        '0005_run_lifecycle.sql',
        '0006_auth_identity.sql',
        '0007_attachments.sql',
        '0008_run_events.sql',
      ]) {
        assert.match(applied.stdout, new RegExp(`applied\\s+${migration.replace('.', '\\.')}`));
      }

      const upToDate = migrate(databaseUrl);
      assert.equal(upToDate.status, 0, upToDate.stderr);
      assert.match(upToDate.stdout, /up to date/);

      const eventsModule = await import('../dist/events/index.js');
      store = new eventsModule.RunEventStore(pool);
      stream = new eventsModule.RunEventStream(store);
      cursorFor = eventsModule.encodeRunEventCursor;
      isTerminalEvent = eventsModule.isTerminalRunEventType;
      streamClosedErrorName = eventsModule.RunEventStreamClosedError.name;

      userA = await seedUser();
      userB = await seedUser();
      conversationA = await seedConversation(userA);
      conversationB = await seedConversation(userB);
    });

    after(async () => {
      if (pool !== undefined) {
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

    test('migration 0008 defines an ordered, scoped, immutable event table', async () => {
      const columns = await pool.query(
        `SELECT column_name
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'run_events'`,
      );
      const names = new Set(columns.rows.map((row) => row.column_name));

      for (const required of [
        'id',
        'run_id',
        'owner_user_id',
        'conversation_id',
        'seq',
        'type',
        'payload',
        'created_at',
      ]) {
        assert.ok(names.has(required), `run_events.${required} is missing`);
      }

      const constraints = await pool.query(
        `SELECT conname
           FROM pg_constraint
          WHERE conrelid = 'run_events'::regclass`,
      );
      const constraintNames = new Set(
        constraints.rows.map((row) => row.conname),
      );

      for (const required of [
        'run_events_run_scope_fk',
        'run_events_seq_positive',
        'run_events_type_shape',
        'run_events_payload_object',
        'run_events_run_seq_key',
      ]) {
        assert.ok(
          constraintNames.has(required),
          `run_events constraint ${required} is missing`,
        );
      }

      const triggers = await pool.query(
        `SELECT tgname
           FROM pg_trigger
          WHERE tgrelid = 'run_events'::regclass
            AND NOT tgisinternal`,
      );
      assert.deepEqual(
        triggers.rows.map((row) => row.tgname),
        ['run_events_immutable'],
      );

      const runId = await seedRun(userA, conversationA);

      await assert.rejects(
        pool.query(
          `INSERT INTO run_events (run_id, owner_user_id, conversation_id, seq, type, payload)
           VALUES ($1, $2, $3, 0, 'message.delta', '{}'::jsonb)`,
          [runId, userA, conversationA],
        ),
        (error) => error.code === '23514',
      );

      await assert.rejects(
        pool.query(
          `INSERT INTO run_events (run_id, owner_user_id, conversation_id, seq, type, payload)
           VALUES ($1, $2, $3, 1, 'message.delta', '[]'::jsonb)`,
          [runId, userA, conversationA],
        ),
        (error) => error.code === '23514',
      );

      await assert.rejects(
        pool.query(
          `INSERT INTO run_events (run_id, owner_user_id, conversation_id, seq, type, payload)
           VALUES ($1, $2, $3, 1, '', '{}'::jsonb)`,
          [runId, userA, conversationA],
        ),
        (error) => error.code === '23514',
      );

      await pool.query(
        `INSERT INTO run_events (id, run_id, owner_user_id, conversation_id, seq, type, payload)
         VALUES ($1, $2, $3, $4, 7, 'message.delta', '{"text":"kept"}'::jsonb)`,
        [randomUUID(), runId, userA, conversationA],
      );

      await assert.rejects(
        pool.query(
          `INSERT INTO run_events (run_id, owner_user_id, conversation_id, seq, type, payload)
           VALUES ($1, $2, $3, 7, 'message.delta', '{}'::jsonb)`,
          [runId, userA, conversationA],
        ),
        (error) =>
          error.code === '23505'
          && error.constraint === 'run_events_run_seq_key',
      );

      // The scope foreign key rejects a Run/owner mismatch.
      await assert.rejects(
        pool.query(
          `INSERT INTO run_events (run_id, owner_user_id, conversation_id, seq, type, payload)
           VALUES ($1, $2, $3, 8, 'message.delta', '{}'::jsonb)`,
          [runId, userB, conversationB],
        ),
        (error) => error.code === '23503',
      );
    });

    test('append allocates contiguous seq and rejects update/delete', async () => {
      const runId = await seedRun(userA, conversationA);

      const created = await append(runId, 'run.created', {
        dispatchState: 'dispatched',
      });
      const delta = await append(runId, 'message.delta', {
        messageId: randomUUID(),
        text: 'hello',
      });
      const completed = await append(runId, 'message.completed', {
        text: 'hello',
      });

      assert.equal(created.event.seq, 1);
      assert.equal(delta.event.seq, 2);
      assert.equal(completed.event.seq, 3);
      assert.equal(created.deduplicated, false);
      assert.equal(created.event.runId, runId);
      assert.equal(created.event.ownerUserId, userA);
      assert.equal(created.event.conversationId, conversationA);
      assert.match(created.event.id, UUID_PATTERN);
      assert.equal(created.event.type, 'run.created');
      assert.deepEqual(created.event.payload, { dispatchState: 'dispatched' });
      assert.ok(Number.isFinite(Date.parse(created.event.createdAt)));
      assert.equal(await lastEventSeq(runId), 3);

      const replay = await store.read(userA, runId);
      assert.deepEqual(
        replay.events.map((event) => event.seq),
        [1, 2, 3],
      );
      assert.deepEqual(
        replay.events.map((event) => event.type),
        ['run.created', 'message.delta', 'message.completed'],
      );
      assert.equal(replay.hasMore, false);
      assert.equal(replay.lastEventSeq, 3);
      assert.equal(replay.terminalEventSeq, null);

      await assert.rejects(
        pool.query('UPDATE run_events SET type = $2 WHERE id = $1', [
          created.event.id,
          'message.delta',
        ]),
        /run_events are immutable/,
      );
      await assert.rejects(
        pool.query('DELETE FROM run_events WHERE id = $1', [created.event.id]),
        /run_events are immutable/,
      );

      assert.equal(await runEventCount(runId), 3);

      // A parent Run delete is the one allowed cascade path.
      await pool.query('DELETE FROM runs WHERE id = $1', [runId]);
      assert.equal(await runEventCount(runId), 0);
    });

    test('concurrent appends allocate unique contiguous sequences', async () => {
      const runId = await seedRun(userA, conversationA);

      const results = await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          append(runId, 'message.delta', { text: `chunk-${index}` }),
        ),
      );
      const sequences = results.map((result) => result.event.seq).sort((a, b) => a - b);
      const expected = Array.from({ length: 20 }, (_, index) => index + 1);

      assert.deepEqual(sequences, expected);
      assert.equal(new Set(results.map((result) => result.event.id)).size, 20);
      assert.equal(await lastEventSeq(runId), 20);

      const replay = await store.read(userA, runId, { limit: 50 });
      assert.deepEqual(
        replay.events.map((event) => event.seq),
        expected,
      );
      assert.equal(replay.hasMore, false);
    });

    test('a duplicate client event id is idempotent', async () => {
      const runId = await seedRun(userA, conversationA);
      const eventId = randomUUID();

      const first = await append(
        runId,
        'message.delta',
        { text: 'once' },
        eventId,
      );
      const duplicate = await append(
        runId,
        'message.completed',
        { text: 'different input must not overwrite' },
        eventId,
      );

      assert.equal(first.deduplicated, false);
      assert.equal(duplicate.deduplicated, true);
      assert.equal(duplicate.event.id, first.event.id);
      assert.equal(duplicate.event.seq, first.event.seq);
      assert.equal(duplicate.event.type, 'message.delta');
      assert.deepEqual(duplicate.event.payload, { text: 'once' });
      assert.equal(await lastEventSeq(runId), 1);
      assert.equal(await runEventCount(runId), 1);

      // A concurrent retry of one client id still allocates one sequence.
      const concurrentId = randomUUID();
      const [left, right] = await Promise.all([
        append(runId, 'message.delta', { text: 'same' }, concurrentId),
        append(runId, 'message.delta', { text: 'same' }, concurrentId),
      ]);

      assert.equal(left.event.seq, right.event.seq);
      assert.equal(
        [left, right].filter((result) => result.deduplicated).length,
        1,
      );
      assert.equal(await runEventCount(runId), 2);

      const next = await append(runId, 'message.delta', { text: 'next' });
      assert.equal(next.event.seq, 3);
    });

    test('replay supports 0, afterSeq, cursor, bounds, and a terminal cursor', async () => {
      const runId = await seedRun(userA, conversationA);

      await append(runId, 'run.created', { dispatchState: 'dispatched' });
      await append(runId, 'message.delta', { text: 'a' });
      await append(runId, 'usage.recorded', { usageStatus: 'known' });
      await append(runId, 'run.completed', { usageStatus: 'known' });

      assert.equal(isTerminalEvent('run.completed'), true);
      assert.equal(isTerminalEvent('run.failed'), true);
      assert.equal(isTerminalEvent('run.cancelled'), true);
      assert.equal(isTerminalEvent('message.delta'), false);
      assert.equal(isTerminalEvent('policy.denied'), false);

      const fromZero = await store.read(userA, runId);
      assert.deepEqual(
        fromZero.events.map((event) => event.seq),
        [1, 2, 3, 4],
      );
      assert.equal(fromZero.terminalEventSeq, 4);
      assert.equal(fromZero.lastEventSeq, 4);

      const afterTwo = await store.read(userA, runId, { afterSeq: 2 });
      assert.deepEqual(
        afterTwo.events.map((event) => event.seq),
        [3, 4],
      );

      const afterTerminal = await store.read(userA, runId, { afterSeq: 4 });
      assert.deepEqual(afterTerminal.events, []);
      assert.equal(afterTerminal.terminalEventSeq, 4);
      assert.equal(afterTerminal.lastEventSeq, 4);

      const firstPage = await store.read(userA, runId, { limit: 2 });
      assert.deepEqual(
        firstPage.events.map((event) => event.seq),
        [1, 2],
      );
      assert.equal(firstPage.hasMore, true);

      const secondPage = await store.read(userA, runId, {
        afterSeq: 2,
        limit: 2,
      });
      assert.deepEqual(
        secondPage.events.map((event) => event.seq),
        [3, 4],
      );
      assert.equal(secondPage.hasMore, false);

      const cursor = cursorFor(runId, 2);
      const fromCursor = await store.readAfterCursor(userA, runId, cursor);
      assert.deepEqual(
        fromCursor.events.map((event) => event.seq),
        [3, 4],
      );
      assert.equal(fromCursor.afterSeq, 2);
    });

    test('the terminal event is last, stable, and replayable', async () => {
      const runId = await seedRun(userA, conversationA);

      await append(runId, 'run.failed', { errorCode: 'provider_error' });

      await assert.rejects(
        append(runId, 'message.delta', { text: 'late' }),
        (error) => {
          assert.equal(error.name, streamClosedErrorName);
          assert.equal(error.code, 'run_event_stream_closed');
          return true;
        },
      );
      assert.equal(await lastEventSeq(runId), 1);

      // Simulate a buggy direct writer after the terminal row. The store hides
      // it and the stream stops at the terminal event instead of emitting more.
      await pool.query(
        `INSERT INTO run_events (id, run_id, owner_user_id, conversation_id, seq, type, payload)
         VALUES ($1, $2, $3, $4, 2, 'message.delta', '{"text":"late"}'::jsonb)`,
        [randomUUID(), runId, userA, conversationA],
      );
      await pool.query('UPDATE runs SET last_event_seq = 2 WHERE id = $1', [runId]);

      const replay = await store.read(userA, runId);
      assert.deepEqual(
        replay.events.map((event) => event.seq),
        [1],
      );
      assert.equal(replay.terminalEventSeq, 1);
      assert.equal(replay.lastEventSeq, 1);

      const subscription = stream.subscribe({
        actorUserId: userA,
        runId,
        afterSeq: 0,
      });
      const terminal = await nextItem(subscription);
      assert.equal(terminal.kind, 'event');
      assert.equal(terminal.event.seq, 1);
      assert.equal(terminal.event.type, 'run.failed');
      assert.equal(await nextItem(subscription), null);
    });

    test('a stream delivers live events and dedupes a reconnect', async () => {
      const runId = await seedRun(userA, conversationA);

      await append(runId, 'run.created', { dispatchState: 'dispatched' });
      await append(runId, 'message.delta', { text: 'a' });

      const subscription = stream.subscribe({
        actorUserId: userA,
        runId,
        afterSeq: 0,
        limit: 1,
      });

      const first = await nextItem(subscription);
      assert.equal(first.kind, 'event');
      assert.equal(first.event.seq, 1);

      const second = await nextItem(subscription);
      assert.equal(second.kind, 'event');
      assert.equal(second.event.seq, 2);

      // A live append wakes the subscriber and is persisted before delivery.
      const pending = nextItem(subscription);
      await append(runId, 'message.delta', { text: 'b' });
      const live = await pending;
      assert.equal(live.kind, 'event');
      assert.equal(live.event.seq, 3);
      await subscription.return();

      // Appended while disconnected, so it was never seen by this consumer.
      await append(runId, 'message.delta', { text: 'c' });

      // Reconnect slightly behind the delivered cursor: seq 2 and 3 are already
      // known to this stream instance, so the replay skips them and delivers
      // only seq 4.
      const reconnect = stream.subscribe({
        actorUserId: userA,
        runId,
        cursor: cursorFor(runId, 1),
      });
      const deduped = await nextItem(reconnect);
      assert.equal(deduped.kind, 'event');
      assert.equal(deduped.event.seq, 4);
      await reconnect.return();

      await append(runId, 'run.completed', { usageStatus: 'unknown' });

      const terminalSubscription = stream.subscribe({
        actorUserId: userA,
        runId,
        afterSeq: 4,
      });
      const terminal = await nextItem(terminalSubscription);
      assert.equal(terminal.kind, 'event');
      assert.equal(terminal.event.seq, 5);
      assert.equal(terminal.event.type, 'run.completed');
      assert.equal(await nextItem(terminalSubscription), null);

      // Reconnecting at/after the terminal event ends immediately and empty.
      const afterTerminal = stream.subscribe({
        actorUserId: userA,
        runId,
        cursor: cursorFor(runId, 5),
      });
      assert.equal(await nextItem(afterTerminal), null);
      assert.equal(stream.deliveredCount(runId), 5);
    });

    test('a stream marks a sequence gap explicitly', async () => {
      const runId = await seedRun(userA, conversationA);

      await append(runId, 'message.delta', { text: 'one' });

      // Bypass the allocator to create a real hole at seq 2.
      await pool.query(
        `INSERT INTO run_events (id, run_id, owner_user_id, conversation_id, seq, type, payload)
         VALUES ($1, $2, $3, $4, 3, 'message.delta', '{"text":"three"}'::jsonb)`,
        [randomUUID(), runId, userA, conversationA],
      );
      await pool.query('UPDATE runs SET last_event_seq = 3 WHERE id = $1', [runId]);

      const subscription = stream.subscribe({
        actorUserId: userA,
        runId,
        afterSeq: 0,
      });

      const one = await nextItem(subscription);
      assert.equal(one.kind, 'event');
      assert.equal(one.event.seq, 1);

      const gap = await nextItem(subscription);
      assert.deepEqual(gap, {
        kind: 'gap',
        runId,
        fromSeq: 2,
        toSeq: 2,
      });

      const three = await nextItem(subscription);
      assert.equal(three.kind, 'event');
      assert.equal(three.event.seq, 3);
      await subscription.return();
    });

    test('ownership and cursor scope reject without enumeration', async () => {
      const runA = await seedRun(userA, conversationA);
      const runB = await seedRun(userA, conversationA);
      const foreignRun = await seedRun(userB, conversationB);

      await append(runA, 'message.delta', { text: 'a' });

      await expectCode(store.read(userB, runA), 'not_found');
      await expectCode(store.loadPosition(userB, runA), 'not_found');
      await expectCode(store.read(userA, randomUUID()), 'not_found');
      await expectCode(
        store.append(userB, {
          runId: runA,
          type: 'message.delta',
          payload: { text: 'foreign' },
        }),
        'not_found',
      );
      await expectCode(store.append(userA, {
        runId: foreignRun,
        type: 'message.delta',
        payload: { text: 'foreign' },
      }), 'not_found');

      await expectCode(store.readAfterCursor(userA, runA, 'not-a-cursor'), 'invalid_cursor');
      await expectCode(
        store.readAfterCursor(userA, runA, cursorFor(runB, 0)),
        'not_found',
      );
      await expectCode(store.read(userA, runA, { afterSeq: 99 }), 'not_found');
      await expectCode(store.read(userA, runA, { afterSeq: -1 }), 'invalid_cursor');

      assert.throws(
        () =>
          stream.subscribe({
            actorUserId: userA,
            runId: runA,
            cursor: cursorFor(runB, 0),
          }),
        (error) => error.code === 'not_found',
      );

      assert.throws(
        () =>
          stream.subscribe({
            actorUserId: userA,
            runId: runA,
            afterSeq: 0,
            cursor: cursorFor(runA, 0),
          }),
        (error) => error.code === 'invalid_input',
      );

      assert.throws(
        () =>
          stream.subscribe({
            actorUserId: userA,
            runId: runA,
            cursor: 'not-a-cursor',
          }),
        (error) => error.code === 'invalid_cursor',
      );

      const foreignSubscription = stream.subscribe({
        actorUserId: userB,
        runId: runA,
        afterSeq: 0,
      });
      await expectCode(foreignSubscription.next(), 'not_found');
      await foreignSubscription.return();

      const beyondSubscription = stream.subscribe({
        actorUserId: userA,
        runId: runA,
        afterSeq: 99,
      });
      await expectCode(beyondSubscription.next(), 'not_found');
      await beyondSubscription.return();
    });

    test('cleanup removes events only through the parent Run', async () => {
      const runId = await seedRun(userA, conversationA);
      await append(runId, 'run.created', { dispatchState: 'not_dispatched' });
      await append(runId, 'run.cancelled', {});

      assert.equal(await runEventCount(runId), 2);

      await pool.query('DELETE FROM runs WHERE id = $1', [runId]);
      assert.equal(await runEventCount(runId), 0);

      const orphans = await pool.query(
        `SELECT count(*)::int AS count
           FROM run_events e
           LEFT JOIN runs r ON r.id = e.run_id
          WHERE r.id IS NULL`,
      );
      assert.equal(orphans.rows[0].count, 0);
    });
  },
);
