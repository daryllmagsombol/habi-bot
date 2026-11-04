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

export async function createHermesStub() {
  const runs = new Map();
  const behaviors = [];
  const requests = [];
  let nextId = 1;

  function newRun(habiRunId, behavior) {
    const harnessRunId = `harness-${nextId}`;
    const run = {
      harnessRunId,
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

    runs.set(harnessRunId, run);

    return run;
  }

  function findByHarnessId(harnessRunId) {
    return runs.get(harnessRunId) ?? null;
  }

  function requestBehavior() {
    return behaviors.shift() ?? 'normal';
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    const record = {
      method: request.method,
      path,
      status: null,
      habiRunId: typeof request.headers['x-habi-run-id'] === 'string'
        ? request.headers['x-habi-run-id']
        : null,
      behavior: null,
    };

    requests.push(record);

    try {
      if (request.method === 'POST' && path === '/v1/runs') {
        let raw = '';
        for await (const chunk of request) {
          raw += chunk;
        }

        let body = {};
        try {
          body = raw === '' ? {} : JSON.parse(raw);
        } catch {
          record.status = 400;
          json(response, 400, { error: 'invalid_json' });
          return;
        }

        const habiRunId =
          typeof body.run_id === 'string' ? body.run_id : record.habiRunId;
        const behavior = requestBehavior();

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
            run_id: `harness-timeout-${nextId++}`,
            status: 'queued',
          });
          return;
        }

        const run = newRun(habiRunId, behavior);
        run.createCalls += 1;
        record.status = 202;
        json(response, 202, { run_id: run.harnessRunId, status: 'queued' });
        return;
      }

      const statusMatch = path.match(/^\/v1\/runs\/([^/]+)$/);

      if (request.method === 'GET' && statusMatch !== null) {
        const run = findByHarnessId(decodeURIComponent(statusMatch[1]));

        if (run === null) {
          record.status = 404;
          json(response, 404, { error: 'not_found' });
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
        return;
      }

      const eventsMatch = path.match(/^\/v1\/runs\/([^/]+)\/events$/);

      if (request.method === 'GET' && eventsMatch !== null) {
        const run = findByHarnessId(decodeURIComponent(eventsMatch[1]));

        if (run === null) {
          record.status = 404;
          json(response, 404, { error: 'not_found' });
          return;
        }

        run.eventsRequests += 1;
        record.status = 200;
        const afterSeq = Number(url.searchParams.get('after_seq') ?? '0');
        sse(response);

        const script =
          run.behavior === 'hold' || run.behavior === 'restart'
            ? [
                { seq: 1, type: 'message.delta', payload: { text: 'partial' } },
              ]
            : [
                { seq: 1, type: 'message.delta', payload: { text: 'Hel' } },
                { seq: 2, type: 'message.delta', payload: { text: 'lo' } },
                { seq: 3, type: 'message.completed', payload: { messageId: 'm1' } },
                { seq: 4, type: 'run.completed', payload: {} },
              ];

        let closed = false;
        response.once('close', () => {
          closed = true;
        });

        for (const event of script) {
          if (event.seq <= afterSeq) {
            continue;
          }

          if (closed) {
            break;
          }

          response.write(frame(event));
          run.lastSeq = Math.max(run.lastSeq, event.seq);
          run.status = event.type === 'run.completed' ? 'completed' : 'running';

          if (run.behavior === 'slow' || run.behavior === 'hold' || run.behavior === 'restart') {
            await sleep(run.behavior === 'slow' ? 250 : 150);
          } else {
            await sleep(10);
          }
        }

        if (run.behavior === 'hold' || run.behavior === 'restart') {
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

        return;
      }

      const stopMatch = path.match(/^\/v1\/runs\/([^/]+)\/stop$/);

      if (request.method === 'POST' && stopMatch !== null) {
        const run = findByHarnessId(decodeURIComponent(stopMatch[1]));

        if (run === null) {
          record.status = 404;
          json(response, 404, { error: 'not_found' });
          return;
        }

        run.stopCalls += 1;
        run.status = 'cancelled';
        record.status = 200;
        run.stopPromise?.();
        json(response, 200, { run: { status: 'cancelled' } });
        return;
      }

      const steerMatch = path.match(/^\/v1\/runs\/([^/]+)\/steer$/);

      if (request.method === 'POST' && steerMatch !== null) {
        const run = findByHarnessId(decodeURIComponent(steerMatch[1]));

        if (run === null) {
          record.status = 404;
          json(response, 404, { error: 'not_found' });
          return;
        }

        run.steerCalls += 1;
        record.status = 200;
        json(response, 200, { accepted: false });
        return;
      }

      record.status = 404;
      json(response, 404, { error: 'not_found' });
    } catch (error) {
      record.status = 500;
      if (!response.headersSent) {
        json(response, 500, { error: 'stub_error' });
      } else {
        response.end();
      }
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
    for (const run of runs.values()) {
      if (run.habiRunId === habiRunId) {
        return run;
      }
    }

    return null;
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    queueBehavior(behavior) {
      behaviors.push(behavior);
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
      for (const run of runs.values()) {
        run.stopPromise?.();
      }

      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections?.();
      });
    },
  };
}
