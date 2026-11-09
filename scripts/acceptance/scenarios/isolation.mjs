/**
 * H-025 scenario: two-account isolation.
 *
 * Exercises every owner-scoped HTTP surface the P1 API exposes. A cross-user
 * read must be the same `404 {"error":{"code":"not_found"}}` as an unknown or
 * malformed id. Artifacts, attachments, memory, skills, and search are now
 * checked through their routes, not by calling the services directly.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createClient } from '../lib/http.mjs';
import { MALFORMED_ID } from '../lib/seed.mjs';
import { runCheck } from './_check.mjs';

const NOT_FOUND = { error: { code: 'not_found' } };

function expectHttpNotFound(result, label) {
  assert.equal(result.status, 404, `${label}: status ${result.status}`);
  assert.deepEqual(result.body, NOT_FOUND, `${label}: body leaks a distinction`);
}

function redactPath(path, world) {
  return path
    .replaceAll(world.bots.B.id, ':foreignBot')
    .replaceAll(world.conversations.B.id, ':foreignConversation')
    .replaceAll(world.runs.B.runId, ':foreignRun')
    .replaceAll(world.artifacts.B.artifact.id, ':foreignArtifact')
    .replaceAll(world.attachments.B.id, ':foreignAttachment')
    .replaceAll(world.memories.B.id, ':foreignMemory')
    .replaceAll(world.skills.B.id, ':foreignSkill')
    .replaceAll(MALFORMED_ID, ':malformed');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export const isolationScenario = {
  id: 'isolation',
  title: 'Two-account isolation across every owner-scoped surface',
  async run(ctx) {
    const checks = [];
    const world = await ctx.ensureWorld();

    // The API reads attachment bytes from the same private root the fixture
    // wrote them to. Metadata needs no root; the byte route does.
    process.env.HABI_ATTACHMENT_STORAGE_ROOT = world.storageRoot;

    const p1 = await ctx.ensureP1();
    const requestA = createClient(p1.base, p1.sessionFor(world.users.A));
    const requestB = createClient(p1.base, p1.sessionFor(world.users.B));

    await runCheck(checks, 'bot list is owner scoped', async () => {
      const result = await requestA('/api/bots');

      assert.equal(result.status, 200);
      const ids = new Set(result.body.bots.map((bot) => bot.id));

      assert.ok(ids.has(world.bots.A.id), 'A must see its own Bot');
      assert.ok(!ids.has(world.bots.B.id), 'A must not see B\'s Bot');

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
        ['POST', `/api/threads/${world.conversations.B.id}/messages`, { content: 'cross-user attempt' }],
        ['POST', `/api/threads/${MALFORMED_ID}/messages`, { content: 'cross-user attempt' }],

        // Bot archive/edit and thread creation.
        ['PATCH', `/api/bots/${world.bots.B.id}`, { name: 'cross-user rename' }],
        ['PATCH', `/api/bots/${MALFORMED_ID}`, { name: 'malformed rename' }],
        ['DELETE', `/api/bots/${world.bots.B.id}`],
        ['DELETE', `/api/bots/${MALFORMED_ID}`],
        ['POST', `/api/bots/${world.bots.B.id}/threads`, { title: 'cross-user thread' }],
        ['POST', `/api/bots/${MALFORMED_ID}/threads`, { title: 'malformed thread' }],
        ['PATCH', `/api/threads/${world.conversations.B.id}`, { title: 'cross-user rename' }],
        ['PATCH', `/api/threads/${MALFORMED_ID}`, { title: 'malformed rename' }],
        ['DELETE', `/api/threads/${world.conversations.B.id}`],
        ['DELETE', `/api/threads/${MALFORMED_ID}`],

        // Attachments: list, metadata, and bytes.
        ['GET', `/api/threads/${world.conversations.B.id}/attachments`],
        ['GET', `/api/threads/${MALFORMED_ID}/attachments`],
        ['GET', `/api/attachments/${world.attachments.B.id}`],
        ['GET', `/api/attachments/${MALFORMED_ID}`],
        ['GET', `/api/attachments/${world.attachments.B.id}/content`],
        ['GET', `/api/attachments/${MALFORMED_ID}/content`],

        // Artifacts: create scope, read, update, history, restore.
        [
          'POST',
          '/api/artifacts',
          {
            kind: 'text',
            title: 'cross-user artifact',
            content: 'must not land',
            conversationId: world.conversations.B.id,
          },
        ],
        ['GET', `/api/artifacts/${world.artifacts.B.artifact.id}`],
        ['GET', `/api/artifacts/${MALFORMED_ID}`],
        ['PATCH', `/api/artifacts/${world.artifacts.B.artifact.id}`, { content: 'cross-user' }],
        ['PATCH', `/api/artifacts/${MALFORMED_ID}`, { content: 'malformed' }],
        ['GET', `/api/artifacts/${world.artifacts.B.artifact.id}/versions`],
        ['GET', `/api/artifacts/${MALFORMED_ID}/versions`],
        ['POST', `/api/artifacts/${world.artifacts.B.artifact.id}/restore`, { version: 1 }],
        ['POST', `/api/artifacts/${MALFORMED_ID}/restore`, { version: 1 }],

        // Memory: list, propose, and approvals.
        ['GET', `/api/bots/${world.bots.B.id}/memories`],
        ['GET', `/api/bots/${MALFORMED_ID}/memories`],
        [
          'POST',
          `/api/bots/${world.bots.B.id}/memories`,
          { text: 'cross-user memory', threadId: world.conversations.B.id },
        ],
        [
          'POST',
          `/api/bots/${MALFORMED_ID}/memories`,
          { text: 'malformed memory', threadId: world.conversations.A.id },
        ],
        [
          'POST',
          `/api/memories/${world.memories.B.id}/approvals`,
          { bot: true, thread: false },
        ],
        [
          'POST',
          `/api/memories/${MALFORMED_ID}/approvals`,
          { bot: true, thread: false },
        ],

        // Skills: read, attach, detach, and Bot filter.
        ['GET', `/api/skills/${world.skills.B.id}`],
        ['GET', `/api/skills/${MALFORMED_ID}`],
        ['POST', `/api/skills/${world.skills.B.id}/attach`, { botId: world.bots.A.id }],
        ['POST', `/api/skills/${MALFORMED_ID}/attach`, { botId: world.bots.A.id }],
        ['POST', `/api/skills/${world.skills.B.id}/detach`],
        ['POST', `/api/skills/${MALFORMED_ID}/detach`],
        ['GET', `/api/skills?botId=${world.bots.B.id}`],
        ['GET', `/api/skills?botId=${MALFORMED_ID}`],
      ];
      const statuses = [];

      for (const [method, path, body] of probes) {
        const result = await requestA(path, {
          method,
          body,
          csrf: method !== 'GET',
        });

        expectHttpNotFound(result, `${method} ${path}`);
        statuses.push({
          method,
          path: redactPath(path, world),
          status: result.status,
          code: result.body.error.code,
        });
      }

      return statuses;
    });

    await runCheck(checks, "B's own session is denied A's ids", async () => {
      const symmetric = [
        ['GET', `/api/bots/${world.bots.A.id}`],
        ['GET', `/api/threads/${world.conversations.A.id}/messages`],
        ['GET', `/api/artifacts/${world.artifacts.A.artifact.id}`],
        [
          'POST',
          `/api/memories/${world.memories.A.id}/approvals`,
          { bot: true, thread: false },
        ],
        ['DELETE', `/api/threads/${world.conversations.A.id}`],
      ];

      for (const [method, path, body] of symmetric) {
        const result = await requestB(path, {
          method,
          body,
          csrf: method !== 'GET',
        });

        expectHttpNotFound(result, `${method} ${path}`);
      }

      return { probed: symmetric.length };
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

    await runCheck(checks, 'artifact HTTP reads are owner scoped', async () => {
      const own = await requestA(`/api/artifacts/${world.artifacts.A.artifact.id}`);

      assert.equal(own.status, 200);
      assert.equal(own.body.artifact.artifact.id, world.artifacts.A.artifact.id);

      const list = await requestA('/api/artifacts');
      assert.equal(list.status, 200);
      const ids = new Set(list.body.artifacts.map((item) => item.id));

      assert.ok(ids.has(world.artifacts.A.artifact.id));
      assert.ok(!ids.has(world.artifacts.B.artifact.id));

      return {
        ownReadStatus: own.status,
        ownVersion: own.body.artifact.version.version,
        foreignVisibleInList: false,
      };
    });

    await runCheck(checks, 'attachment HTTP metadata and bytes are owner scoped', async () => {
      const list = await requestA(
        `/api/threads/${world.conversations.A.id}/attachments`,
      );

      assert.equal(list.status, 200);
      assert.ok(list.body.attachments.some((item) => item.id === world.attachments.A.id));
      assert.ok(!list.body.attachments.some((item) => item.id === world.attachments.B.id));

      const metadata = await requestA(`/api/attachments/${world.attachments.A.id}`);
      assert.equal(metadata.status, 200);
      assert.equal(metadata.body.attachment.id, world.attachments.A.id);
      assert.equal(metadata.body.attachment.sha256, world.attachments.A.sha256);

      const content = await requestA(
        `/api/attachments/${world.attachments.A.id}/content`,
      );
      assert.equal(content.status, 200);
      assert.equal(content.body, 'zebraalpha attachment');
      assert.equal(sha256(content.body), metadata.body.attachment.sha256);

      // A stored non-text attachment is refused at the representation layer,
      // after ownership was proven.
      const png = await world.services.attachments.createUpload(
        world.users.A,
        world.conversations.A.id,
        {
          filename: 'alpha.png',
          contentType: 'image/png',
          source: (async function* pngBytes() {
            yield Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
          })(),
        },
      );
      await world.services.attachments.finalize(world.users.A, png.id);
      const refused = await requestA(`/api/attachments/${png.id}/content`);
      assert.equal(refused.status, 415);
      assert.deepEqual(refused.body, { error: { code: 'unsupported_media_type' } });

      return {
        listStatus: list.status,
        contentShaVerified: true,
        nonTextStatus: refused.status,
      };
    });

    await runCheck(checks, 'memory HTTP reads and approvals are owner scoped', async () => {
      const list = await requestA(`/api/bots/${world.bots.A.id}/memories`);

      assert.equal(list.status, 200);
      assert.ok(list.body.memories.some((item) => item.id === world.memories.A.id));
      assert.ok(!list.body.memories.some((item) => item.id === world.memories.B.id));

      const approved = await requestA(
        `/api/memories/${world.memories.A.id}/approvals`,
        {
          method: 'POST',
          csrf: true,
          body: {
            bot: true,
            thread: true,
            threadId: world.conversations.A.id,
          },
        },
      );
      assert.equal(approved.status, 200);
      assert.equal(approved.body.memory.botApproved, true);
      assert.equal(approved.body.memory.conversationApproved, true);
      assert.equal(approved.body.memory.status, 'accepted');

      return {
        listStatus: list.status,
        foreignVisibleInList: false,
        acceptedThroughHttp: approved.body.memory.status === 'accepted',
      };
    });

    await runCheck(checks, 'skill HTTP attach and detach are owner scoped', async () => {
      const list = await requestA(`/api/skills?botId=${world.bots.A.id}`);

      assert.equal(list.status, 200);
      assert.ok(list.body.skills.some((item) => item.id === world.skills.A.id));
      assert.ok(!list.body.skills.some((item) => item.id === world.skills.B.id));

      const detached = await requestA(`/api/skills/${world.skills.A.id}/detach`, {
        method: 'POST',
        csrf: true,
      });
      assert.equal(detached.status, 200);
      assert.equal(detached.body.skill.botId, null);

      const attached = await requestA(`/api/skills/${world.skills.A.id}/attach`, {
        method: 'POST',
        csrf: true,
        body: { botId: world.bots.A.id },
      });
      assert.equal(attached.status, 200);
      assert.equal(attached.body.skill.botId, world.bots.A.id);

      return {
        listStatus: list.status,
        detached: detached.body.skill.botId,
        reattached: attached.body.skill.botId,
      };
    });

    await runCheck(checks, 'search is owner scoped over HTTP', async () => {
      const foreign = await requestA('/api/search?q=zebrabeta');
      const foreignFiltered = await requestA(
        `/api/search?q=zebraalpha&botId=${world.bots.B.id}`,
      );
      const own = await requestA('/api/search?q=zebraalpha');

      assert.equal(foreign.status, 200);
      assert.equal(foreign.body.results.length, 0, 'A search must not return B content');
      assert.equal(foreignFiltered.body.results.length, 0);
      assert.ok(own.body.results.length > 0, 'A search must return A content');

      return {
        foreignMessageHits: foreign.body.results.length,
        foreignFilteredHits: foreignFiltered.body.results.length,
        ownMessageHits: own.body.results.length,
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
        'Attachment byte reads require HABI_ATTACHMENT_STORAGE_ROOT; metadata alone does not, and an unconfigured root answers 503 api_unavailable.',
        'A Memory proposal is still sourced from a live thread, so POST /api/bots/:botId/memories needs a threadId in addition to text.',
      ],
    };
  },
};
