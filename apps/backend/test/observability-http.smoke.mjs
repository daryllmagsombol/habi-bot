/**
 * H-013 (#13) HTTP visibility slice: request outcome logging, exception
 * filter response shapes, in-process counters, and module wiring.
 *
 * The middleware and filter are instantiated directly with minimal Express
 * doubles; no HTTP server and no @nestjs/testing dependency are used. The
 * module test boots a bare application context to prove the providers resolve
 * without applying middleware to any route.
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, test } from 'node:test';
import { NestFactory } from '@nestjs/core';
import {
  HttpException,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';

const {
  RequestLoggingMiddleware,
  REQUEST_COMPLETED_EVENT,
  REQUEST_FAILED_EVENT,
  REQUEST_ABORTED_EVENT,
} = await import('../dist/observability/request-logging.middleware.js');
const { HttpExceptionFilter, INTERNAL_ERROR_CODE, REQUEST_INVALID_CODE } = await import(
  '../dist/observability/http-exception.filter.js'
);
const { RequestMetrics, statusClassOf, METRIC_PREFIX } = await import(
  '../dist/observability/metrics.js'
);
const { StructuredLogger } = await import('../dist/observability/structured-logger.js');
const { ObservabilityModule } = await import('../dist/observability/observability.module.js');
const { normalizeObservabilityConfig, OBSERVABILITY_CONFIG } = await import(
  '../dist/observability/observability-config.js'
);
const { REQUEST_ID_HEADER, UNMATCHED_ROUTE, isValidRequestId } = await import(
  '../dist/observability/request-context.js'
);

const FIXED_NOW = Date.parse('2026-11-03T00:00:00.000Z');
const CASE_TIMEOUT_MS = 15000;

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

  finish() {
    this.headersSent = true;
    this.writableFinished = true;
    this.emit('finish');
  }

  abort() {
    this.emit('close');
  }
}

function createRequest({
  method = 'GET',
  url = '/health',
  routePath = '/health',
  headers = {},
} = {}) {
  return {
    method,
    url,
    baseUrl: '',
    headers,
    // `null` means "no Express route matched", e.g. a 404.
    route: routePath === null ? undefined : { path: routePath },
  };
}

function createHarness() {
  const lines = [];
  const config = {
    service: 'api',
    level: 'debug',
    write: (line) => lines.push(line),
    now: () => FIXED_NOW,
  };
  const logger = new StructuredLogger(config);
  const metrics = new RequestMetrics(config);
  const middleware = new RequestLoggingMiddleware(logger, metrics);
  const filter = new HttpExceptionFilter(logger);

  return {
    lines,
    logger,
    metrics,
    middleware,
    filter,
    records: () =>
      lines.map((line) => {
        assert.equal(line.endsWith('\n'), true);
        return JSON.parse(line);
      }),
  };
}

function hostFor(request, response) {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
      getNext: () => undefined,
    }),
  };
}

function runRequest(harness, request, status, { abort = false } = {}) {
  const response = new FakeResponse();
  let nextCalled = false;

  harness.middleware.use(request, response, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);

  if (abort) {
    response.abort();
  } else {
    response.statusCode = status;
    response.finish();
  }

  return response;
}

describe('request logging middleware', () => {
  test('logs request.completed with method, route, status, duration, and request id', () => {
    const harness = createHarness();
    const request = createRequest({
      url: '/runs/abc123?access_token=QUERY_SENTINEL',
      routePath: '/runs/:id',
      headers: {
        'x-request-id': 'req-abc_123',
        authorization: 'Bearer HEADER_SENTINEL',
        cookie: 'habi_session=COOKIE_SENTINEL',
      },
    });

    const response = runRequest(harness, request, 200);
    const records = harness.records();

    assert.equal(records.length, 1);
    const [record] = records;

    assert.equal(record.event, REQUEST_COMPLETED_EVENT);
    assert.equal(record.level, 'info');
    assert.equal(record.service, 'api');
    assert.equal(record.method, 'GET');
    assert.equal(record.route, '/runs/:id');
    assert.equal(record.status, 200);
    assert.equal(record.requestId, 'req-abc_123');
    assert.equal(typeof record.durationMs, 'number');
    assert.ok(record.durationMs >= 0 && record.durationMs < 5000);
    assert.equal(response.headers[REQUEST_ID_HEADER], 'req-abc_123');

    const serialized = harness.lines.join('');
    assert.equal(serialized.includes('QUERY_SENTINEL'), false);
    assert.equal(serialized.includes('HEADER_SENTINEL'), false);
    assert.equal(serialized.includes('COOKIE_SENTINEL'), false);
    assert.equal(serialized.includes('abc123'), false);
  });

  test('runs the handler inside the request-id async context', () => {
    const harness = createHarness();
    const request = createRequest({ headers: { 'x-request-id': 'req-context' } });
    const response = new FakeResponse();
    let observed;

    harness.middleware.use(request, response, () => {
      observed = request.requestId;
    });

    assert.equal(observed, 'req-context');
    assert.equal(request.requestId, 'req-context');
  });

  test('generates and echoes an id when the inbound header is invalid', () => {
    const harness = createHarness();
    const request = createRequest({ headers: { 'x-request-id': 'bad id with spaces' } });
    const response = runRequest(harness, request, 204);
    const [record] = harness.records();

    assert.equal(isValidRequestId(record.requestId), true);
    assert.notEqual(record.requestId, 'bad id with spaces');
    assert.equal(response.headers[REQUEST_ID_HEADER], record.requestId);
  });

  test('logs request.failed at warn for 4xx and error for 5xx', () => {
    const harness = createHarness();

    runRequest(harness, createRequest(), 403);
    runRequest(harness, createRequest(), 500);

    const records = harness.records();

    assert.deepEqual(
      records.map((record) => [record.event, record.level, record.status]),
      [
        [REQUEST_FAILED_EVENT, 'warn', 403],
        [REQUEST_FAILED_EVENT, 'error', 500],
      ],
    );
  });

  test('labels an unmatched route without logging the raw path', () => {
    const harness = createHarness();
    const request = createRequest({
      url: '/no-such-route/user-42',
      routePath: null,
    });

    runRequest(harness, request, 404);

    const [record] = harness.records();

    assert.equal(record.route, UNMATCHED_ROUTE);
    assert.equal(harness.lines.join('').includes('user-42'), false);
  });

  test('logs an aborted request once and balances in-flight', () => {
    const harness = createHarness();

    runRequest(harness, createRequest(), 200, { abort: true });

    const records = harness.records();

    assert.equal(records.length, 1);
    assert.equal(records[0].event, REQUEST_ABORTED_EVENT);
    assert.equal(records[0].level, 'warn');
    assert.equal(harness.metrics.snapshot().inFlight, 0);
  });

  test('finish followed by close logs exactly one outcome', () => {
    const harness = createHarness();
    const response = new FakeResponse();
    const request = createRequest();

    harness.middleware.use(request, response, () => undefined);
    response.finish();
    response.emit('close');

    assert.equal(harness.records().length, 1);
  });
});

describe('exception filter', () => {
  test('5xx hides the internal message and returns code plus requestId', () => {
    const harness = createHarness();
    const request = createRequest({ routePath: '/runs/:id' });
    const response = new FakeResponse();
    const error = new Error('database exploded with internal prompt text');

    harness.filter.catch(error, hostFor(request, response));

    assert.equal(response.statusCode, 500);
    assert.deepEqual(Object.keys(response.body.error).sort(), ['code', 'requestId']);
    assert.equal(response.body.error.code, INTERNAL_ERROR_CODE);
    assert.equal(isValidRequestId(response.body.error.requestId), true);
    assert.equal(response.headers[REQUEST_ID_HEADER], response.body.error.requestId);

    const serialized = JSON.stringify(response.body);
    assert.equal(serialized.includes('exploded'), false);
    assert.equal(serialized.includes('prompt'), false);
    assert.equal(serialized.includes('stack'), false);

    const [record] = harness.records();

    assert.equal(record.event, 'request.exception');
    assert.equal(record.level, 'error');
    assert.equal(record.status, 500);
    assert.equal(record.route, '/runs/:id');
    assert.equal(record.requestId, response.body.error.requestId);
    assert.equal(record.error.name, 'Error');
    assert.equal('stack' in record.error, false);
  });

  test('5xx preserves an app-authored safe code but not its message', () => {
    const harness = createHarness();
    const response = new FakeResponse();
    const error = new ServiceUnavailableException({
      error: { code: 'provider_unavailable' },
      message: 'provider detail that must not leak',
    });

    harness.filter.catch(error, hostFor(createRequest(), response));

    assert.equal(response.statusCode, 503);
    assert.deepEqual(Object.keys(response.body.error).sort(), ['code', 'requestId']);
    assert.equal(response.body.error.code, 'provider_unavailable');
    assert.equal(
      JSON.stringify(response.body).includes('provider detail'),
      false,
    );
  });

  test('4xx keeps an existing JSON error shape unchanged', () => {
    const harness = createHarness();
    const response = new FakeResponse();
    const payload = { error: { code: 'unauthenticated' } };

    harness.filter.catch(
      new UnauthorizedException(payload),
      hostFor(createRequest(), response),
    );

    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.body, payload);
    assert.equal(isValidRequestId(response.headers[REQUEST_ID_HEADER]), true);
    assert.equal(harness.records()[0].status, 401);
  });

  test('4xx converts a bare string payload into a scrubbed error object', () => {
    const harness = createHarness();
    const stringResponse = new FakeResponse();

    // A bare HttpException keeps its raw string response; built-in exceptions
    // normalize strings into `{message, statusCode}` bodies, which pass through.
    harness.filter.catch(
      new HttpException('token=abc123 is invalid', 400),
      hostFor(createRequest(), stringResponse),
    );

    assert.equal(stringResponse.statusCode, 400);
    assert.deepEqual(stringResponse.body, {
      error: {
        code: REQUEST_INVALID_CODE,
        message: 'token=[redacted] is invalid',
      },
    });

    const defaultResponse = new FakeResponse();

    harness.filter.catch(
      new NotFoundException(),
      hostFor(createRequest({ routePath: null }), defaultResponse),
    );

    assert.equal(defaultResponse.statusCode, 404);
    assert.deepEqual(defaultResponse.body, {
      message: 'Not Found',
      statusCode: 404,
    });
    assert.equal(harness.records()[1].route, UNMATCHED_ROUTE);
  });

  test('5xx from an HttpException still hides the message', () => {
    const harness = createHarness();
    const response = new FakeResponse();

    harness.filter.catch(
      new InternalServerErrorException('internal only detail'),
      hostFor(createRequest(), response),
    );

    assert.equal(response.statusCode, 500);
    assert.equal(response.body.error.code, INTERNAL_ERROR_CODE);
    assert.equal(JSON.stringify(response.body).includes('internal only detail'), false);
  });

  test('does not rewrite a response that already started', () => {
    const harness = createHarness();
    const response = new FakeResponse();

    response.headersSent = true;

    harness.filter.catch(new Error('too late'), hostFor(createRequest(), response));

    assert.equal(response.body, undefined);
    assert.equal(harness.lines.length, 0);
  });

  test('middleware and filter together log one failure and count it once', () => {
    const harness = createHarness();
    const request = createRequest({ routePath: '/runs/:id' });
    const response = new FakeResponse();

    harness.middleware.use(request, response, () => {
      harness.filter.catch(new Error('run failed'), hostFor(request, response));
    });

    const records = harness.records();
    const snapshot = harness.metrics.snapshot();

    assert.deepEqual(
      records.map((record) => [record.event, record.level, record.status]),
      [
        ['request.exception', 'error', 500],
        [REQUEST_FAILED_EVENT, 'error', 500],
      ],
    );
    assert.equal(records[1].requestId, records[0].requestId);
    assert.equal(records[1].route, '/runs/:id');
    assert.equal(snapshot.total, 1);
    assert.equal(snapshot.byStatusClass['5xx'], 1);
    assert.equal(snapshot.inFlight, 0);
  });
});

describe('request metrics', () => {
  test('classifies statuses and counts by class', () => {
    assert.equal(statusClassOf(100), '1xx');
    assert.equal(statusClassOf(204), '2xx');
    assert.equal(statusClassOf(301), '3xx');
    assert.equal(statusClassOf(404), '4xx');
    assert.equal(statusClassOf(503), '5xx');
    assert.equal(statusClassOf(99), 'other');
    assert.equal(statusClassOf(600), 'other');
    assert.equal(statusClassOf(Number.NaN), 'other');

    const harness = createHarness();

    runRequest(harness, createRequest(), 200);
    runRequest(harness, createRequest(), 201);
    runRequest(harness, createRequest(), 304);
    runRequest(harness, createRequest(), 403);
    runRequest(harness, createRequest(), 500);

    const snapshot = harness.metrics.snapshot();

    assert.equal(snapshot.service, 'api');
    assert.equal(snapshot.total, 5);
    assert.equal(snapshot.inFlight, 0);
    assert.deepEqual(snapshot.byStatusClass, {
      '1xx': 0,
      '2xx': 2,
      '3xx': 1,
      '4xx': 1,
      '5xx': 1,
      other: 0,
    });
    assert.equal(typeof snapshot.durationMsSum, 'number');
    assert.equal(snapshot.durationMsCount, 5);
  });

  test('tracks in-flight requests', () => {
    const harness = createHarness();
    const response = new FakeResponse();

    harness.middleware.use(createRequest(), response, () => undefined);
    assert.equal(harness.metrics.snapshot().inFlight, 1);

    response.finish();
    assert.equal(harness.metrics.snapshot().inFlight, 0);
  });

  test('formats Prometheus text with bounded label values', () => {
    const harness = createHarness();

    runRequest(harness, createRequest(), 200);
    runRequest(harness, createRequest(), 404);
    runRequest(harness, createRequest(), 503);

    const text = harness.metrics.toPrometheus();
    const lines = text.split('\n');

    assert.equal(text.endsWith('\n'), true);
    assert.match(text, new RegExp(`# TYPE ${METRIC_PREFIX}_http_requests_in_flight gauge`));
    assert.match(
      text,
      new RegExp(`${METRIC_PREFIX}_http_requests_total\\{service="api",status_class="4xx"\\} 1`),
    );
    assert.match(
      text,
      new RegExp(`${METRIC_PREFIX}_http_requests_total\\{service="api",status_class="5xx"\\} 1`),
    );
    assert.match(
      text,
      new RegExp(`# TYPE ${METRIC_PREFIX}_http_request_duration_ms summary`),
    );
    assert.match(text, new RegExp(`${METRIC_PREFIX}_http_request_duration_ms_count\\{service="api"\\} 3`));

    for (const line of lines) {
      if (line === '' || line.startsWith('#')) {
        continue;
      }

      assert.match(
        line,
        /^[a-zA-Z_:][a-zA-Z0-9_:]*(\{[a-zA-Z_][a-zA-Z0-9_]*="[^"\\]*"(,[a-zA-Z_][a-zA-Z0-9_]*="[^"\\]*")*\})? -?\d+(\.\d+)?$/,
        line,
      );
    }
  });
});

describe('observability module', () => {
  test(
    'forRoot resolves the logger, metrics, middleware, and filter',
    { timeout: CASE_TIMEOUT_MS },
    async () => {
      const lines = [];
      const module = ObservabilityModule.forRoot({
        service: 'test-api',
        level: 'debug',
        write: (line) => lines.push(line),
      });

      assert.equal(module.module, ObservabilityModule);

      for (const provider of [
        StructuredLogger,
        RequestMetrics,
        RequestLoggingMiddleware,
        HttpExceptionFilter,
      ]) {
        assert.ok(module.providers.includes(provider), String(provider));
        assert.ok(module.exports.includes(provider), String(provider));
      }

      assert.ok(
        module.providers.some(
          (provider) => provider.provide === OBSERVABILITY_CONFIG,
        ),
      );
      assert.ok(module.exports.includes(OBSERVABILITY_CONFIG));

      const context = await NestFactory.createApplicationContext(module, {
        logger: false,
      });

      try {
        assert.ok(context.get(StructuredLogger) instanceof StructuredLogger);
        assert.ok(context.get(RequestMetrics) instanceof RequestMetrics);
        assert.ok(context.get(RequestLoggingMiddleware) instanceof RequestLoggingMiddleware);
        assert.ok(context.get(HttpExceptionFilter) instanceof HttpExceptionFilter);

        context.get(StructuredLogger).info('module.ready', { attempt: 1 });

        assert.equal(lines.length, 1);
        const record = JSON.parse(lines[0]);

        assert.equal(record.service, 'test-api');
        assert.equal(record.event, 'module.ready');
        assert.equal(record.attempt, 1);
        assert.equal(record.level, 'info');
      } finally {
        await context.close();
      }
    },
  );

  test('forRoot validates the service name at wiring time', () => {
    assert.throws(() => ObservabilityModule.forRoot({}), TypeError);
    assert.throws(
      () => ObservabilityModule.forRoot({ service: 'api v1' }),
      TypeError,
    );
    // A bad level falls back rather than failing bootstrap.
    assert.equal(
      normalizeObservabilityConfig({ service: 'api', level: 'verbose' }).level,
      'info',
    );
  });
});
