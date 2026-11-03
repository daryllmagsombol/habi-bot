/**
 * H-021 (#21) Hermes HTTP adapter smoke suite.
 *
 * Everything runs against a local node:http stub: no Hermes process, no real
 * provider, no credential. Each test asserts the adapter contract rather than
 * vendor copy:
 *
 *   create / duplicate idempotency     same Habi run, one upstream call
 *   SSE replay                          ordered seq, duplicate delivery deduped
 *   401                                 auth_rejected, one attempt, no retry
 *   error-in-200 / 202-then-failed      classified as failed
 *   cancel                              stopping -> cancelled, usage unknown
 *   steer                               accepted / rejected mapping
 *   restart 404                         lost, dispatch unknown, no retry
 *   usage                               known / partial / unknown, never zero
 *   timeout                             dispatch unknown, one attempt
 *   credential hygiene                  key absent from errors and console
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, beforeEach, describe, test } from 'node:test';
import {
  HarnessAdapterError,
} from '../dist/adapters/harness-adapter.js';
import { HermesHttpAdapter } from '../dist/adapters/hermes-http-adapter.js';
import {
  classifyHarnessStatus,
  lostDispatchState,
} from '../dist/adapters/recovery.js';

const GATEWAY_KEY = 'test-gateway-key-never-logged';
const RUN_ID = 'run_habi_1';
const HARNESS_RUN_ID = 'hermes_run_1';
const DEADLINE = '2030-01-01T00:00:00.000Z';

function jsonResponse(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

function sseResponse(res, events) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  for (const event of events) {
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }

  res.end();
}

function safeJson(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function startStub() {
  const state = {
    calls: [],
    handler: null,
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const chunks = [];

    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      const record = {
        method: req.method,
        path: url.pathname,
        search: url.search,
        headers: req.headers,
        body: safeJson(rawBody),
      };

      state.calls.push(record);

      const handler =
        state.handler ??
        (({ res: response }) => jsonResponse(response, 404, { code: 'not_found' }));

      Promise.resolve(handler({ req, res, url, record })).catch(() => {
        if (!res.headersSent) {
          jsonResponse(res, 500, { code: 'stub_handler_error' });
        }
      });
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();

  if (address === null || typeof address === 'string') {
    throw new Error('stub server did not expose a port');
  }

  return {
    base: `http://127.0.0.1:${address.port}`,
    get calls() {
      return state.calls;
    },
    setHandler(handler) {
      state.handler = handler;
    },
    reset() {
      state.calls.length = 0;
      state.handler = null;
    },
    callsTo(path) {
      return state.calls.filter(
        (call) => call.method === 'POST' && call.path === path,
      );
    },
    async stop() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

function createRequest(overrides = {}) {
  return {
    runId: RUN_ID,
    idempotencyKey: 'idem-1',
    correlationId: 'corr-1',
    ownerUserId: 'user-a',
    conversationId: 'conv-a',
    botId: 'bot-a',
    messages: [
      {
        role: 'user',
        content: 'Reply with exactly: OK',
        messageId: 'msg-1',
      },
    ],
    deadlineAt: DEADLINE,
    tokenBudget: { maxInputTokens: 1000, maxOutputTokens: null },
    allowedTools: [],
    ...overrides,
  };
}

function createAdapter(stub, overrides = {}) {
  return new HermesHttpAdapter({
    baseUrl: stub.base,
    gatewayKey: GATEWAY_KEY,
    requestTimeoutMs: 2000,
    eventIdleTimeoutMs: 2000,
    ...overrides,
  });
}

function installCreateHandler(stub, { status = 202, replayed = false } = {}) {
  stub.setHandler(({ req, res, url }) => {
    if (req.method === 'POST' && url.pathname === '/v1/runs') {
      jsonResponse(
        res,
        status,
        { run_id: HARNESS_RUN_ID, status: 'started', replayed },
        { 'idempotency-replayed': String(replayed) },
      );
      return;
    }

    jsonResponse(res, 404, { code: 'not_found' });
  });
}

async function collect(iterable) {
  const events = [];

  for await (const event of iterable) {
    events.push(event);
  }

  return events;
}

async function captureAsync(fn) {
  try {
    await fn();
  } catch (error) {
    return error;
  }

  assert.fail('Expected the call to reject.');
}

function assertAdapterError(error, code, dispatchState) {
  assert.ok(error instanceof HarnessAdapterError, 'expected HarnessAdapterError');
  assert.equal(error.name, 'HarnessAdapterError');
  assert.equal(error.code, code);
  assert.equal(error.dispatchState, dispatchState);
  assert.equal(error.retryable, false);
}

describe('Hermes HTTP adapter', () => {
  let stub;

  before(async () => {
    stub = await startStub();
  });

  beforeEach(() => {
    stub.reset();
  });

  after(async () => {
    await stub.stop();
  });

  test('create and duplicate idempotency key return one run with one upstream call', async (t) => {
    installCreateHandler(stub);
    const adapter = createAdapter(stub);
    t.after(() => adapter.close());

    const first = await adapter.createRun(createRequest());
    const second = await adapter.createRun(createRequest());

    assert.equal(first.runId, RUN_ID);
    assert.equal(first.harnessRunId, HARNESS_RUN_ID);
    assert.equal(first.dispatchState, 'dispatched');
    assert.equal(first.deduplicated, false);
    assert.equal(second.runId, RUN_ID);
    assert.equal(second.deduplicated, true);

    const creates = stub.callsTo('/v1/runs');
    assert.equal(creates.length, 1, 'duplicate key must not dispatch twice');
    assert.equal(creates[0].headers.authorization, `Bearer ${GATEWAY_KEY}`);
    assert.equal(creates[0].headers['idempotency-key'], 'idem-1');
    assert.equal(creates[0].headers['x-habi-run-id'], RUN_ID);
    assert.equal(creates[0].headers['x-habi-owner-user-id'], 'user-a');
    assert.equal(creates[0].headers['x-habi-conversation-id'], 'conv-a');

    // Same key with a different body is a conflict, not a second dispatch.
    const conflict = await captureAsync(() =>
      adapter.createRun(
        createRequest({ messages: [{ role: 'user', content: 'different', messageId: 'msg-2' }] }),
      ),
    );
    assertAdapterError(conflict, 'idempotency_conflict', 'not_dispatched');
    assert.equal(stub.callsTo('/v1/runs').length, 1);
  });

  test('ordered SSE with duplicate delivery is deduped by (runId, seq)', async (t) => {
    installCreateHandler(stub);
    const adapter = createAdapter(stub);
    t.after(() => adapter.close());

    await adapter.createRun(createRequest());

    stub.setHandler(({ req, res, url }) => {
      if (req.method === 'GET' && url.pathname === `/v1/runs/${HARNESS_RUN_ID}/events`) {
        sseResponse(res, [
          { seq: 0, type: 'message.delta', text: 'O' },
          { seq: 1, type: 'message.delta', text: 'K' },
          { seq: 1, type: 'message.delta', text: 'K' },
          { seq: 2, type: 'run.completed', finish_reason: 'stop' },
        ]);
        return;
      }

      jsonResponse(res, 404, { code: 'not_found' });
    });

    const events = await collect(adapter.subscribe({ runId: RUN_ID, afterSeq: 0 }));

    assert.deepEqual(events.map((event) => event.seq), [0, 1, 2]);
    assert.equal(events.at(-1).type, 'run.completed');
    assert.equal(events[0].runId, RUN_ID, 'events carry the Habi run id');
    assert.equal(events[0].ownerUserId, 'user-a');

    const streamCall = stub.calls.find((call) => call.path.endsWith('/events'));
    assert.equal(streamCall.search, '?after_seq=0');
  });

  test('rejects non-empty allowedTools before dispatch', async (t) => {
    installCreateHandler(stub);
    const adapter = createAdapter(stub);
    t.after(() => adapter.close());

    const error = await captureAsync(() =>
      adapter.createRun(createRequest({ allowedTools: ['shell'] })),
    );

    assertAdapterError(error, 'policy_denied', 'not_dispatched');
    assert.equal(stub.callsTo('/v1/runs').length, 0);
  });

  test('401 maps to auth_rejected with one attempt and no retry', async (t) => {
    stub.setHandler(({ res }) => jsonResponse(res, 401, { code: 'unauthorized' }));
    const adapter = createAdapter(stub);
    t.after(() => adapter.close());

    const error = await captureAsync(() => adapter.createRun(createRequest()));

    assertAdapterError(error, 'auth_rejected', 'not_dispatched');
    assert.equal(error.httpStatus, 401);
    assert.equal(stub.callsTo('/v1/runs').length, 1);
    assert.equal(error.message.includes(GATEWAY_KEY), false);
  });

  test('HTTP 200 with an error finish is a failure, not an empty success', async (t) => {
    installCreateHandler(stub);
    const adapter = createAdapter(stub);
    t.after(() => adapter.close());

    await adapter.createRun(createRequest());

    stub.setHandler(({ res }) =>
      jsonResponse(res, 200, {
        run_id: HARNESS_RUN_ID,
        status: 'completed',
        finish_reason: 'error',
      }),
    );

    const snapshot = await adapter.getRun(RUN_ID);

    assert.equal(snapshot.status, 'failed');
    assert.equal(snapshot.harnessStatus, 'failed');
    assert.equal(stub.calls.filter((call) => call.method === 'GET').length, 1);
  });

  test('202 create followed by failed status is a failure', async (t) => {
    installCreateHandler(stub, { status: 202 });
    const adapter = createAdapter(stub);
    t.after(() => adapter.close());

    const created = await adapter.createRun(createRequest());
    assert.equal(created.dispatchState, 'dispatched');

    stub.setHandler(({ res }) =>
      jsonResponse(res, 200, {
        run_id: HARNESS_RUN_ID,
        status: 'failed',
        last_event: 'run.failed',
      }),
    );

    const snapshot = await adapter.getRun(RUN_ID);

    assert.equal(snapshot.status, 'failed');
    assert.equal(snapshot.harnessStatus, 'failed');
    assert.equal(stub.calls.filter((call) => call.method === 'GET').length, 1);
  });

  test('cancel goes stopping -> cancelled and reports unknown usage, never zero', async (t) => {
    installCreateHandler(stub);
    const adapter = createAdapter(stub);
    t.after(() => adapter.close());

    await adapter.createRun(createRequest());

    let status = 'stopping';
    stub.setHandler(({ req, res, url }) => {
      if (req.method === 'POST' && url.pathname === `/v1/runs/${HARNESS_RUN_ID}/stop`) {
        jsonResponse(res, 200, { status });
        return;
      }

      if (req.method === 'GET' && url.pathname === `/v1/runs/${HARNESS_RUN_ID}`) {
        jsonResponse(res, 200, {
          status,
          last_event: status === 'cancelled' ? 'run.cancelled' : 'run.stopping',
          usage: null,
        });
        return;
      }

      jsonResponse(res, 404, { code: 'not_found' });
    });

    const cancelled = await adapter.cancel({ runId: RUN_ID, reason: 'user' });

    assert.equal(cancelled.status, 'cancelling');
    assert.equal(cancelled.dispatchState, 'dispatched');

    status = 'cancelled';
    const snapshot = await adapter.getRun(RUN_ID);
    assert.equal(snapshot.status, 'cancelled');

    const usage = await adapter.getUsage(RUN_ID);
    assert.equal(usage.usageStatus, 'unknown');
    for (const field of [
      'grossPromptTokens',
      'grossCompletionTokens',
      'cachedPromptTokens',
      'reasoningTokens',
      'totalTokens',
    ]) {
      assert.equal(usage[field], null, `${field} must be null, never 0`);
    }

    // Cancel is idempotent: a terminal run needs no second stop call.
    const again = await adapter.cancel({ runId: RUN_ID, reason: 'user' });
    assert.equal(again.status, 'cancelled');
    assert.equal(stub.callsTo(`/v1/runs/${HARNESS_RUN_ID}/stop`).length, 1);
  });

  test('steer maps accepted, rejected, not-running, and already-terminal', async (t) => {
    installCreateHandler(stub);
    const adapter = createAdapter(stub);
    t.after(() => adapter.close());

    await adapter.createRun(createRequest());

    let steerCount = 0;
    let runStatus = 'running';
    stub.setHandler(({ req, res, url }) => {
      if (req.method === 'POST' && url.pathname === `/v1/runs/${HARNESS_RUN_ID}/steer`) {
        steerCount += 1;

        if (steerCount === 1) {
          jsonResponse(res, 200, { accepted: true });
          return;
        }

        if (steerCount === 2) {
          jsonResponse(res, 200, { accepted: false });
          return;
        }

        jsonResponse(res, 409, { code: 'not_running' });
        return;
      }

      if (req.method === 'GET' && url.pathname === `/v1/runs/${HARNESS_RUN_ID}`) {
        jsonResponse(res, 200, { status: runStatus });
        return;
      }

      jsonResponse(res, 404, { code: 'not_found' });
    });

    const accepted = await adapter.steer({
      runId: RUN_ID,
      text: 'adjust',
      clientSteerId: 'steer-1',
    });
    assert.deepEqual(accepted, { accepted: true });

    const rejected = await adapter.steer({
      runId: RUN_ID,
      text: 'adjust',
      clientSteerId: 'steer-2',
    });
    assert.deepEqual(rejected, { accepted: false, reason: 'rejected_by_harness' });

    const notRunning = await adapter.steer({
      runId: RUN_ID,
      text: 'adjust',
      clientSteerId: 'steer-3',
    });
    assert.deepEqual(notRunning, { accepted: false, reason: 'not_running' });

    runStatus = 'cancelled';
    await adapter.getRun(RUN_ID);

    const callsBefore = steerCount;
    const terminal = await adapter.steer({
      runId: RUN_ID,
      text: 'adjust',
      clientSteerId: 'steer-4',
    });
    assert.deepEqual(terminal, { accepted: false, reason: 'already_terminal' });
    assert.equal(steerCount, callsBefore, 'terminal steer must not call upstream');
  });

  test('404 after restart maps to lost with unknown dispatch and no retry', async (t) => {
    installCreateHandler(stub);
    const adapter = createAdapter(stub);
    t.after(() => adapter.close());

    await adapter.createRun(createRequest());

    stub.setHandler(({ res }) =>
      jsonResponse(res, 404, { code: 'run_not_found' }),
    );

    const report = await adapter.recoverAfterRestart({ runIds: [RUN_ID] });

    assert.equal(report.outcomes.length, 1);
    const [outcome] = report.outcomes;
    assert.equal(outcome.kind, 'lost');
    assert.equal(outcome.runId, RUN_ID);
    assert.equal(outcome.dispatchState, 'unknown');
    assert.equal(stub.calls.filter((call) => call.path === `/v1/runs/${HARNESS_RUN_ID}`).length, 1);
  });

  test('recoverAfterRestart separates terminal, still-running, and lost', async (t) => {
    installCreateHandler(stub);
    const adapter = createAdapter(stub);
    t.after(() => adapter.close());

    await adapter.createRun(createRequest());

    stub.setHandler(({ res }) =>
      jsonResponse(res, 200, {
        status: 'running',
        last_seq: 4,
        version: 2,
      }),
    );

    const running = await adapter.recoverAfterRestart({ runIds: [RUN_ID] });
    assert.equal(running.outcomes[0].kind, 'still_running');
    assert.equal(running.outcomes[0].resumeAfterSeq, 0);
    assert.equal(running.outcomes[0].snapshot.status, 'running');

    stub.setHandler(({ res }) =>
      jsonResponse(res, 200, { status: 'completed', last_seq: 5, usage: {} }),
    );

    const terminal = await adapter.recoverAfterRestart({ runIds: [RUN_ID] });
    assert.equal(terminal.outcomes[0].kind, 'confirmed_terminal');
    assert.equal(terminal.outcomes[0].snapshot.status, 'completed');

    const unknownRun = await adapter.recoverAfterRestart({ runIds: ['run_never_seen'] });
    assert.equal(unknownRun.outcomes[0].kind, 'lost');
    assert.equal(unknownRun.outcomes[0].dispatchState, 'unknown');
  });

  test('usage mapping reports known, partial, and unknown without fabricating zero', async (t) => {
    installCreateHandler(stub);
    const adapter = createAdapter(stub);
    t.after(() => adapter.close());

    await adapter.createRun(createRequest());

    let usagePayload = {
      input_tokens: 741,
      output_tokens: 22,
      total_tokens: 763,
      cache_read_tokens: 256,
      cache_write_tokens: 0,
    };
    stub.setHandler(({ res }) =>
      jsonResponse(res, 200, { status: 'completed', usage: usagePayload }),
    );

    const known = await adapter.getUsage(RUN_ID);
    assert.equal(known.usageStatus, 'known');
    assert.equal(known.grossPromptTokens, 741);
    assert.equal(known.grossCompletionTokens, 22);
    assert.equal(known.totalTokens, 763);
    assert.equal(known.cachedPromptTokens, 256);
    assert.equal(known.costStatus, 'unknown');
    assert.equal(known.raw.cache_write_tokens, 0);

    usagePayload = { input_tokens: 10 };
    const partial = await adapter.getUsage(RUN_ID);
    assert.equal(partial.usageStatus, 'partial');
    assert.equal(partial.grossPromptTokens, 10);
    assert.equal(partial.grossCompletionTokens, null);
    assert.equal(partial.totalTokens, null);

    usagePayload = { input_tokens: 10, output_tokens: 5 };
    const partialSum = await adapter.getUsage(RUN_ID);
    assert.equal(partialSum.usageStatus, 'partial');
    assert.equal(partialSum.totalTokens, 15, 'a missing total may use the defensible sum');

    usagePayload = { input_tokens: 10, output_tokens: 5, total_tokens: 99 };
    const inconsistent = await adapter.getUsage(RUN_ID);
    assert.equal(inconsistent.usageStatus, 'unknown');
    for (const field of [
      'grossPromptTokens',
      'grossCompletionTokens',
      'totalTokens',
      'cachedPromptTokens',
      'reasoningTokens',
    ]) {
      assert.equal(inconsistent[field], null);
    }

    usagePayload = null;
    const unknown = await adapter.getUsage(RUN_ID);
    assert.equal(unknown.usageStatus, 'unknown');
    assert.equal(unknown.totalTokens, null);
    assert.equal(unknown.grossPromptTokens, null);
  });

  test('timeout maps to unknown dispatch with one attempt and no retry', async (t) => {
    // Never responds: the adapter must time out, not retry.
    stub.setHandler(() => {});
    const adapter = createAdapter(stub, { requestTimeoutMs: 75 });
    t.after(() => adapter.close());

    const error = await captureAsync(() => adapter.createRun(createRequest()));

    assertAdapterError(error, 'timeout', 'unknown');
    assert.equal(stub.callsTo('/v1/runs').length, 1);
  });

  test('the gateway key never appears in errors or console output', async (t) => {
    const captured = [];
    const original = {};

    for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
      original[level] = console[level];
      console[level] = (...args) => {
        captured.push(args.map((value) => String(value)).join(' '));
      };
    }

    try {
      stub.setHandler(({ res }) => jsonResponse(res, 401, { code: 'unauthorized' }));
      const adapter = createAdapter(stub);
      t.after(() => adapter.close());

      const error = await captureAsync(() => adapter.createRun(createRequest()));

      assertAdapterError(error, 'auth_rejected', 'not_dispatched');
      assert.equal(String(error.message).includes(GATEWAY_KEY), false);
      assert.equal(String(error.stack).includes(GATEWAY_KEY), false);
      assert.equal(JSON.stringify(error).includes(GATEWAY_KEY), false);

      for (const line of captured) {
        assert.equal(line.includes(GATEWAY_KEY), false, `console leaked the key: ${line}`);
      }
    } finally {
      for (const level of Object.keys(original)) {
        console[level] = original[level];
      }
    }
  });

  test('recovery helpers classify terminal, still-running, and lost dispatch', () => {
    assert.equal(classifyHarnessStatus('completed'), 'confirmed_terminal');
    assert.equal(classifyHarnessStatus('failed'), 'confirmed_terminal');
    assert.equal(classifyHarnessStatus('cancelled'), 'confirmed_terminal');
    assert.equal(classifyHarnessStatus('waiting_for_approval'), 'confirmed_terminal');
    assert.equal(classifyHarnessStatus('running'), 'still_running');
    assert.equal(classifyHarnessStatus('stopping'), 'still_running');
    assert.equal(classifyHarnessStatus(null), null);

    assert.equal(lostDispatchState('not_dispatched'), 'not_dispatched');
    assert.equal(lostDispatchState('dispatched'), 'unknown');
    assert.equal(lostDispatchState('unknown'), 'unknown');
  });
});
