/**
 * H-025 scenario: provider exhaustion.
 *
 * The real Hermes adapter maps HTTP 402 to `provider_exhausted` with
 * `dispatchState: not_dispatched`. The Run must fail recoverably, release its
 * allowance hold, charge nothing, and never try a second provider. The local
 * stub is the only upstream configured.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createClient } from '../lib/http.mjs';
import { waitFor } from '../lib/process.mjs';
import { runCheck } from './_check.mjs';

export const providerExhaustionScenario = {
  id: 'provider-exhaustion',
  title: 'Provider exhaustion is recoverable with no paid fallback',
  async run(ctx) {
    const checks = [];
    const world = await ctx.ensureWorld();
    const p1 = await ctx.ensureP1();
    const stub = await ctx.ensureHermes();

    try {
      await runCheck(checks, 'exhaustion fails once, releases the hold, and charges nothing', async () => {
        const userId = randomUUID();

        await ctx.pool.query('INSERT INTO users (id) VALUES ($1)', [userId]);

        const bot = await world.services.bots.create(userId, {
          name: 'Exhaustion Bot',
        });
        const conversation = await world.services.conversations.create(userId, {
          botId: bot.id,
          title: 'Exhaustion thread',
        });
        const request = createClient(p1.base, p1.sessionFor(userId));

        stub.queueBehavior('exhausted');
        const submitted = await request(
          `/api/threads/${conversation.id}/messages`,
          {
            method: 'POST',
            csrf: true,
            body: { content: 'exhaustion probe', clientMessageId: 'exhaustion-1' },
          },
        );

        assert.equal(submitted.status, 201, JSON.stringify(submitted.body));

        await ctx.startWorker();

        const failed = await waitFor(
          async () => {
            const result = await ctx.pool.query(
              `SELECT status, dispatch_state, error_code, usage_status
                 FROM runs
                WHERE id = $1`,
              [submitted.body.runId],
            );
            const row = result.rows[0];

            return row?.status === 'failed' ? row : null;
          },
          'the exhausted Run to fail',
          { timeoutMs: 20_000 },
        );

        assert.equal(failed.error_code, 'provider_exhausted');
        assert.equal(failed.dispatch_state, 'not_dispatched');
        assert.equal(failed.usage_status, 'unknown');

        const reservation = await ctx.pool.query(
          `SELECT state, charged_tokens
             FROM usage_reservations
            WHERE run_id = $1`,
          [submitted.body.runId],
        );

        assert.equal(reservation.rows[0]?.state, 'released');
        assert.equal(Number(reservation.rows[0]?.charged_tokens), 0);

        const eventResult = await ctx.pool.query(
          `SELECT type, payload
             FROM run_events
            WHERE run_id = $1
            ORDER BY seq ASC`,
          [submitted.body.runId],
        );
        const terminal = eventResult.rows.filter((row) =>
          ['run.completed', 'run.failed', 'run.cancelled'].includes(row.type),
        );

        assert.equal(terminal.length, 1);
        assert.equal(terminal[0].type, 'run.failed');
        assert.equal(terminal[0].payload.errorCode, 'provider_exhausted');

        await new Promise((resolve) => setTimeout(resolve, 600));
        const creates = stub.requests.filter(
          (entry) =>
            entry.method === 'POST' &&
            entry.path === '/v1/runs' &&
            entry.habiRunId === submitted.body.runId,
        );

        assert.equal(creates.length, 1, 'provider exhaustion was retried or fell back');

        return {
          runId: submitted.body.runId,
          status: failed.status,
          errorCode: failed.error_code,
          dispatchState: failed.dispatch_state,
          usageStatus: failed.usage_status,
          reservationState: reservation.rows[0]?.state,
          chargedTokens: Number(reservation.rows[0]?.charged_tokens),
          providerCreates: creates.length,
          terminalEvents: terminal.length,
        };
      });

      await runCheck(checks, 'a new Run is admitted after a released exhaustion', async () => {
        const userId = randomUUID();

        await ctx.pool.query('INSERT INTO users (id) VALUES ($1)', [userId]);

        const bot = await world.services.bots.create(userId, {
          name: 'Exhaustion Recovery Bot',
        });
        const conversation = await world.services.conversations.create(userId, {
          botId: bot.id,
          title: 'Exhaustion recovery thread',
        });
        const request = createClient(p1.base, p1.sessionFor(userId));

        // The same account first loses an exhausted Run, then retries with a new
        // key. Exhaustion released the hold, so admission must succeed.
        stub.queueBehavior('exhausted');
        const first = await request(`/api/threads/${conversation.id}/messages`, {
          method: 'POST',
          csrf: true,
          body: { content: 'exhausted first', clientMessageId: 'exhaustion-2' },
        });

        assert.equal(first.status, 201, JSON.stringify(first.body));

        await waitFor(
          async () => {
            const result = await ctx.pool.query(
              'SELECT status FROM runs WHERE id = $1',
              [first.body.runId],
            );

            return result.rows[0]?.status === 'failed';
          },
          'the first Run to fail',
          { timeoutMs: 20_000 },
        );

        stub.queueBehavior('normal');
        const retry = await request(`/api/threads/${conversation.id}/messages`, {
          method: 'POST',
          csrf: true,
          body: { content: 'exhausted retry', clientMessageId: 'exhaustion-3' },
        });

        assert.equal(retry.status, 201, JSON.stringify(retry.body));

        const completed = await waitFor(
          async () => {
            const result = await ctx.pool.query(
              'SELECT status FROM runs WHERE id = $1',
              [retry.body.runId],
            );

            return result.rows[0]?.status === 'completed' ? result.rows[0] : null;
          },
          'the retry Run to complete',
          { timeoutMs: 20_000 },
        );

        return {
          firstRun: first.body.runId,
          retryRun: retry.body.runId,
          retryStatus: completed.status,
        };
      });
    } finally {
      await ctx.stopWorker('SIGKILL').catch(() => {});
    }

    return {
      checks,
      evidence: {
        providerBaseUrls: 1,
        providerKind: 'local Hermes-compatible stub',
        fallbackProviderConfigured: false,
      },
      residualRisks: [
        'No real provider 402 was observed; the mapping is proven against the real adapter with a local stub, not vendor billing behavior.',
      ],
    };
  },
};
