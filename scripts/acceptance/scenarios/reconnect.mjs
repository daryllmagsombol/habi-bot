/**
 * H-025 scenario: mobile sleep / network loss and SSE resume.
 *
 * A client disconnects after part of a run's event stream, the run continues,
 * and the client reconnects with the standard `Last-Event-ID` cursor. The
 * assertion is exact: every sequence appears once, in order, and nothing from
 * before the cursor is replayed.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BACKEND_ROOT } from '../lib/process.mjs';
import { createClient, openSse, readAllSse } from '../lib/http.mjs';
import { runCheck } from './_check.mjs';

function eventFrames(frames) {
  return frames.filter((frame) => frame.event !== undefined);
}

export const reconnectScenario = {
  id: 'reconnect',
  title: 'Mobile reconnect: SSE resume without duplicate or lost events',
  async run(ctx) {
    const checks = [];
    const world = await ctx.ensureWorld();
    const p1 = await ctx.ensureP1();
    const session = p1.sessionFor(world.users.A);
    const request = createClient(p1.base, session);
    const { events } = world.services;

    const created = await request(
      `/api/threads/${world.conversations.A.id}/messages`,
      {
        method: 'POST',
        csrf: true,
        body: {
          content: 'reconnect acceptance probe',
          clientMessageId: 'acceptance-reconnect-1',
        },
      },
    );

    assert.equal(created.status, 201, JSON.stringify(created.body));
    const runId = created.body.runId;

    await events.append(world.users.A, {
      runId,
      type: 'run.created',
      payload: { dispatchState: 'not_dispatched' },
    });
    await events.append(world.users.A, {
      runId,
      type: 'message.delta',
      payload: { text: 'Hel' },
    });

    let firstConnection;

    await runCheck(checks, 'a mobile client receives a partial live stream', async () => {
      const sse = await openSse(p1.base, `/api/runs/${runId}/events`, {
        cookie: session.cookie,
      });

      assert.equal(sse.ok, true, `SSE open returned ${sse.status}`);

      const received = [];

      for await (const frame of sse.frames) {
        if (frame.event === undefined) {
          continue;
        }

        received.push({ seq: frame.json.seq, event: frame.event, id: frame.id });

        if (received.length === 2) {
          break;
        }
      }

      firstConnection = received;

      assert.deepEqual(
        received.map((item) => item.seq),
        [1, 2],
        'the live stream did not deliver the first two events',
      );

      return {
        status: sse.status,
        seqs: received.map((item) => item.seq),
        lastEventIdPresent: received.at(-1)?.id !== undefined,
      };
    });

    // The run continues while the client is asleep.
    await events.append(world.users.A, {
      runId,
      type: 'message.completed',
      payload: { messageId: 'reconnect-message' },
    });
    await events.append(world.users.A, {
      runId,
      type: 'run.completed',
      payload: { errorCode: null },
    });

    await runCheck(checks, 'Last-Event-ID resumes exactly after the last seen event', async () => {
      const lastSeen = firstConnection?.at(-1);

      assert.ok(lastSeen?.id, 'the first stream carried no event id to resume from');

      const sse = await openSse(p1.base, `/api/runs/${runId}/events`, {
        cookie: session.cookie,
        lastEventId: lastSeen.id,
      });

      assert.equal(sse.ok, true, `resume returned ${sse.status}`);

      const frames = eventFrames(await readAllSse(sse));
      const seqs = frames.map((frame) => frame.json.seq);

      assert.deepEqual(seqs, [3, 4], `resumed stream was ${JSON.stringify(seqs)}`);
      assert.equal(new Set(seqs).size, seqs.length, 'resumed stream duplicated an event');
      assert.equal(frames.at(-1)?.event, 'run.completed');

      return {
        resumedSeqs: seqs,
        duplicateSeqs: seqs.length - new Set(seqs).size,
        terminalEvent: frames.at(-1)?.event,
      };
    });

    await runCheck(checks, 'a full replay contains each event exactly once', async () => {
      const sse = await openSse(p1.base, `/api/runs/${runId}/events`, {
        cookie: session.cookie,
      });

      assert.equal(sse.ok, true);

      const seqs = eventFrames(await readAllSse(sse)).map((frame) => frame.json.seq);

      assert.deepEqual(seqs, [1, 2, 3, 4]);
      assert.equal(new Set(seqs).size, seqs.length);

      return { seqs };
    });

    await runCheck(checks, 'a cursor from another Run is not enumerable', async () => {
      const eventsModule = await import(
        pathToFileURL(join(BACKEND_ROOT, 'dist/events/index.js')).href
      );
      const foreignId = eventsModule.encodeRunEventCursor(world.runs.B.runId, 1);

      const sse = await openSse(p1.base, `/api/runs/${runId}/events`, {
        cookie: session.cookie,
        lastEventId: foreignId,
      });

      assert.equal(sse.ok, false);
      assert.equal(sse.status, 404);
      assert.deepEqual(sse.body, { error: { code: 'not_found' } });

      return { status: sse.status, code: sse.body.error.code };
    });

    return {
      checks,
      evidence: {
        runId,
        firstConnectionSeqs: firstConnection?.map((item) => item.seq),
        totalEvents: 4,
      },
    };
  },
};
