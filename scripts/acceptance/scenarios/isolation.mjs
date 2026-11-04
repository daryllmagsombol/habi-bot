/**
 * H-025 scenario: two-account isolation.
 *
 * Exercises every owner-scoped HTTP surface the P1 API exposes, then the
 * services whose routes are not wired yet. A cross-user read must be the same
 * `404 {"error":{"code":"not_found"}}` as an unknown or malformed id; a
 * service-level cross-user read must be `PersistenceNotFoundError`.
 */
import assert from 'node:assert/strict';
import { createClient } from '../lib/http.mjs';
import { MALFORMED_ID } from '../lib/seed.mjs';
import { runCheck } from './_check.mjs';

const NOT_FOUND = { error: { code: 'not_found' } };

function expectHttpNotFound(result, label) {
  assert.equal(result.status, 404, `${label}: status ${result.status}`);
  assert.deepEqual(result.body, NOT_FOUND, `${label}: body leaks a distinction`);
}

async function expectServiceNotFound(promise, label) {
  try {
    await promise;
  } catch (error) {
    assert.equal(error?.code, 'not_found', `${label}: ${error?.name ?? 'error'}`);
    return { error: 'not_found' };
  }

  throw new Error(`${label}: expected not_found, service returned a row`);
}

export const isolationScenario = {
  id: 'isolation',
  title: 'Two-account isolation across every owner-scoped surface',
  async run(ctx) {
    const checks = [];
    const world = await ctx.ensureWorld();
    const p1 = await ctx.ensureP1();
    const requestA = createClient(p1.base, p1.sessionFor(world.users.A));
    const requestB = createClient(p1.base, p1.sessionFor(world.users.B));

    await runCheck(checks, 'bot list is owner scoped', async () => {
      const result = await requestA('/api/bots');

      assert.equal(result.status, 200);
      const ids = result.body.bots.map((bot) => bot.id);

      assert.ok(ids.includes(world.bots.A.id), 'A must see its own Bot');
      assert.ok(!ids.includes(world.bots.B.id), 'A must not see B\'s Bot');

      return { botCount: ids.length, ownBotPresent: true, foreignBotPresent: false };
    });

    await runCheck(checks, 'foreign and malformed HTTP ids share one 404', async () => {
      const probes = [
        ['GET', `/api/bots/${world.bots.B.id}`],
        ['GET', `/api/bots/${MALFORMED_ID}`],
        ['GET', `/api/bots/${world.bots.B.id}/threads`],
        ['GET', `/api/threads/${world.conversations.B.id}/messages`],
        ['GET', `/api/threads/${MALFORMED_ID}/messages`],
        ['GET', `/api/runs/${world.runs.B.runId}/events`],
        ['GET', `/api/runs/${MALFORMED_ID}/events`],
        ['POST', `/api/runs/${world.runs.B.runId}/cancel`],
        ['POST', `/api/threads/${world.conversations.B.id}/messages`],
        ['POST', `/api/threads/${MALFORMED_ID}/messages`],
      ];
      const statuses = [];

      for (const [method, path] of probes) {
        const result = await requestA(path, {
          method,
          ...(method === 'POST' ? { body: { content: 'cross-user attempt' }, csrf: true } : {}),
        });

        expectHttpNotFound(result, `${method} ${path}`);
        statuses.push({ method, path: path.replaceAll(world.bots.B.id, ':foreignBot').replaceAll(world.conversations.B.id, ':foreignConversation').replaceAll(world.runs.B.runId, ':foreignRun').replaceAll(MALFORMED_ID, ':malformed'), status: result.status, code: result.body.error.code });
      }

      return statuses;
    });

    await runCheck(checks, 'foreign message was not persisted', async () => {
      const before = await world.services.messages.list(world.users.B, world.conversations.B.id);
      const attempt = await requestA(`/api/threads/${world.conversations.B.id}/messages`, {
        method: 'POST',
        csrf: true,
        body: { content: 'cross-user write must not land' },
      });
      const after = await world.services.messages.list(world.users.B, world.conversations.B.id);

      expectHttpNotFound(attempt, 'foreign message write');
      assert.equal(after.messages.length, before.messages.length);

      return { before: before.messages.length, after: after.messages.length };
    });

    await runCheck(checks, 'own same-id surfaces stay readable', async () => {
      const bots = await requestA('/api/bots');
      const threads = await requestA(`/api/bots/${world.bots.A.id}/threads`);
      const messages = await requestA(
        `/api/threads/${world.conversations.A.id}/messages`,
      );

      assert.equal(bots.status, 200);
      assert.equal(threads.status, 200);
      assert.equal(messages.status, 200);
      assert.ok(messages.body.messages.length >= 2);

      return {
        ownBotListed: bots.body.bots.some((bot) => bot.id === world.bots.A.id),
        ownThreadsStatus: threads.status,
        ownMessageCount: messages.body.messages.length,
      };
    });

    await runCheck(checks, 'artifact service denies cross-owner reads', async () => {
      await expectServiceNotFound(
        world.services.artifacts.get(world.users.A, world.artifacts.B.artifact.id),
        'artifact get',
      );
      const list = await world.services.artifacts.list(world.users.A);

      assert.ok(!list.artifacts.some((item) => item.id === world.artifacts.B.artifact.id));

      return { foreignVisibleInList: false };
    });

    await runCheck(checks, 'attachment metadata and bytes deny cross-owner reads', async () => {
      await expectServiceNotFound(
        world.services.attachments.getMetadata(world.users.A, world.attachments.B.id),
        'attachment metadata',
      );
      await expectServiceNotFound(
        world.services.attachments.readContent(world.users.A, world.attachments.B.id),
        'attachment bytes',
      );
      await expectServiceNotFound(
        world.services.attachments.listForConversation(
          world.users.A,
          world.conversations.B.id,
        ),
        'attachment list',
      );

      return { metadata: 'not_found', bytes: 'not_found', list: 'not_found' };
    });

    await runCheck(checks, 'memory service denies cross-owner reads', async () => {
      await expectServiceNotFound(
        world.services.memory.get(world.users.A, world.memories.B.id),
        'memory get',
      );
      const list = await world.services.memory.list(world.users.A);

      assert.ok(!list.some((item) => item.id === world.memories.B.id));

      return { foreignVisibleInList: false };
    });

    await runCheck(checks, 'skill service denies cross-owner reads', async () => {
      await expectServiceNotFound(
        world.services.skills.get(world.users.A, world.skills.B.id),
        'skill get',
      );
      const list = await world.services.skills.list(world.users.A);

      assert.ok(!list.skills.some((item) => item.id === world.skills.B.id));

      return { foreignVisibleInList: false };
    });

    await runCheck(checks, 'search is owner scoped', async () => {
      const foreign = await world.services.search.searchMessages({
        actorUserId: world.users.A,
        query: 'zebrabeta',
      });
      const foreignConversations = await world.services.conversationSearch.searchConversations({
        actorUserId: world.users.A,
        query: 'zebrabeta',
      });
      const own = await world.services.search.searchMessages({
        actorUserId: world.users.A,
        query: 'zebraalpha',
      });

      assert.equal(foreign.hits.length, 0, 'A search must not return B content');
      assert.equal(foreignConversations.conversations.length, 0);
      assert.ok(own.hits.length > 0, 'A search must return A content');

      return {
        foreignMessageHits: foreign.hits.length,
        foreignConversationHits: foreignConversations.conversations.length,
        ownMessageHits: own.hits.length,
      };
    });

    await runCheck(checks, 'foreign Bot profile detail is not exposed', async () => {
      const result = await requestA(`/api/bots/${world.bots.B.id}`);

      expectHttpNotFound(result, 'foreign bot detail');

      return { status: result.status, code: result.body.error.code };
    });

    return {
      checks,
      evidence: {
        accountA: world.users.A,
        accountB: world.users.B,
        botA: world.bots.A.id,
        botB: world.bots.B.id,
        conversationA: world.conversations.A.id,
        conversationB: world.conversations.B.id,
        runA: world.runs.A.runId,
        runB: world.runs.B.runId,
        artifactA: world.artifacts.A.artifact.id,
        artifactB: world.artifacts.B.artifact.id,
        attachmentA: world.attachments.A.id,
        attachmentB: world.attachments.B.id,
        memoryA: world.memories.A.id,
        memoryB: world.memories.B.id,
        skillA: world.skills.A.id,
        skillB: world.skills.B.id,
      },
      residualRisks: [
        'Artifact, attachment, memory, and skill HTTP routes are not wired in this commit; their isolation is proven at the service layer, not through the browser surface.',
      ],
    };
  },
};
