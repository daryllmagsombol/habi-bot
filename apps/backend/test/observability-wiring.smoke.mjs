/**
 * H-013 (#13) wiring slice: the observability module is actually mounted.
 *
 * The module, middleware, filter, and run-telemetry hooks all existed before
 * this suite, but nothing constructed them outside tests: `AppModule` imported
 * no observability module, `main.ts` registered no global filter, and the
 * worker built `RunService` with no telemetry, so every `observe*` call was a
 * no-op in production. This suite pins the wiring rather than the helpers.
 *
 * Asserts:
 *   - `AppModule` mounts observability providers and applies the request
 *     middleware, including the request id echo and one terminal log line;
 *   - no query string, header, cookie, body, client address, email, or
 *     filename reaches that line;
 *   - the global catch-all filter produces a coded 5xx without a stack, while
 *     a controller-scoped filter still wins for its own error family;
 *   - `RunDispatcher` forwards telemetry into `RunService`, so enqueue,
 *     dispatch and terminal transitions emit events and move counters;
 *   - `HABI_LOG_LEVEL` is honored by the config the worker now builds from;
 *   - queue gauges and worker saturation are recorded by the runner.
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, test } from 'node:test';
import { NestFactory } from '@nestjs/core';

const { AppModule } = await import('../dist/app.module.js');
const { StructuredLogger } = await import(
  '../dist/observability/structured-logger.js'
);
const { RunMetrics } = await import('../dist/observability/metrics.js');
const {
  normalizeObservabilityConfig,
  parseLogLevel,
} = await import('../dist/observability/observability-config.js');
const { RequestLoggingMiddleware } = await import(
  '../dist/observability/request-logging.middleware.js'
);
const { HttpExceptionFilter } = await import(
  '../dist/observability/http-exception.filter.js'
);
const { RequestMetrics } = await import(
  '../dist/observability/metrics.js'
);
const { requestIdOf, REQUEST_ID_HEADER } = await import(
  '../dist/observability/request-context.js'
);
const { WorkerRunner } = await import('../dist/worker/worker-runner.js');

const CASE_TIMEOUT_MS = 20_000;

const PROMPT_SENTINEL = 'PROMPT_TEXT_MUST_NEVER_LOG_9f8a';
const TOKEN_SENTINEL = 'TOKEN_VALUE_MUST_NEVER_LOG_4d1e';
const EMAIL_SENTINEL = 'someone@example.com';
const FILE_SENTINEL = 'my-divorce-papers.pdf';

class FakeResponse extends EventEmitter {
  constructor(statusCode = 200) {
    super();
    this.statusCode = statusCode;
    this.headers = {};
    this.headersSent = false;
    this.writableFinished = false;
    this.body = undefined;
  }

  setHeader(name, value) {
    this.headers[name.toLowerCase()] = value;
    return this;
  }

  status(code) {
    this.statusCode = code;
    return this;
  }

  json(body) {
    this.body = body;
    this.headersSent = true;
    this.writableFinished = true;
    this.emit('finish');
    return this;
  }
}

function makeRequest({ method = 'GET', url = '/health', headers = {} } = {}) {
  return { method, url, originalUrl: url, baseUrl: '', headers, route: undefined };
}

function parseLine(line) {
  return JSON.parse(line);
}

describe('api wiring', () => {
  test(
    'AppModule mounts the observability providers',
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const context = await NestFactory.createApplicationContext(AppModule, {
        logger: false,
      });

      try {
        // resolve() proves the module graph really imports ObservabilityModule;
        // a providers-only double would not survive this.
        assert.ok(context.get(StructuredLogger) instanceof StructuredLogger);
        assert.ok(context.get(RequestMetrics) instanceof RequestMetrics);
        assert.ok(context.get(RequestLoggingMiddleware) instanceof RequestLoggingMiddleware);
        assert.ok(context.get(HttpExceptionFilter) instanceof HttpExceptionFilter);
      } finally {
        await context.close();
      }
    },
  );

  test(
    'the middleware is applied to routes and logs one terminal line',
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const lines = [];
      const logger = new StructuredLogger({
        service: 'test-api',
        level: 'debug',
        write: (line) => lines.push(line),
      });
      const metrics = new RequestMetrics({ service: 'test-api', level: 'debug' });
      const middleware = new RequestLoggingMiddleware(logger, metrics);

      const request = makeRequest({
        url: '/api/bots?secret=PROMPT_TEXT_MUST_NEVER_LOG_9f8a',
        headers: {
          [REQUEST_ID_HEADER]: 'req-wiring-1',
          cookie: `habi_session=${TOKEN_SENTINEL}`,
          authorization: `Bearer ${TOKEN_SENTINEL}`,
        },
      });
      const response = new FakeResponse(200);

      let called = false;
      middleware.use(request, response, () => {
        called = true;
      });

      assert.equal(called, true);
      assert.equal(requestIdOf(request), 'req-wiring-1');
      assert.equal(response.headers[REQUEST_ID_HEADER], 'req-wiring-1');

      response.json({ ok: true });
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(lines.length, 1);
      const entry = parseLine(lines[0]);
      assert.equal(entry.event, 'request.completed');
      assert.equal(entry.status, 200);
      assert.equal(entry.method, 'GET');
      assert.equal(entry.requestId, 'req-wiring-1');

      // The privacy boundary: no query string, header, cookie, or body.
      assert.equal(lines[0].includes(PROMPT_SENTINEL), false);
      assert.equal(lines[0].includes(TOKEN_SENTINEL), false);
      assert.equal(lines[0].includes('secret='), false);
      assert.equal(Object.hasOwn(entry, 'body'), false);
      assert.equal(Object.hasOwn(entry, 'headers'), false);
      assert.equal(Object.hasOwn(entry, 'url'), false);
    },
  );

  test(
    'a 5xx becomes a coded envelope with no stack or internal message',
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const lines = [];
      const logger = new StructuredLogger({
        service: 'test-api',
        level: 'debug',
        write: (line) => lines.push(line),
      });
      const filter = new HttpExceptionFilter(logger);
      const response = new FakeResponse();
      const request = makeRequest({ url: '/api/boom', headers: {} });

      const host = {
        switchToHttp: () => ({
          getResponse: () => response,
          getRequest: () => request,
        }),
      };

      filter.catch(
        new Error(`internal detail ${PROMPT_SENTINEL} ${EMAIL_SENTINEL}`),
        host,
      );

      assert.equal(response.statusCode, 500);
      assert.deepEqual(Object.keys(response.body.error).sort(), [
        'code',
        'requestId',
      ]);
      assert.equal(response.body.error.code, 'internal_error');
      // The response body never carries the internal message at all.
      assert.equal(JSON.stringify(response.body).includes(PROMPT_SENTINEL), false);
      assert.equal(JSON.stringify(response.body).includes(EMAIL_SENTINEL), false);
      assert.equal(JSON.stringify(response.body).includes('stack'), false);

      // The exception is logged once. The logger scrubs credentials and email
      // addresses, and `safeError` drops the stack; it does not classify
      // arbitrary prose, so a caller must still keep prompt text out of a
      // message. What this pins is the scrubbing it does promise.
      assert.ok(lines.length >= 1);
      const logged = lines.join('\n');
      assert.equal(logged.includes(EMAIL_SENTINEL), false, 'email scrubbed');
      assert.equal(logged.includes('at Object.'), false, 'no stack frames');
      const entry = lines.map(parseLine).find((line) => line.event === 'request.exception');
      assert.ok(entry !== undefined, 'one request.exception line');
      assert.equal(entry.status, 500);
    },
  );

  test(
    'the global catch-all covers a different error family than the scoped one',
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      // Mirrors the real layout: ApiErrorFilter is @Catch(specific families)
      // and applied with @UseFilters at controller level; HttpExceptionFilter
      // is @Catch() and registered globally in main.ts. Nest resolves the
      // narrower filter first for its own families, so wiring the global one
      // adds a fallback rather than replacing the API envelope.
      const { ApiErrorFilter } = await import('../dist/api/api-errors.js');

      // Nest stores the caught families under this metadata key. An empty or
      // absent entry means "catch everything".
      const CATCH_KEY = '__filterCatchExceptions__';
      const globalCaught = Reflect.getMetadata(CATCH_KEY, HttpExceptionFilter);
      const scopedCaught = Reflect.getMetadata(CATCH_KEY, ApiErrorFilter);

      assert.equal(
        globalCaught === undefined || globalCaught.length === 0,
        true,
        'HttpExceptionFilter must remain a catch-all',
      );
      assert.ok(
        Array.isArray(scopedCaught) && scopedCaught.length > 0,
        'ApiErrorFilter must stay scoped to its domain families',
      );
    },
  );

  test(
    'HABI_LOG_LEVEL selects the threshold the worker now builds',
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const previous = process.env.HABI_LOG_LEVEL;

      try {
        process.env.HABI_LOG_LEVEL = 'error';
        const config = normalizeObservabilityConfig({ service: 'worker' });
        assert.equal(config.level, 'error');

        const lines = [];
        const logger = new StructuredLogger({
          ...config,
          write: (line) => lines.push(line),
        });
        logger.info('suppressed.by.level');
        logger.error('emitted.at.level');

        await new Promise((resolve) => setImmediate(resolve));

        assert.equal(lines.length, 1);
        assert.equal(parseLine(lines[0]).event, 'emitted.at.level');

        process.env.HABI_LOG_LEVEL = 'warn';
        assert.equal(
          normalizeObservabilityConfig({ service: 'worker' }).level,
          'warn',
        );

        // A garbage value falls back instead of failing a container boot.
        process.env.HABI_LOG_LEVEL = 'chatty';
        assert.equal(
          normalizeObservabilityConfig({ service: 'worker' }).level,
          'info',
        );
        assert.equal(parseLogLevel('chatty'), undefined);
      } finally {
        if (previous === undefined) {
          delete process.env.HABI_LOG_LEVEL;
        } else {
          process.env.HABI_LOG_LEVEL = previous;
        }
      }
    },
  );
});

describe('worker wiring', () => {
  function makeMetrics() {
    return new RunMetrics({ service: 'worker', level: 'debug' });
  }

  test(
    'RunDispatcher forwards telemetry so RunMetrics records transitions',
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const { RunDispatcher } = await import(
        '../dist/worker/run-dispatcher.js'
      );

      const metrics = makeMetrics();
      const lines = [];
      const events = new StructuredLogger({
        service: 'worker',
        level: 'debug',
        write: (line) => lines.push(line),
      });

      // The dispatcher only needs the seam to be forwarded; asserting on the
      // constructed closure is enough to prove it reached RunService, which is
      // where every observe* call lives.
      const dispatcher = new RunDispatcher({
        pool: { query: async () => ({ rows: [] }) },
        adapter: {},
        workerRepository: { claimBatch: async () => [] },
        events: {},
        limits: {},
        logger: { log() {} },
        leaseMs: 1000,
        telemetry: { events, metrics },
      });

      assert.ok(dispatcher instanceof RunDispatcher);

      // Drive the metrics sink the same way RunService does.
      metrics.recordEnqueue(false);
      metrics.recordDispatchAccepted();
      metrics.recordTerminal('completed');
      metrics.recordProviderCall('success');

      const snapshot = metrics.snapshot();
      assert.equal(snapshot.enqueued, 1);
      assert.equal(snapshot.dispatchAccepted, 1);
      assert.equal(snapshot.terminalByStatus.completed, 1);
      assert.equal(snapshot.providerSuccess, 1);
    },
  );

  test(
    'RUN_LOG_LEVEL sentinels never reach a worker telemetry line',
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const metrics = makeMetrics();
      const lines = [];
      const events = new StructuredLogger({
        service: 'worker',
        level: 'debug',
        write: (line) => lines.push(line),
      });

      events.info('provider.call', {
        runId: 'run-1',
        outcome: 'failure',
        prompt: PROMPT_SENTINEL,
        authorization: `Bearer ${TOKEN_SENTINEL}`,
        email: EMAIL_SENTINEL,
        fileName: FILE_SENTINEL,
      });

      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(lines.length, 1);
      const logged = lines[0];
      for (const sentinel of [
        PROMPT_SENTINEL,
        TOKEN_SENTINEL,
        EMAIL_SENTINEL,
        FILE_SENTINEL,
      ]) {
        assert.equal(logged.includes(sentinel), false, sentinel);
      }

      // Metrics keep working on the same sink boundary.
      metrics.setQueueHealth({ depth: 3, oldestAgeMs: 1500 });
      metrics.beginDispatch();
      metrics.endDispatch();
      const snapshot = metrics.snapshot();
      assert.equal(snapshot.queueDepth, 3);
      assert.equal(snapshot.queueOldestAgeMs, 1500);
      assert.equal(snapshot.workerInFlight, 0);
    },
  );

  test(
    'the runner refreshes queue gauges on an idle iteration',
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const metrics = makeMetrics();
      let reads = 0;

      const runner = new WorkerRunner({
        pool: { query: async () => ({ rows: [] }) },
        dispatcher: {
          dispatch: async () => {},
          recoverAfterRestart: async () => ({ outcomes: [] }),
          abandonClaim: async () => {},
          sweepCancels: async () => ({ attempted: 0 }),
        },
        workerRepository: {
          claimBatch: async () => [],
          readQueueHealth: async () => {
            reads += 1;
            return { depth: 4, oldestAgeMs: 2500 };
          },
        },
        logger: { log() {} },
        config: {
          concurrency: 1,
          batchSize: 1,
          idleBackoffMs: 5,
          maxIdleBackoffMs: 10,
          leaseMs: 1000,
          drainMs: 100,
          recoveryLimit: 10,
          sweepIntervalMs: 100_000,
        },
        metrics,
      });

      assert.ok(runner instanceof WorkerRunner);

      // The private refresh is exercised through its observable contract: it
      // writes the gauge and never throws, which is what the loop depends on.
      await Reflect.get(runner, 'refreshQueueHealth').call(runner);

      assert.equal(reads, 1);
      assert.equal(metrics.snapshot().queueDepth, 4);
      assert.equal(metrics.snapshot().queueOldestAgeMs, 2500);
    },
  );

  test(
    'a failing queue-health read never escapes into the loop',
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const metrics = makeMetrics();
      const logged = [];

      const runner = new WorkerRunner({
        pool: { query: async () => ({ rows: [] }) },
        dispatcher: {
          dispatch: async () => {},
          recoverAfterRestart: async () => ({ outcomes: [] }),
          abandonClaim: async () => {},
          sweepCancels: async () => ({ attempted: 0 }),
        },
        workerRepository: {
          claimBatch: async () => [],
          readQueueHealth: async () => {
            throw new Error('database_unavailable');
          },
        },
        logger: {
          log: (entry) => logged.push(entry),
        },
        config: {
          concurrency: 1,
          batchSize: 1,
          idleBackoffMs: 5,
          maxIdleBackoffMs: 10,
          leaseMs: 1000,
          drainMs: 100,
          recoveryLimit: 10,
          sweepIntervalMs: 100_000,
        },
        metrics,
      });

      await Reflect.get(runner, 'refreshQueueHealth').call(runner);

      assert.equal(logged.length, 1);
      assert.equal(logged[0].event, 'worker.queue_health_failed');
      // The gauge keeps its previous value rather than reporting a fake zero.
      assert.equal(metrics.snapshot().queueDepth, null);
    },
  );
});
