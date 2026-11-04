/**
 * Local Hermes-compatible harness stub.
 *
 * This is not a provider. It implements the pinned Hermes API-server shape the
 * real `HermesHttpAdapter` speaks (create, status, SSE events, stop, steer) so
 * acceptance can exercise the real adapter, dispatcher, database, and worker
 * without a network provider, credential, or paid call.
 *
 * Behaviors are queued per create call:
 *   normal      four events then completion
 *   slow        same events with a delay between them
 *   hold        one event, then wait for a stop or the scenario teardown
 *   exhausted   402 before any run is accepted
 *   timeout     delay the create response past the worker's request bound
 *
 * Every request is recorded as status/route evidence only. The Authorization
 * header is never stored or returned.
 */
import { createServer } from 'node:http';

const RUN_STATUS_PATH = /^\/v1\/runs\/([^/]+)$/;
const RUN_EVENTS_PATH = /^\/v1\/runs\/([^/]+)\/events$/;
const RUN_STOP_PATH = /^\/v1\/runs\/([^/]+)\/stop$/;
const RUN_STEER_PATH = /^\/v1\/runs\/([^/]+)\/steer$/;

function json(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

function sse(response) {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
}

function frame(event) {
  return `event: ${event.type}\ndata: ${JSON.stringify({
    seq: event.seq,
    type: event.type,
    payload: event.payload,
    created_at: new Date().toISOString(),
  })}\n\n`;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createRun(state, habiRunId, behavior) {
  const run = {
    harnessRunId: `harness-${state.nextId}`,
    habiRunId,
    behavior,
    status: 'queued',
    lastSeq: 0,
    createCalls: 0,
    stopCalls: 0,
    steerCalls: 0,
    eventsRequests: 0,
    stopSignal: null,
    stopPromise: null,
  };

  state.runs.set(run.harnessRunId, run);

  return run;
}

function respondNotFound(response, record) {
  record.status = 404;
  json(response, 404, { error: 'not_found' });
}

/** Resolves a run by its harness id, answering 404 when it is unknown. */
function resolveRun(state, response, record, rawHarnessRunId) {
  const run = state.runs.get(decodeURIComponent(rawHarnessRunId)) ?? null;

  if (run === null) {
    respondNotFound(response, record);
  }

  return run;
}

async function readBody(request) {
  let raw = '';

  for await (const chunk of request) {
    raw += chunk;
  }

  return raw;
}

async function handleCreate(state, request, response, record) {
  const raw = await readBody(request);
  let body;

  try {
    body = raw === '' ? {} : JSON.parse(raw);
  } catch {
    record.status = 400;
    json(response, 400, { error: 'invalid_json' });
    return;
  }

  const habiRunId =
    typeof body.run_id === 'string' ? body.run_id : record.habiRunId;
  const behavior = state.behaviors.shift() ?? 'normal';

  record.behavior = behavior;

  if (habiRunId === null || habiRunId === undefined) {
    record.status = 400;
    json(response, 400, { error: 'missing_run_id' });
    return;
  }

  if (behavior === 'exhausted') {
    record.status = 402;
    json(response, 402, { error: 'provider_exhausted' });
    return;
  }

  if (behavior === 'timeout') {
    await sleep(1_500);
    record.status = 202;
    json(response, 202, {
      run_id: `harness-timeout-${state.nextId++}`,
      status: 'queued',
    });
    return;
  }

  const run = createRun(state, habiRunId, behavior);
  run.createCalls += 1;
  record.status = 202;
  json(response, 202, { run_id: run.harnessRunId, status: 'queued' });
}

function handleStatus(state, response, record, rawHarnessRunId) {
  const run = resolveRun(state, response, record, rawHarnessRunId);

  if (run === null) {
    return;
  }

  record.status = 200;
  json(response, 200, {
    run: {
      status: run.status,
      last_seq: run.lastSeq,
      usage:
        run.status === 'completed'
          ? { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
          : undefined,
    },
  });
}

function isHeld(behavior) {
  return behavior === 'hold' || behavior === 'restart';
}

function eventScript(run) {
  return isHeld(run.behavior)
    ? [{ seq: 1, type: 'message.delta', payload: { text: 'partial' } }]
    : [
        { seq: 1, type: 'message.delta', payload: { text: 'Hel' } },
        { seq: 2, type: 'message.delta', payload: { text: 'lo' } },
        { seq: 3, type: 'message.completed', payload: { messageId: 'm1' } },
        { seq: 4, type: 'run.completed', payload: {} },
      ];
}

function eventDelayMs(behavior) {
  if (behavior === 'slow') {
    return 250;
  }

  if (isHeld(behavior)) {
    return 150;
  }

  return 10;
}

async function writeEvents(run, response, afterSeq) {
  let closed = false;

  response.once('close', () => {
    closed = true;
  });

  for (const event of eventScript(run)) {
    if (event.seq <= afterSeq) {
      continue;
    }

    if (closed) {
      break;
    }

    response.write(frame(event));
    run.lastSeq = Math.max(run.lastSeq, event.seq);
    run.status = event.type === 'run.completed' ? 'completed' : 'running';

    await sleep(eventDelayMs(run.behavior));
  }

  if (isHeld(run.behavior)) {
    await new Promise((resolve) => {
      run.stopSignal = resolve;
      run.stopPromise = resolve;
    });

    if (!closed) {
      response.write(
        frame({ seq: run.lastSeq + 1, type: 'run.cancelled', payload: {} }),
      );
    }
  }

  if (!closed) {
    response.end();
  }
}

async function handleEvents(state, response, url, record, rawHarnessRunId) {
  const run = resolveRun(state, response, record, rawHarnessRunId);

  if (run === null) {
    return;
  }

  run.eventsRequests += 1;
  record.status = 200;
  const afterSeq = Number(url.searchParams.get('after_seq') ?? '0');

  sse(response);
  await writeEvents(run, response, afterSeq);
}

function handleStop(state, response, record, rawHarnessRunId) {
  const run = resolveRun(state, response, record, rawHarnessRunId);

  if (run === null) {
    return;
  }

  run.stopCalls += 1;
  run.status = 'cancelled';
  record.status = 200;
  run.stopPromise?.();
  json(response, 200, { run: { status: 'cancelled' } });
}

function handleSteer(state, response, record, rawHarnessRunId) {
  const run = resolveRun(state, response, record, rawHarnessRunId);

  if (run === null) {
    return;
  }

  run.steerCalls += 1;
  record.status = 200;
  json(response, 200, { accepted: false });
}

async function dispatch(state, request, response, url, record) {
  const path = url.pathname;
  const statusMatch = RUN_STATUS_PATH.exec(path);
  const eventsMatch = RUN_EVENTS_PATH.exec(path);
  const stopMatch = RUN_STOP_PATH.exec(path);
  const steerMatch = RUN_STEER_PATH.exec(path);

  if (request.method === 'POST' && path === '/v1/runs') {
    await handleCreate(state, request, response, record);
    return;
  }

  if (request.method === 'GET' && statusMatch !== null) {
    handleStatus(state, response, record, statusMatch[1]);
    return;
  }

  if (request.method === 'GET' && eventsMatch !== null) {
    await handleEvents(state, response, url, record, eventsMatch[1]);
    return;
  }

  if (request.method === 'POST' && stopMatch !== null) {
    handleStop(state, response, record, stopMatch[1]);
    return;
  }

  if (request.method === 'POST' && steerMatch !== null) {
    handleSteer(state, response, record, steerMatch[1]);
    return;
  }

  respondNotFound(response, record);
}

export async function createHermesStub() {
  const state = {
    runs: new Map(),
    behaviors: [],
    requests: [],
    nextId: 1,
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const record = {
      method: request.method,
      path: url.pathname,
      status: null,
      habiRunId:
        typeof request.headers['x-habi-run-id'] === 'string'
          ? request.headers['x-habi-run-id']
          : null,
      behavior: null,
    };

    state.requests.push(record);

    try {
      await dispatch(state, request, response, url, record);
    } catch (error) {
      // A stub-side failure is a real 500 to the adapter. Record the reason as
      // evidence and answer without leaking internals to the client.
      record.status = 500;
      record.error = error instanceof Error ? error.message : String(error);

      if (response.headersSent) {
        response.end();
        return;
      }

      json(response, 500, { error: 'stub_error' });
    }
  });

  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();

  if (address === null || typeof address === 'string') {
    throw new Error('Hermes stub did not bind a TCP port.');
  }

  function runFor(habiRunId) {
    for (const run of state.runs.values()) {
      if (run.habiRunId === habiRunId) {
        return run;
      }
    }

    return null;
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests: state.requests,
    queueBehavior(behavior) {
      state.behaviors.push(behavior);
    },
    runFor(habiRunId) {
      const run = runFor(habiRunId);

      if (run === null) {
        return null;
      }

      return {
        harnessRunId: run.harnessRunId,
        behavior: run.behavior,
        status: run.status,
        createCalls: run.createCalls,
        stopCalls: run.stopCalls,
        eventsRequests: run.eventsRequests,
      };
    },
    /** Releases any held SSE stream and stops accepting connections. */
    async close() {
      for (const run of state.runs.values()) {
        run.stopPromise?.();
      }

      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections?.();
      });
    },
  };
}
