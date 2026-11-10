/**
 * H-030 (#30) explicit memory controls integration smoke tests.
 *
 * Starts an ephemeral PostgreSQL 18.6 container on a random loopback port,
 * applies the real migrations (0001-0011), and exercises MemoryService.
 *
 * Coverage:
 *   gates          both D2 approvals required; each alone recalls nothing
 *   acceptance     explicit accept required even with both gates on
 *   defaults       newly proposed memories have both gates off
 *   D3 retention   accepted source deletion survives with tombstoned provenance
 *                  and audit; unaccepted proposals are removed
 *   deletion       explicit delete stops recall and is idempotent
 *   isolation      cross-user, cross-Bot, cross-conversation, guessed ids
 *   filters        status/Bot/conversation filters and limit/offset paging
 *   schema guards  acceptance, provenance, lifecycle, and audit constraints
 *   audit          append-only by convention; service exposes no mutation path
 *
 * Skips cleanly when the Docker daemon is unavailable; the container and pool
 * are removed afterwards.
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

const dockerReady = dockerAvailable();

describe(
  'H-030 explicit memory controls',
  { skip: dockerReady ? false : 'Docker daemon is unavailable' },
  () => {
    let containerName = '';
    let pool;
    let databaseUrl = '';
    let memory;
    let chat;
    let bots;
    let userA;
    let userB;
    let botA1;
    let botA2;
    let botB;
    let conversationA1;
    let conversationA2;
    let conversationA3;
    let conversationB;
    let messageA1;
    let messageA2;

    async function newConversation(actor, botId, title) {
      return chat.conversations.create(actor, { botId, title });
    }

    async function propose(actor, conversation, content, sourceMessageId) {
      return memory.propose(actor, {
        botId: conversation.botId,
        conversationId: conversation.id,
        content,
        ...(sourceMessageId === undefined ? {} : { sourceMessageId }),
      });
    }

    async function acceptMemory(actor, memoryId) {
      await memory.approveBot(actor, memoryId);
      await memory.approveConversation(actor, memoryId);
      return memory.accept(actor, memoryId);
    }

    async function recalledIds(actor, botId, conversationId) {
      const recalled = await memory.recall(actor, { botId, conversationId });
      return recalled.map((item) => item.id);
    }

    async function auditFor(memoryId) {
      const result = await pool.query(
        `SELECT id, action, actor_user_id, note, created_at
           FROM memory_audit
          WHERE memory_id = $1
          ORDER BY created_at ASC, id ASC`,
        [memoryId],
      );

      return result.rows;
    }

    before(async () => {
      containerName = `habi-h030-${randomBytes(6).toString('hex')}`;
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
        max: 6,
      });

      await waitForDatabase(pool, containerName);
      databaseUrl = `postgres://${DOCKER_USER}:${password}@127.0.0.1:${port}/${DOCKER_DATABASE}`;

      const pending = dryRun(databaseUrl);
      assert.equal(pending.status, 0, pending.stderr);
      assert.match(pending.stdout, /pending\s+0011_memory\.sql/);

      const applied = migrate(databaseUrl);
      assert.equal(applied.status, 0, applied.stderr);
      assert.match(applied.stdout, /applied\s+0001_conversations\.sql/);
      assert.match(applied.stdout, /applied\s+0011_memory\.sql/);

      const upToDate = migrate(databaseUrl);
      assert.equal(upToDate.status, 0, upToDate.stderr);
      assert.match(upToDate.stdout, /up to date/);

      const { MemoryService } = await import('../dist/memory/index.js');
      const { ChatPersistenceService } = await import(
        '../dist/persistence/index.js'
      );
      const { BotService } = await import('../dist/bots/index.js');

      chat = new ChatPersistenceService(pool);
      bots = new BotService(pool);
      memory = new MemoryService(pool);

      userA = randomUUID();
      userB = randomUUID();
      await pool.query('INSERT INTO users (id) VALUES ($1), ($2)', [userA, userB]);

      botA1 = (await bots.create(userA, { name: 'Memory Bot A1' })).id;
      botA2 = (await bots.create(userA, { name: 'Memory Bot A2' })).id;
      botB = (await bots.create(userB, { name: 'Memory Bot B' })).id;

      conversationA1 = await newConversation(userA, botA1, 'A1 facts');
      conversationA2 = await newConversation(userA, botA1, 'A2 facts');
      conversationA3 = await newConversation(userA, botA2, 'A3 other bot');
      conversationB = await newConversation(userB, botB, 'B facts');

      messageA1 = await chat.messages.append(userA, {
        conversationId: conversationA1.id,
        role: 'user',
        content: 'I like jasmine tea.',
      });
      messageA2 = await chat.messages.append(userA, {
        conversationId: conversationA2.id,
        role: 'user',
        content: 'My timezone is Asia/Manila.',
      });
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

    test('proposes with both gates off and requires acceptance even after both approvals', async () => {
      const proposed = await propose(
        userA,
        conversationA1,
        'Prefers jasmine tea.',
        messageA1.id,
      );

      assert.match(proposed.id, UUID_PATTERN);
      assert.equal(proposed.botId, botA1);
      assert.equal(proposed.conversationId, conversationA1.id);
      assert.equal(proposed.sourceMessageId, messageA1.id);
      assert.equal(proposed.status, 'proposed');
      assert.equal(proposed.botApproved, false);
      assert.equal(proposed.conversationApproved, false);
      assert.equal(proposed.provenanceState, 'live');
      assert.equal(proposed.provenanceTombstonedAt, null);
      assert.equal(proposed.deletedAt, null);

      assert.deepEqual(await recalledIds(userA, botA1, conversationA1.id), []);

      const botOnly = await memory.approveBot(userA, proposed.id);
      assert.equal(botOnly.botApproved, true);
      assert.equal(botOnly.conversationApproved, false);
      assert.equal(botOnly.status, 'proposed');
      assert.deepEqual(await recalledIds(userA, botA1, conversationA1.id), []);
      await rejectsWithCode(memory.accept(userA, proposed.id), 'invalid_input');

      const bothGates = await memory.approveConversation(userA, proposed.id);
      assert.equal(bothGates.botApproved, true);
      assert.equal(bothGates.conversationApproved, true);
      assert.equal(bothGates.status, 'proposed');

      // Both gates are on, but nothing is recalled without explicit acceptance.
      assert.deepEqual(await recalledIds(userA, botA1, conversationA1.id), []);

      const accepted = await memory.accept(userA, proposed.id);
      assert.equal(accepted.status, 'accepted');
      assert.deepEqual(await recalledIds(userA, botA1, conversationA1.id), [
        proposed.id,
      ]);

      const actions = (await auditFor(proposed.id)).map((row) => row.action);
      assert.deepEqual(actions, [
        'propose',
        'approve_bot',
        'approve_conversation',
        'accept',
      ]);
    });

    test('either recall gate alone cannot produce recall', async () => {
      const conversation = await newConversation(
        userA,
        botA1,
        'Single gate fixture',
      );
      const botOnly = await propose(
        userA,
        conversation,
        'Bot-gated fact only.',
      );
      await memory.approveBot(userA, botOnly.id);
      await rejectsWithCode(memory.accept(userA, botOnly.id), 'invalid_input');
      assert.deepEqual(await recalledIds(userA, botA1, conversation.id), []);

      const conversationOnly = await propose(
        userA,
        conversation,
        'Conversation-gated fact only.',
      );
      await memory.approveConversation(userA, conversationOnly.id);
      await rejectsWithCode(
        memory.accept(userA, conversationOnly.id),
        'invalid_input',
      );
      assert.deepEqual(await recalledIds(userA, botA1, conversation.id), []);

      assert.equal(
        (await memory.get(userA, conversationOnly.id)).botApproved,
        false,
      );
    });

    test('approval setters default to off and revocation demotes acceptance', async () => {
      const conversation = await newConversation(
        userA,
        botA1,
        'Approval setter fixture',
      );
      const proposed = await propose(
        userA,
        conversation,
        'Temporarily approved fact.',
      );

      const botDefault = await memory.setBotApprovalDefault(userA, proposed.id);
      const conversationDefault = await memory.setConversationApproval(
        userA,
        proposed.id,
      );
      assert.equal(botDefault.botApproved, false);
      assert.equal(conversationDefault.conversationApproved, false);
      assert.equal((await auditFor(proposed.id)).length, 1, 'no-op setters do not audit');

      await memory.setBotApprovalDefault(userA, proposed.id, true);
      await memory.setConversationApproval(userA, proposed.id, true);
      const accepted = await memory.accept(userA, proposed.id);
      assert.equal(accepted.status, 'accepted');
      assert.deepEqual(await recalledIds(userA, botA1, conversation.id), [
        proposed.id,
      ]);

      // Omitting the argument restores the off default and stops recall.
      const revoked = await memory.setBotApprovalDefault(userA, proposed.id);
      assert.equal(revoked.botApproved, false);
      assert.equal(revoked.status, 'proposed');
      assert.deepEqual(await recalledIds(userA, botA1, conversation.id), []);

      await memory.approveBot(userA, proposed.id);
      assert.equal((await memory.accept(userA, proposed.id)).status, 'accepted');
      assert.deepEqual(await recalledIds(userA, botA1, conversation.id), [
        proposed.id,
      ]);

      const revokedConversation = await memory.setConversationApproval(
        userA,
        proposed.id,
        false,
      );
      assert.equal(revokedConversation.status, 'proposed');
      assert.deepEqual(await recalledIds(userA, botA1, conversation.id), []);
    });

    test('accepts no-op idempotently and records one acceptance audit row', async () => {
      const accepted = await acceptMemory(
        userA,
        (await propose(userA, conversationA1, 'Idempotent acceptance fact.')).id,
      );

      const repeated = await memory.accept(userA, accepted.id);
      assert.equal(repeated.status, 'accepted');
      assert.equal(repeated.id, accepted.id);

      const actions = (await auditFor(accepted.id)).map((row) => row.action);
      assert.equal(actions.filter((action) => action === 'accept').length, 1);
    });

    test('source message deletion retains accepted memory with tombstoned provenance and audit', async () => {
      const retained = await acceptMemory(
        userA,
        (
          await propose(
            userA,
            conversationA2,
            'Timezone is Asia/Manila.',
            messageA2.id,
          )
        ).id,
      );

      const proposal = await propose(
        userA,
        conversationA2,
        'An unaccepted proposal from the deleted source.',
      );

      const messageResult = await memory.onSourceDeleted(userA, {
        conversationId: conversationA2.id,
        sourceMessageId: messageA2.id,
      });
      assert.deepEqual(messageResult.retainedMemoryIds, [retained.id]);
      assert.deepEqual(messageResult.removedMemoryIds, []);

      const survivor = await memory.get(userA, retained.id);
      assert.equal(survivor.status, 'accepted');
      assert.equal(survivor.conversationId, null);
      assert.equal(survivor.sourceMessageId, null);
      assert.equal(survivor.provenanceState, 'tombstoned');
      assert.notEqual(survivor.provenanceTombstonedAt, null);
      assert.equal(survivor.botApproved, true);
      assert.equal(survivor.conversationApproved, true);

      // The conversation is still live, but the survived fact is not in scope.
      assert.deepEqual(await recalledIds(userA, botA1, conversationA2.id), []);

      const listed = await memory.list(userA, { botId: botA1 });
      assert.ok(listed.some((item) => item.id === retained.id));

      const retainedAudit = await auditFor(retained.id);
      const sourceAudit = retainedAudit.filter(
        (row) => row.action === 'source_delete',
      );
      assert.equal(sourceAudit.length, 1);
      assert.match(sourceAudit[0].note, new RegExp(messageA2.id));

      // A message-scoped deletion leaves other live memories in the conversation.
      const untouched = await memory.get(userA, proposal.id);
      assert.equal(untouched.status, 'proposed');
      assert.equal(untouched.provenanceState, 'live');

      // Conversation-level deletion removes the still-unaccepted proposal.
      const conversationResult = await memory.onSourceDeleted(userA, {
        conversationId: conversationA2.id,
      });
      assert.deepEqual(conversationResult.removedMemoryIds, [proposal.id]);

      const removed = await memory.list(userA, { status: 'deleted' });
      const removedRow = removed.find((item) => item.id === proposal.id);
      assert.ok(removedRow);
      assert.equal(removedRow.provenanceState, 'tombstoned');
      assert.equal(removedRow.conversationId, null);
      assert.equal(removedRow.sourceMessageId, null);

      assert.equal(
        (await auditFor(proposal.id)).filter(
          (row) => row.action === 'source_delete',
        ).length,
        1,
      );
    });

    test('source conversation deletion retains accepted and removes unaccepted memories', async () => {
      const conversation = await newConversation(
        userA,
        botA1,
        'Conversation deletion fixture',
      );
      const accepted = await acceptMemory(
        userA,
        (await propose(userA, conversation, 'Accepted before source deletion.')).id,
      );
      const proposal = await propose(
        userA,
        conversation,
        'Proposal before source deletion.',
      );

      const result = await memory.onSourceDeleted(userA, {
        conversationId: conversation.id,
      });
      assert.deepEqual(result.retainedMemoryIds, [accepted.id]);
      assert.deepEqual(result.removedMemoryIds, [proposal.id]);

      const survivor = await memory.get(userA, accepted.id);
      assert.equal(survivor.status, 'accepted');
      assert.equal(survivor.provenanceState, 'tombstoned');

      const removed = (
        await memory.list(userA, { status: 'deleted' })
      ).find((item) => item.id === proposal.id);
      assert.ok(removed);
      assert.equal(removed.status, 'deleted');
      assert.equal(removed.provenanceState, 'tombstoned');

      // The user may still delete the retained memory explicitly.
      const deleted = await memory.delete(userA, accepted.id);
      assert.equal(deleted.status, 'deleted');
    });

    test('explicit deletion stops recall and is owner-idempotent', async () => {
      const conversation = await newConversation(
        userA,
        botA1,
        'Deletion fixture conversation',
      );
      const accepted = await acceptMemory(
        userA,
        (await propose(userA, conversation, 'A fact to delete.')).id,
      );
      assert.deepEqual(await recalledIds(userA, botA1, conversation.id), [
        accepted.id,
      ]);

      const deleted = await memory.delete(userA, accepted.id);
      assert.equal(deleted.status, 'deleted');
      assert.notEqual(deleted.deletedAt, null);
      assert.deepEqual(await recalledIds(userA, botA1, conversation.id), []);

      const defaultList = await memory.list(userA, {
        conversationId: conversation.id,
      });
      assert.ok(!defaultList.some((item) => item.id === accepted.id));

      const deletedList = await memory.list(userA, {
        conversationId: conversation.id,
        status: 'deleted',
      });
      assert.ok(deletedList.some((item) => item.id === accepted.id));

      await rejectsWithCode(memory.get(userA, accepted.id), 'not_found');
      await rejectsWithCode(memory.approveBot(userA, accepted.id), 'not_found');
      await rejectsWithCode(memory.accept(userA, accepted.id), 'not_found');

      const repeated = await memory.delete(userA, accepted.id);
      assert.equal(repeated.deletedAt, deleted.deletedAt);

      const deleteAudits = (await auditFor(accepted.id)).filter(
        (row) => row.action === 'delete',
      );
      assert.equal(deleteAudits.length, 1);
    });

    test('isolates memory by owner, Bot, and conversation, and hides guessed ids', async () => {
      const accepted = await acceptMemory(
        userA,
        (await propose(userA, conversationA1, 'Owner A private fact.')).id,
      );

      // Foreign owner: every operation is the same not-found.
      await rejectsWithCode(memory.get(userB, accepted.id), 'not_found');
      await rejectsWithCode(memory.approveBot(userB, accepted.id), 'not_found');
      await rejectsWithCode(
        memory.approveConversation(userB, accepted.id),
        'not_found',
      );
      await rejectsWithCode(memory.accept(userB, accepted.id), 'not_found');
      await rejectsWithCode(memory.delete(userB, accepted.id), 'not_found');
      await rejectsWithCode(
        memory.recall(userB, {
          botId: botA1,
          conversationId: conversationA1.id,
        }),
        'not_found',
      );
      await rejectsWithCode(
        memory.propose(userB, {
          botId: botA1,
          conversationId: conversationA1.id,
          content: 'Foreign proposal.',
        }),
        'not_found',
      );

      const userBList = await memory.list(userB);
      assert.ok(!userBList.some((item) => item.id === accepted.id));

      // Foreign delete does not even tombstone the row.
      assert.equal((await memory.get(userA, accepted.id)).status, 'accepted');

      // Bot mismatch: a proposal under another owned Bot is rejected.
      await rejectsWithCode(
        memory.propose(userA, {
          botId: botA2,
          conversationId: conversationA1.id,
          content: 'Mismatched Bot proposal.',
        }),
        'not_found',
      );

      // Conversation isolation under the same Bot.
      assert.deepEqual(await recalledIds(userA, botA1, conversationA2.id), []);
      assert.deepEqual(
        await recalledIds(userA, botA1, conversationA3.id),
        [],
      );

      // Bot isolation: the same conversation id under another Bot recalls nothing.
      assert.deepEqual(await recalledIds(userA, botA2, conversationA1.id), []);

      // Guessed ids are not found, including recall's conversation scope.
      const guessed = randomUUID();
      await rejectsWithCode(memory.get(userA, guessed), 'not_found');
      await rejectsWithCode(memory.approveBot(userA, guessed), 'not_found');
      await rejectsWithCode(
        memory.approveConversation(userA, guessed),
        'not_found',
      );
      await rejectsWithCode(memory.accept(userA, guessed), 'not_found');
      await rejectsWithCode(memory.delete(userA, guessed), 'not_found');
      await rejectsWithCode(
        memory.recall(userA, { botId: botA1, conversationId: guessed }),
        'not_found',
      );

      // A foreign owner cannot drive source deletion for A's conversation.
      const foreignSourceDeletion = await memory.onSourceDeleted(userB, {
        conversationId: conversationA1.id,
      });
      assert.deepEqual(foreignSourceDeletion, {
        retainedMemoryIds: [],
        removedMemoryIds: [],
      });
      assert.equal((await memory.get(userA, accepted.id)).provenanceState, 'live');

      // User B's own conversation is separate.
      const bMemory = await acceptMemory(
        userB,
        (await propose(userB, conversationB, 'Owner B private fact.')).id,
      );
      assert.deepEqual(
        await recalledIds(userB, botB, conversationB.id),
        [bMemory.id],
      );
      assert.ok(
        !(await memory.list(userA)).some((item) => item.id === bMemory.id),
      );
    });

    test('filters and paginates owner-scoped listings deterministically', async () => {
      const conversation = await newConversation(
        userA,
        botA1,
        'Listing fixture conversation',
      );
      const proposed = await propose(userA, conversation, 'Listing proposed fact.');
      const acceptedOne = await acceptMemory(
        userA,
        (await propose(userA, conversation, 'Listing accepted fact one.')).id,
      );
      const acceptedTwo = await acceptMemory(
        userA,
        (await propose(userA, conversation, 'Listing accepted fact two.')).id,
      );
      const deleted = await acceptMemory(
        userA,
        (await propose(userA, conversation, 'Listing deleted fact.')).id,
      );
      await memory.delete(userA, deleted.id);

      const allLive = await memory.list(userA, {
        conversationId: conversation.id,
      });
      assert.deepEqual(
        allLive.map((item) => item.id).sort(),
        [proposed.id, acceptedOne.id, acceptedTwo.id].sort(),
      );

      const acceptedOnly = await memory.list(userA, {
        conversationId: conversation.id,
        status: 'accepted',
      });
      assert.deepEqual(
        acceptedOnly.map((item) => item.id).sort(),
        [acceptedOne.id, acceptedTwo.id].sort(),
      );

      const deletedOnly = await memory.list(userA, {
        conversationId: conversation.id,
        status: 'deleted',
      });
      assert.deepEqual(
        deletedOnly.map((item) => item.id),
        [deleted.id],
      );

      const botFiltered = await memory.list(userA, {
        botId: botA1,
        conversationId: conversation.id,
      });
      assert.equal(botFiltered.length, 3);

      const otherBot = await memory.list(userA, {
        botId: botA2,
        conversationId: conversation.id,
      });
      assert.deepEqual(otherBot, []);

      const fullOrder = (
        await memory.list(userA, { conversationId: conversation.id, limit: 3 })
      ).map((item) => item.id);
      const firstPage = (
        await memory.list(userA, {
          conversationId: conversation.id,
          limit: 2,
        })
      ).map((item) => item.id);
      const secondPage = (
        await memory.list(userA, {
          conversationId: conversation.id,
          limit: 2,
          offset: 2,
        })
      ).map((item) => item.id);

      assert.equal(firstPage.length, 2);
      assert.equal(secondPage.length, 1);
      assert.deepEqual([...firstPage, ...secondPage], fullOrder);
      assert.deepEqual(
        await memory.list(userA, {
          conversationId: conversation.id,
          offset: 100,
        }),
        [],
      );

      await rejectsWithCode(
        memory.list(userA, { limit: 0 }),
        'invalid_input',
      );
      await rejectsWithCode(
        memory.list(userA, { offset: -1 }),
        'invalid_input',
      );
      await rejectsWithCode(
        memory.list(userA, { status: 'unknown' }),
        'invalid_input',
      );

      // Foreign owner sees nothing for A's conversation.
      assert.deepEqual(
        await memory.list(userB, { conversationId: conversation.id }),
        [],
      );
    });

    test('enforces acceptance, provenance, lifecycle, and content guards in SQL', async () => {
      const insert = (overrides = {}) => {
        const row = {
          id: randomUUID(),
          status: 'proposed',
          botApproved: false,
          conversationApproved: false,
          provenanceState: 'live',
          conversationId: conversationA1.id,
          sourceMessageId: null,
          tombstonedAt: null,
          content: 'Directly inserted fact.',
          deletedAt: null,
          ...overrides,
        };

        return pool.query(
          `INSERT INTO memories (
             id, owner_user_id, bot_id, conversation_id, content,
             source_message_id, status, bot_approved, conversation_approved,
             provenance_state, provenance_tombstoned_at, deleted_at
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           RETURNING id`,
          [
            row.id,
            userA,
            botA1,
            row.conversationId,
            row.content,
            row.sourceMessageId,
            row.status,
            row.botApproved,
            row.conversationApproved,
            row.provenanceState,
            row.tombstonedAt,
            row.deletedAt,
          ],
        );
      };

      // Accepted requires both approvals.
      await rejectsWithPgCode(insert({ status: 'accepted' }), '23514');
      await rejectsWithPgCode(
        insert({
          status: 'accepted',
          botApproved: true,
          conversationApproved: false,
        }),
        '23514',
      );

      // A live row cannot have tombstoned provenance, and vice versa.
      await rejectsWithPgCode(
        insert({
          provenanceState: 'tombstoned',
          conversationId: null,
          tombstonedAt: null,
        }),
        '23514',
      );
      await rejectsWithPgCode(
        insert({
          provenanceState: 'tombstoned',
          conversationId: conversationA1.id,
          tombstonedAt: new Date().toISOString(),
        }),
        '23514',
      );

      // Deleted state and timestamp must agree.
      await rejectsWithPgCode(
        insert({ status: 'deleted', deletedAt: null }),
        '23514',
      );
      await rejectsWithPgCode(
        insert({ status: 'proposed', deletedAt: new Date().toISOString() }),
        '23514',
      );

      // Content bounds.
      await rejectsWithPgCode(insert({ content: '   ' }), '23514');
      await rejectsWithPgCode(insert({ content: 'x'.repeat(4001) }), '23514');

      // A Memory's Bot must match its source conversation's Bot.
      await rejectsWithPgCode(
        pool.query(
          `INSERT INTO memories (
             id, owner_user_id, bot_id, conversation_id, content
           )
           VALUES ($1, $2, $3, $4, $5)`,
          [randomUUID(), userA, botA2, conversationA1.id, 'Mismatched Bot.'],
        ),
        '23503',
      );

      // Audit action vocabulary, note bound, and same-owner memory reference.
      const inserted = await insert();
      const memoryId = inserted.rows[0].id;
      await rejectsWithPgCode(
        pool.query(
          `INSERT INTO memory_audit (
             owner_user_id, memory_id, action, actor_user_id, note
           )
           VALUES ($1, $2, 'update', $1, '')`,
          [userA, memoryId],
        ),
        '23514',
      );
      await rejectsWithPgCode(
        pool.query(
          `INSERT INTO memory_audit (
             owner_user_id, memory_id, action, actor_user_id, note
           )
           VALUES ($1, $2, 'propose', $1, $3)`,
          [userA, memoryId, 'x'.repeat(501)],
        ),
        '23514',
      );
      await rejectsWithPgCode(
        pool.query(
          `INSERT INTO memory_audit (
             owner_user_id, memory_id, action, actor_user_id, note
           )
           VALUES ($1, $2, 'propose', $1, '')`,
          [userB, memoryId],
        ),
        '23503',
      );
    });

    test('keeps audit rows append-only by convention with no service mutation path', async () => {
      const accepted = await acceptMemory(
        userA,
        (await propose(userA, conversationA1, 'Audited fact.')).id,
      );

      const beforeRows = await auditFor(accepted.id);
      assert.deepEqual(
        beforeRows.map((row) => row.action),
        ['propose', 'approve_bot', 'approve_conversation', 'accept'],
      );

      await memory.delete(userA, accepted.id);
      const afterDelete = await auditFor(accepted.id);
      assert.equal(afterDelete.length, beforeRows.length + 1);
      assert.deepEqual(
        afterDelete.slice(0, beforeRows.length).map((row) => row.id),
        beforeRows.map((row) => row.id),
        'earlier audit rows are preserved unchanged',
      );

      // Idempotent and failed operations append nothing.
      await memory.delete(userA, accepted.id);
      await rejectsWithCode(memory.approveBot(userA, accepted.id), 'not_found');
      await rejectsWithCode(
        memory.approveBot(userB, accepted.id),
        'not_found',
      );
      assert.equal((await auditFor(accepted.id)).length, afterDelete.length);

      const methods = Object.getOwnPropertyNames(memory.constructor.prototype);
      assert.deepEqual(
        methods.sort(),
        [
          'accept',
          'approveBot',
          'approveConversation',
          'constructor',
          'delete',
          'get',
          'list',
          'onSourceDeleted',
          'propose',
          'recall',
          'setBotApprovalDefault',
          'setConversationApproval',
        ].sort(),
      );
      assert.ok(
        !methods.some((name) => /audit/i.test(name)),
        'service exposes no audit mutation method',
      );
    });

    test('archived Bot denies recall while the memory stays inspectable', async () => {
      const accepted = await acceptMemory(
        userA,
        (await propose(userA, conversationA3, 'Archived Bot fact.')).id,
      );
      assert.deepEqual(await recalledIds(userA, botA2, conversationA3.id), [
        accepted.id,
      ]);

      await bots.archive(userA, botA2);

      assert.deepEqual(await recalledIds(userA, botA2, conversationA3.id), []);
      assert.equal((await memory.get(userA, accepted.id)).status, 'accepted');

      await rejectsWithCode(
        memory.propose(userA, {
          botId: botA2,
          conversationId: conversationA3.id,
          content: 'New fact under an archived Bot.',
        }),
        'not_found',
      );
    });
  },
);
