/**
 * H-019 persistence integration smoke tests.
 *
 * Starts an ephemeral PostgreSQL 18.6 container on a random loopback port with
 * a random password, applies the real migrations, then exercises the repository
 * with two users. Skips cleanly when the Docker daemon is unavailable. The
 * container and every temporary database/directory are removed afterwards.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client, Pool } = pg;

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const MIGRATE_SCRIPT = join(REPOSITORY_ROOT, 'scripts/db/migrate.mjs');
const POSTGRES_IMAGE = 'postgres:18.6-alpine';
const DOCKER_USER = 'habi';
const DOCKER_DATABASE = 'habi';

function dockerAvailable() {
  const result = spawnSync('docker', ['info'], {
    stdio: 'ignore',
    timeout: 5000,
  });

  return result.status === 0;
}

const dockerReady = dockerAvailable();
const createdDatabases = [];
const temporaryDirectories = [];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function migrate(databaseUrl, extraArgs = []) {
  return spawnSync(
    process.execPath,
    [MIGRATE_SCRIPT, '--database-url', databaseUrl, ...extraArgs],
    {
      cwd: REPOSITORY_ROOT,
      encoding: 'utf8',
      timeout: 60000,
    },
  );
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

describe(
  'H-019 conversation and message persistence',
  { skip: dockerReady ? false : 'Docker daemon is unavailable' },
  () => {
    let containerName = '';
    let pool;
    let service;
    let databaseUrl = '';
    let userA;
    let userB;
    let botA;
    let botAOther;
    let botB;

    before(async () => {
      containerName = `habi-h019-${randomBytes(6).toString('hex')}`;
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

      const port = Number.parseInt(portResult.stdout.trim().split(':').pop() ?? '', 10);
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

      const dryRun = migrate(databaseUrl, ['--dry-run']);
      assert.equal(dryRun.status, 0, dryRun.stderr);
      assert.match(dryRun.stdout, /pending\s+0001_conversations\.sql/);
      assert.match(dryRun.stdout, /pending\s+0003_messages\.sql/);

      const noTable = await pool.query(
        "SELECT to_regclass('public.schema_migrations') AS table_name",
      );
      assert.equal(noTable.rows[0].table_name, null, 'dry run must not mutate');

      const applied = migrate(databaseUrl);
      assert.equal(applied.status, 0, applied.stderr);
      assert.match(applied.stdout, /applied\s+0001_conversations\.sql/);
      assert.match(applied.stdout, /applied\s+0002_runs\.sql/);
      assert.match(applied.stdout, /applied\s+0003_messages\.sql/);

      const upToDate = migrate(databaseUrl);
      assert.equal(upToDate.status, 0, upToDate.stderr);
      assert.match(upToDate.stdout, /up to date/);

      const { ChatPersistenceService } = await import(
        '../dist/persistence/index.js'
      );
      service = new ChatPersistenceService(pool);

      userA = randomUUID();
      userB = randomUUID();
      await pool.query('INSERT INTO users (id) VALUES ($1), ($2)', [userA, userB]);

      botA = randomUUID();
      botAOther = randomUUID();
      botB = randomUUID();
      await pool.query(
        `INSERT INTO bots (id, owner_user_id)
         VALUES ($1, $2), ($3, $2), ($4, $5)`,
        [botA, userA, botAOther, botB, userB],
      );
    });

    after(async () => {
      if (pool !== undefined) {
        await pool.end().catch(() => {});
      }

      // Drop temporary databases with their lingering connections.
      if (containerName !== '') {
        const portResult = spawnSync('docker', ['port', containerName, '5432/tcp'], {
          encoding: 'utf8',
          timeout: 10000,
        });
        const published = portResult.stdout?.trim().split(':').pop() ?? '';
        const port = Number.parseInt(published, 10);

        if (Number.isInteger(port) && port > 0 && createdDatabases.length > 0) {
          const admin = new Client({
            host: '127.0.0.1',
            port,
            user: DOCKER_USER,
            password: new URL(databaseUrl).password,
            database: 'postgres',
          });

          try {
            await admin.connect();
            for (const name of createdDatabases) {
              await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
            }
          } catch {
            // Container removal below is the authoritative cleanup.
          } finally {
            await admin.end().catch(() => {});
          }
        }

        spawnSync('docker', ['rm', '-f', containerName], {
          stdio: 'ignore',
          timeout: 30000,
        });
      }

      for (const directory of temporaryDirectories) {
        rmSync(directory, { recursive: true, force: true });
      }
    });

    test('denies cross-user and guessed-id access without enumeration', async () => {
      const conversationA = await service.conversations.create(userA, {
        botId: botA,
        title: 'A private conversation',
      });
      const messageA = await service.messages.append(userA, {
        conversationId: conversationA.id,
        role: 'user',
        content: 'Only A should read this.',
      });

      const conversationB = await service.conversations.create(userB, {
        botId: botB,
        title: 'B private conversation',
      });

      await rejectsWithCode(service.conversations.get(userB, conversationA.id), 'not_found');
      await rejectsWithCode(service.messages.list(userB, conversationA.id), 'not_found');
      await rejectsWithCode(
        service.messages.append(userB, {
          conversationId: conversationA.id,
          role: 'user',
          content: 'intrusion',
        }),
        'not_found',
      );
      await rejectsWithCode(
        service.conversations.rename(userB, conversationA.id, 'stolen'),
        'not_found',
      );
      await rejectsWithCode(service.conversations.archive(userB, conversationA.id), 'not_found');
      await rejectsWithCode(service.conversations.delete(userB, conversationA.id), 'not_found');
      await rejectsWithCode(
        service.messages.get(userB, conversationA.id, messageA.id),
        'not_found',
      );

      const guessedConversation = randomUUID();
      const guessedMessage = randomUUID();
      await rejectsWithCode(service.conversations.get(userA, guessedConversation), 'not_found');
      await rejectsWithCode(service.messages.list(userA, guessedConversation), 'not_found');
      await rejectsWithCode(
        service.messages.get(userA, conversationA.id, guessedMessage),
        'not_found',
      );
      await rejectsWithCode(
        service.conversations.create(userA, { botId: botB, title: 'foreign bot' }),
        'not_found',
      );

      const listA = await service.conversations.list(userA, { limit: 100 });
      assert.ok(listA.conversations.some((row) => row.id === conversationA.id));
      assert.ok(!listA.conversations.some((row) => row.id === conversationB.id));

      const listB = await service.conversations.list(userB, { limit: 100 });
      assert.ok(listB.conversations.some((row) => row.id === conversationB.id));
      assert.ok(!listB.conversations.some((row) => row.id === conversationA.id));
    });

    test('isolates two conversations under the same Bot and owner', async () => {
      const first = await service.conversations.create(userA, {
        botId: botA,
        title: 'Same bot one',
      });
      const second = await service.conversations.create(userA, {
        botId: botA,
        title: 'Same bot two',
      });

      assert.notEqual(first.id, second.id);

      const firstMessage = await service.messages.append(userA, {
        conversationId: first.id,
        role: 'user',
        content: 'first thread',
      });
      const secondMessage = await service.messages.append(userA, {
        conversationId: second.id,
        role: 'user',
        content: 'second thread',
      });

      assert.equal(firstMessage.seq, 1);
      assert.equal(secondMessage.seq, 1);

      const firstPage = await service.messages.list(userA, first.id);
      const secondPage = await service.messages.list(userA, second.id);

      assert.deepEqual(firstPage.messages.map((row) => row.content), ['first thread']);
      assert.deepEqual(secondPage.messages.map((row) => row.content), ['second thread']);

      const firstAfter = await service.conversations.get(userA, first.id);
      const secondAfter = await service.conversations.get(userA, second.id);
      assert.equal(firstAfter.lastMessageSeq, 1);
      assert.equal(secondAfter.lastMessageSeq, 1);
    });

    test('orders messages by server seq, paginates, and stores injection-shaped input', async () => {
      const conversation = await service.conversations.create(userA, {
        botId: botAOther,
        title: "'); DROP TABLE conversations; --",
      });

      const injection = "'); DROP TABLE messages; -- $$ alert(1)";
      const contents = ['one', 'two', injection, 'four', 'five'];

      for (const [index, content] of contents.entries()) {
        await service.messages.append(userA, {
          conversationId: conversation.id,
          role: 'user',
          content,
          clientMessageId: `order-${index}`,
        });
      }

      const pageOne = await service.messages.list(userA, conversation.id, { limit: 2 });
      assert.deepEqual(
        pageOne.messages.map((row) => row.seq),
        [1, 2],
      );
      assert.equal(pageOne.hasMoreAfter, true);
      assert.ok(pageOne.afterCursor);

      const pageTwo = await service.messages.list(userA, conversation.id, {
        limit: 2,
        afterCursor: pageOne.afterCursor,
      });
      assert.deepEqual(
        pageTwo.messages.map((row) => row.seq),
        [3, 4],
      );

      const pageThree = await service.messages.list(userA, conversation.id, {
        limit: 2,
        afterCursor: pageTwo.afterCursor,
      });
      assert.deepEqual(
        pageThree.messages.map((row) => row.seq),
        [5],
      );
      assert.equal(pageThree.hasMoreAfter, false);

      const collected = [
        ...pageOne.messages,
        ...pageTwo.messages,
        ...pageThree.messages,
      ];
      assert.deepEqual(
        collected.map((row) => row.seq),
        [1, 2, 3, 4, 5],
      );
      assert.equal(new Set(collected.map((row) => row.id)).size, 5);

      const injectionMessage = collected.find((row) => row.seq === 3);
      assert.equal(injectionMessage.content, injection);

      // A normal write between page reads does not duplicate or skip.
      const inserted = await service.messages.append(userA, {
        conversationId: conversation.id,
        role: 'user',
        content: 'six',
      });
      assert.equal(inserted.seq, 6);

      const afterPause = await service.messages.list(userA, conversation.id, {
        limit: 2,
        afterCursor: pageTwo.afterCursor,
      });
      assert.deepEqual(
        afterPause.messages.map((row) => row.seq),
        [5, 6],
      );

      const newestPage = await service.messages.list(userA, conversation.id, {
        limit: 2,
        beforeCursor: pageThree.afterCursor,
      });
      // The cursor is exclusive: asking before seq 5 returns the page 3,4.
      assert.deepEqual(
        newestPage.messages.map((row) => row.seq),
        [3, 4],
      );
      assert.equal(newestPage.hasMoreBefore, true);

      const oldestPage = await service.messages.list(userA, conversation.id, {
        limit: 2,
        beforeCursor: newestPage.beforeCursor,
      });
      assert.deepEqual(
        oldestPage.messages.map((row) => row.seq),
        [1, 2],
      );

      const storedTitle = await service.conversations.get(userA, conversation.id);
      assert.equal(storedTitle.title, "'); DROP TABLE conversations; --");

      const tableCheck = await pool.query("SELECT to_regclass('public.messages') AS name");
      assert.ok(tableCheck.rows[0].name, 'parameterized content must not drop tables');

      await rejectsWithCode(
        service.messages.list(userA, conversation.id, { limit: 0 }),
        'invalid_input',
      );
      await assert.rejects(
        service.messages.list(userA, conversation.id, { afterCursor: 'not-a-cursor' }),
        (error) => error.code === 'invalid_cursor',
      );
    });

    test('makes message append idempotent and links at most one assistant result per Run', async () => {
      const conversation = await service.conversations.create(userA, {
        botId: botA,
        title: 'Idempotent append',
      });
      const otherConversation = await service.conversations.create(userA, {
        botId: botA,
        title: 'Run scope check',
      });

      const first = await service.messages.append(userA, {
        conversationId: conversation.id,
        role: 'user',
        content: 'retry me',
        clientMessageId: 'client-1',
      });
      const retried = await service.messages.append(userA, {
        conversationId: conversation.id,
        role: 'user',
        content: 'retry me',
        clientMessageId: 'client-1',
      });

      assert.equal(retried.id, first.id);
      assert.equal(retried.seq, first.seq);

      const count = await pool.query(
        'SELECT count(*)::int AS count FROM messages WHERE conversation_id = $1',
        [conversation.id],
      );
      assert.equal(count.rows[0].count, 1);

      await rejectsWithCode(
        service.messages.append(userA, {
          conversationId: conversation.id,
          role: 'user',
          content: 'different payload',
          clientMessageId: 'client-1',
        }),
        'message_idempotency_conflict',
      );

      await rejectsWithCode(
        service.messages.append(userA, {
          conversationId: conversation.id,
          role: 'assistant',
          content: 'retry me',
          clientMessageId: 'client-1',
        }),
        'message_idempotency_conflict',
      );

      await rejectsWithCode(
        service.messages.append(userA, {
          conversationId: conversation.id,
          role: 'user',
          content: 'blank key',
          clientMessageId: '',
        }),
        'invalid_input',
      );

      // The same client key in a different conversation is independent.
      const isolated = await service.messages.append(userA, {
        conversationId: otherConversation.id,
        role: 'user',
        content: 'retry me',
        clientMessageId: 'client-1',
      });
      assert.notEqual(isolated.id, first.id);

      const runId = randomUUID();
      await pool.query(
        `INSERT INTO runs (id, owner_user_id, conversation_id)
         VALUES ($1, $2, $3)`,
        [runId, userA, conversation.id],
      );
      const foreignRunId = randomUUID();
      await pool.query(
        `INSERT INTO runs (id, owner_user_id, conversation_id)
         VALUES ($1, $2, $3)`,
        [foreignRunId, userA, otherConversation.id],
      );

      const assistant = await service.messages.append(userA, {
        conversationId: conversation.id,
        role: 'assistant',
        content: 'final answer',
        runId,
      });
      assert.equal(assistant.role, 'assistant');
      assert.equal(assistant.status, 'final');

      await rejectsWithCode(
        service.messages.append(userA, {
          conversationId: conversation.id,
          role: 'assistant',
          content: 'second answer for same run',
          runId,
        }),
        'run_result_exists',
      );

      await rejectsWithCode(
        service.messages.append(userA, {
          conversationId: conversation.id,
          role: 'assistant',
          content: 'wrong conversation run',
          runId: foreignRunId,
        }),
        'invalid_run_reference',
      );
    });

    test('archives as read-only and deletes messages without resurrection', async () => {
      const conversation = await service.conversations.create(userA, {
        botId: botA,
        title: 'Archive then delete',
      });

      await service.messages.append(userA, {
        conversationId: conversation.id,
        role: 'user',
        content: 'keep me while archived',
        clientMessageId: 'archive-1',
      });
      await service.messages.append(userA, {
        conversationId: conversation.id,
        role: 'assistant',
        content: 'archived reply',
      });

      const archived = await service.conversations.archive(userA, conversation.id);
      assert.equal(archived.status, 'archived');

      const archivedAgain = await service.conversations.archive(userA, conversation.id);
      assert.equal(archivedAgain.status, 'archived');

      const archivedPage = await service.messages.list(userA, conversation.id);
      assert.equal(archivedPage.messages.length, 2);

      const renamedArchived = await service.conversations.rename(
        userA,
        conversation.id,
        'Archived but renamed',
      );
      assert.equal(renamedArchived.status, 'archived');
      assert.equal(renamedArchived.title, 'Archived but renamed');

      await rejectsWithCode(
        service.messages.append(userA, {
          conversationId: conversation.id,
          role: 'user',
          content: 'should not append',
        }),
        'conversation_archived',
      );

      const deleted = await service.conversations.delete(userA, conversation.id);
      assert.equal(deleted.status, 'deleted');

      const deletedAgain = await service.conversations.delete(userA, conversation.id);
      assert.equal(deletedAgain.status, 'deleted');

      await rejectsWithCode(service.conversations.get(userA, conversation.id), 'not_found');
      await rejectsWithCode(service.messages.list(userA, conversation.id), 'not_found');
      await rejectsWithCode(
        service.messages.append(userA, {
          conversationId: conversation.id,
          role: 'user',
          content: 'resurrect attempt',
          clientMessageId: 'archive-1',
        }),
        'not_found',
      );
      await rejectsWithCode(
        service.conversations.rename(userA, conversation.id, 'rename tombstone'),
        'not_found',
      );
      await rejectsWithCode(service.conversations.archive(userA, conversation.id), 'not_found');

      const tombstones = await pool.query(
        `SELECT status, deleted_at
           FROM messages
          WHERE conversation_id = $1
          ORDER BY seq`,
        [conversation.id],
      );
      assert.equal(tombstones.rows.length, 2);
      for (const row of tombstones.rows) {
        assert.equal(row.status, 'deleted');
        assert.notEqual(row.deleted_at, null);
      }

      const list = await service.conversations.list(userA, { limit: 100 });
      assert.ok(!list.conversations.some((row) => row.id === conversation.id));
    });

    test('rolls back a failing migration and refuses out-of-order history', async () => {
      const port = new URL(databaseUrl).port;
      assert.ok(port.length > 0);
      const password = new URL(databaseUrl).password;

      const admin = new Client({
        host: '127.0.0.1',
        port: Number.parseInt(port, 10),
        user: DOCKER_USER,
        password,
        database: 'postgres',
      });
      await admin.connect();

      const failedDatabase = `habi_mig_fail_${randomBytes(5).toString('hex')}`;
      await admin.query(`CREATE DATABASE "${failedDatabase}"`);
      createdDatabases.push(failedDatabase);
      const failedUrl = `postgres://${DOCKER_USER}:${password}@127.0.0.1:${port}/${failedDatabase}`;

      const failedDirectory = mkdtempSync(join(tmpdir(), 'habi-mig-fail-'));
      temporaryDirectories.push(failedDirectory);

      writeFileSync(
        join(failedDirectory, '0001_ok.sql'),
        'CREATE TABLE migration_probe_ok (id integer);\n',
      );
      writeFileSync(
        join(failedDirectory, '0002_bad.sql'),
        'CREATE TABLE migration_probe_bad (id integer);\nSELECT * FROM table_that_does_not_exist;\n',
      );

      const failed = migrate(failedUrl, ['--migrations-dir', failedDirectory]);
      assert.notEqual(failed.status, 0);
      assert.match(failed.stderr, /rolled back/);

      const failedCheck = new Client({ connectionString: failedUrl });
      await failedCheck.connect();

      const rolledBackTable = await failedCheck.query(
        "SELECT to_regclass('public.migration_probe_bad') AS table_name",
      );
      assert.equal(rolledBackTable.rows[0].table_name, null);

      const appliedAfterFailure = await failedCheck.query(
        'SELECT version FROM schema_migrations ORDER BY version',
      );
      assert.deepEqual(
        appliedAfterFailure.rows.map((row) => row.version),
        ['0001'],
      );

      // Forward fix: correct 0002 and rerun; 0001 is not re-applied.
      writeFileSync(
        join(failedDirectory, '0002_bad.sql'),
        'CREATE TABLE migration_probe_bad (id integer);\n',
      );
      const fixed = migrate(failedUrl, ['--migrations-dir', failedDirectory]);
      assert.equal(fixed.status, 0, fixed.stderr);
      assert.match(fixed.stdout, /applied\s+0002_bad\.sql/);

      // Editing an applied file is refused rather than silently re-run.
      writeFileSync(
        join(failedDirectory, '0001_ok.sql'),
        'CREATE TABLE migration_probe_ok (id integer);\n-- edited after apply\n',
      );
      const edited = migrate(failedUrl, ['--migrations-dir', failedDirectory]);
      assert.notEqual(edited.status, 0);
      assert.match(edited.stderr, /Checksum mismatch/);

      await failedCheck.end();

      const orderDatabase = `habi_mig_order_${randomBytes(5).toString('hex')}`;
      await admin.query(`CREATE DATABASE "${orderDatabase}"`);
      createdDatabases.push(orderDatabase);
      const orderUrl = `postgres://${DOCKER_USER}:${password}@127.0.0.1:${port}/${orderDatabase}`;

      const orderDirectory = mkdtempSync(join(tmpdir(), 'habi-mig-order-'));
      temporaryDirectories.push(orderDirectory);

      writeFileSync(
        join(orderDirectory, '0001_first.sql'),
        'CREATE TABLE migration_order_first (id integer);\n',
      );
      writeFileSync(
        join(orderDirectory, '0003_third.sql'),
        'CREATE TABLE migration_order_third (id integer);\n',
      );

      const gapApplied = migrate(orderUrl, ['--migrations-dir', orderDirectory]);
      assert.equal(gapApplied.status, 0, gapApplied.stderr);
      assert.match(gapApplied.stdout, /applied\s+0003_third\.sql/);

      writeFileSync(
        join(orderDirectory, '0002_late.sql'),
        'CREATE TABLE migration_order_late (id integer);\n',
      );

      const outOfOrder = migrate(orderUrl, ['--migrations-dir', orderDirectory]);
      assert.notEqual(outOfOrder.status, 0);
      assert.match(outOfOrder.stderr, /out-of-order/);

      const orderCheck = new Client({ connectionString: orderUrl });
      await orderCheck.connect();
      const lateTable = await orderCheck.query(
        "SELECT to_regclass('public.migration_order_late') AS table_name",
      );
      assert.equal(lateTable.rows[0].table_name, null);
      const orderRows = await orderCheck.query(
        'SELECT version FROM schema_migrations ORDER BY version',
      );
      assert.deepEqual(
        orderRows.rows.map((row) => row.version),
        ['0001', '0003'],
      );
      await orderCheck.end();
      await admin.end();
    });
  },
);
