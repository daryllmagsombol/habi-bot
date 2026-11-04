/**
 * H-025 scenario: cancel, retry, timeout, worker restart, duplicate submission.
 *
 * Runs the real worker child process against a local Hermes-compatible stub.
 * The stub is a test double at the documented adapter boundary; no provider
 * network, credential, or paid call is involved.
 *
 * Each sub-case uses a fresh account so an `unknown` usage bucket from one
 * uncertain outcome cannot make a later admission fail for an unrelated reason.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createClient } from '../lib/http.mjs';
import { waitFor } from '../lib/process.mjs';
import { blocked, runCheck } from './_check.mjs';

const NOT_DISPATCHED = 'not_dispatched';

async function runRow(pool, runId) {
  const result = await pool.query(
    `SELECT id, owner_user_id, status, dispatch_state, error_code,
            last_event_seq, finished_at
       FROM runs
      WHERE id = $1`,
    [runId],
  );

  return result.rows[0];
}

async function eventSeqs(pool, runId) {
  const result = await pool.query(
    'SELECT seq, type FROM run_events WHERE run_id = $1 ORDER BY seq ASC',
    [runId],
  );

  return result.rows.map((row) => ({ seq: Number(row.seq), type: row.type }));
}

async function terminalEventCount(pool, runId) {
  const result = await pool.query(
    `SELECT count(*)::int AS count
       FROM run_events
      WHERE run_id = $1
        AND type IN ('run.completed', 'run.failed', 'run.cancelled')`,
    [runId],
  );

  return result.rows[0]?.count ?? 0;
}

async function messageCount(pool, conversationId) {
  const result = await pool.query(
    'SELECT count(*)::int AS count FROM messages WHERE conversation_id = $1',
    [conversationId],
  );

  return result.rows[0]?.count ?? 0;
}

function postCreateCount(stub, runId) {
  return stub.requests.filter(
    (request) =>
      request.method === 'POST' &&
      request.path === '/v1/runs' &&
      request.habiRunId === runId,
  ).length;
}

export const runLifecycleScenario = {
  id: 'run-lifecycle',
  title: 'Cancel, retry, timeout, worker restart, and duplicate submission',
  async run(ctx) {
    const checks = [];
    const world = await ctx.ensureWorld();
    const p1 = await ctx.ensureP1();
    const stub = await ctx.ensureHermes();

    async function freshIdentity(label) {
      const userId = randomUUID();

      await ctx.pool.query('INSERT INTO users (id) VALUES ($1)', [userId]);

      const bot = await world.services.bots.create(userId, {
        name: `Lifecycle ${label}`,
        description: 'Acceptance lifecycle fixture.',
      });
      const conversation = await world.services.conversations.create(userId, {
        botId: bot.id,
        title: `Lifecycle ${label}`,
      });
      const session = p1.sessionFor(userId);

      return {
        userId,
        botId: bot.id,
        conversationId: conversation.id,
        request: createClient(p1.base, session),
      };
    }

    async function submit(identity, content, clientMessageId) {
      const result = await identity.request(
        `/api/threads/${identity.conversationId}/messages`,
        {
          method: 'POST',
          csrf: true,
          body: { content, clientMessageId },
        },
      );

      assert.equal(result.status, 201, `submit failed: ${JSON.stringify(result.body)}`);

      return result.body;
    }

    async function waitTerminal(runId, expected, timeoutMs = 20_000) {
      return waitFor(
        async () => {
          const row = await runRow(ctx.pool, runId);

          return row !== undefined && expected.includes(row.status) ? row : null;
        },
        `Run ${runId} to reach ${expected.join('/')}`,
        { timeoutMs },
      );
    }

    try {
      // 1. Duplicate submission and explicit user retry.
      await runCheck(checks, 'duplicate submission reuses one message and one Run', async () => {
        const identity = await freshIdentity('duplicate');
        stub.queueBehavior('normal');
        const first = await submit(identity, 'duplicate probe', 'duplicate-1');
        const beforeMessages = await messageCount(ctx.pool, identity.conversationId);
        const second = await submit(identity, 'duplicate probe', 'duplicate-1');

        assert.equal(second.messageId, first.messageId);
        assert.equal(second.runId, first.runId);

        await ctx.startWorker();
        const completed = await waitTerminal(first.runId, ['completed']);
        await waitFor(
          async () => (await terminalEventCount(ctx.pool, first.runId)) === 1,
          'one terminal event',
        );

        assert.equal(await messageCount(ctx.pool, identity.conversationId), beforeMessages);
        assert.equal(postCreateCount(stub, first.runId), 1, 'duplicate was dispatched twice');
        assert.equal(completed.dispatch_state, 'dispatched');

        const seqs = await eventSeqs(ctx.pool, first.runId);

        assert.equal(new Set(seqs.map((event) => event.seq)).size, seqs.length);

        return {
          runId: first.runId,
          messageId: first.messageId,
          providerCreates: postCreateCount(stub, first.runId),
          terminalEvents: await terminalEventCount(ctx.pool, first.runId),
          messageRows: await messageCount(ctx.pool, identity.conversationId),
        };
      });

      await runCheck(checks, 'a user retry is a new Run with no lost output', async () => {
        const identity = await freshIdentity('retry');
        stub.queueBehavior('normal');
        stub.queueBehavior('normal');
        const first = await submit(identity, 'retry probe one', 'retry-1');
        const second = await submit(identity, 'retry probe two', 'retry-2');

        assert.notEqual(first.runId, second.runId);

        const completed = await waitTerminal(first.runId, ['completed']);
        const retried = await waitTerminal(second.runId, ['completed']);

        assert.equal(postCreateCount(stub, first.runId), 1);
        assert.equal(postCreateCount(stub, second.runId), 1);

        for (const runId of [first.runId, second.runId]) {
          // The terminal event is appended after the terminal row commits.
          await waitFor(
            async () => (await terminalEventCount(ctx.pool, runId)) === 1,
            'one terminal event for each retry Run',
          );

          const seqs = await eventSeqs(ctx.pool, runId);
          const types = seqs.map((event) => event.type);

          assert.equal(types.at(-1), 'run.completed');
          assert.equal(new Set(seqs.map((event) => event.seq)).size, seqs.length);
        }

        return {
          first: { runId: first.runId, status: completed.status },
          retry: { runId: second.runId, status: retried.status },
        };
      });

      await ctx.stopWorker();

      // 2. Cancel before dispatch.
      await runCheck(checks, 'pre-dispatch cancel is terminal and never dispatches', async () => {
        const identity = await freshIdentity('cancel-pre');
        const created = await submit(identity, 'cancel before dispatch', 'cancel-pre-1');
        const cancelled = await identity.request(`/api/runs/${created.runId}/cancel`, {
          method: 'POST',
          csrf: true,
        });

        assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
        assert.equal(cancelled.body.run.status, 'cancelled');

        await ctx.startWorker();
        await new Promise((resolve) => setTimeout(resolve, 800));

        const row = await runRow(ctx.pool, created.runId);

        assert.equal(row.status, 'cancelled');
        assert.equal(row.dispatch_state, NOT_DISPATCHED);
        assert.equal(postCreateCount(stub, created.runId), 0);
        assert.equal(stub.runFor(created.runId), null);

        return {
          runId: created.runId,
          status: row.status,
          dispatchState: row.dispatch_state,
          providerCreates: 0,
        };
      });

      await ctx.stopWorker();

      // 3. Cancel after dispatch: the API refuses explicitly.
      let heldRunId;

      await runCheck(
        checks,
        'dispatched cancel is explicit, not a silent pretend-stop',
        async () => {
          const identity = await freshIdentity('cancel-mid');
          stub.queueBehavior('hold');
          const created = await submit(identity, 'cancel mid run', 'cancel-mid-1');
          heldRunId = created.runId;

          await ctx.startWorker();
          await waitFor(
            async () => (await eventSeqs(ctx.pool, created.runId)).length >= 1,
            'the held Run to stream its first event',
          );

          const cancelled = await identity.request(`/api/runs/${created.runId}/cancel`, {
            method: 'POST',
            csrf: true,
          });

          assert.equal(cancelled.status, 409);
          assert.deepEqual(cancelled.body, { error: { code: 'cancel_unavailable' } });

          const row = await runRow(ctx.pool, created.runId);

          assert.equal(row.status, 'running');
          assert.equal(postCreateCount(stub, created.runId), 1);

          return {
            runId: created.runId,
            status: cancelled.status,
            code: cancelled.body.error.code,
            runStatus: row.status,
          };
        },
      );

      checks.push(
        blocked(
          'a dispatched Run can be cancelled from the chat API',
          'The P1 chat API returns 409 cancel_unavailable once a Run is dispatched; no adapter cancel is wired into that surface.',
          { runId: heldRunId },
        ),
      );

      // 4. Hard worker restart while dispatched: no duplicate dispatch, no
      //    silent erasure of persisted events, explicit uncertainty.
      await runCheck(
        checks,
        'a killed worker leaves recoverable state with no duplicate dispatch',
        async () => {
          assert.ok(heldRunId, 'the mid-run cancel fixture did not run');

          const before = await eventSeqs(ctx.pool, heldRunId);

          assert.ok(before.length >= 1, 'no event was persisted before the kill');

          await ctx.stopWorker('SIGKILL');
          await ctx.startWorker();

          const recovered = await waitTerminal(heldRunId, [
            'execution_uncertain',
            'failed',
          ], 20_000);

          assert.equal(recovered.status, 'execution_uncertain');
          assert.equal(recovered.error_code, 'transport_ambiguous');
          assert.equal(postCreateCount(stub, heldRunId), 1, 'recovery re-dispatched');

          const after = await eventSeqs(ctx.pool, heldRunId);

          for (const event of before) {
            assert.ok(
              after.some((candidate) => candidate.seq === event.seq),
              `event ${event.seq} was lost`,
            );
          }

          await waitFor(
            async () => (await terminalEventCount(ctx.pool, heldRunId)) === 1,
            'exactly one terminal event after recovery',
          );

          return {
            runId: heldRunId,
            status: recovered.status,
            errorCode: recovered.error_code,
            providerCreates: postCreateCount(stub, heldRunId),
            persistedBeforeKill: before.length,
            persistedAfterRecovery: after.length,
          };
        },
      );

      await ctx.stopWorker();

      // 5. Timeout: one bounded attempt, explicit terminal state, no retry.
      await runCheck(checks, 'timeout is bounded and never retried automatically', async () => {
        const identity = await freshIdentity('timeout');
        stub.queueBehavior('timeout');
        const created = await submit(identity, 'timeout probe', 'timeout-1');

        await ctx.startWorker({ requestTimeoutMs: 400 });

        const timedOut = await waitTerminal(created.runId, ['execution_uncertain', 'failed'], 20_000);

        assert.equal(timedOut.status, 'execution_uncertain');
        assert.equal(timedOut.error_code, 'timeout');
        assert.equal(postCreateCount(stub, created.runId), 1);

        await new Promise((resolve) => setTimeout(resolve, 900));
        assert.equal(postCreateCount(stub, created.runId), 1, 'timeout was retried');

        await waitFor(
          async () => (await terminalEventCount(ctx.pool, created.runId)) === 1,
          'one terminal event after timeout',
        );

        return {
          runId: created.runId,
          status: timedOut.status,
          errorCode: timedOut.error_code,
          providerCreates: postCreateCount(stub, created.runId),
        };
      });

      await ctx.stopWorker();

      // 6. Graceful restart: a queued Run is still claimed exactly once.
      await runCheck(checks, 'a queued Run survives a worker restart and runs once', async () => {
        const identity = await freshIdentity('restart-graceful');
        stub.queueBehavior('normal');
        const created = await submit(identity, 'restart probe', 'restart-1');

        await ctx.startWorker();
        const completed = await waitTerminal(created.runId, ['completed']);

        await ctx.stopWorker();
        stub.queueBehavior('normal');
        const second = await submit(identity, 'restart probe two', 'restart-2');

        await ctx.startWorker();
        const completedAgain = await waitTerminal(second.runId, ['completed']);

        assert.equal(postCreateCount(stub, created.runId), 1);
        assert.equal(postCreateCount(stub, second.runId), 1);

        return {
          firstRunId: created.runId,
          firstStatus: completed.status,
          secondRunId: second.runId,
          secondStatus: completedAgain.status,
        };
      });
    } finally {
      await ctx.stopWorker('SIGKILL').catch(() => {});
    }

    return {
      checks,
      evidence: {
        stubBehavior: 'local Hermes-compatible HTTP stub; no provider network',
        workerMode: 'real compiled worker child process',
      },
      residualRisks: [
        'A hard kill after dispatch intentionally terminalizes as execution_uncertain and is not re-dispatched, because a possibly-paid call must not be repeated. Provider output that was emitted after the last persisted event is not recoverable.',
        'Pre-dispatch cancel in ApiService terminalizes the Run without appending a run.cancelled event, so an already-open event stream is not notified.',
        'The chat API has no dispatched-cancel path; that capability remains blocked at the HTTP surface.',
      ],
    };
  },
};
