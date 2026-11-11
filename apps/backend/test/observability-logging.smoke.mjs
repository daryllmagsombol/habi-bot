/**
 * H-013 (#13) logging slice: JSON-lines envelope, deep redaction, request-id
 * validation, and async correlation.
 *
 * These tests instantiate the built classes directly. No full app bootstrap
 * and no @nestjs/testing dependency are involved; the only Nest runtime used
 * here is `createApplicationContext` in the HTTP suite's module test.
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const {
  StructuredLogger,
  REDACTED,
  CIRCULAR,
  UNREADABLE,
  UNSUPPORTED,
  sanitizeErrorMessage,
  safeError,
  EMAIL_KEY_PATTERN,
  FILE_KEY_PATTERN,
} = await import('../dist/observability/structured-logger.js');
const { normalizeObservabilityConfig, parseLogLevel } = await import(
  '../dist/observability/observability-config.js'
);
const {
  isValidRequestId,
  normalizeRequestId,
  resolveRequestId,
  runWithRequestId,
  currentRequestId,
  echoRequestId,
  REQUEST_ID_HEADER,
  MAX_REQUEST_ID_LENGTH,
} = await import('../dist/observability/request-context.js');

const FIXED_NOW = Date.parse('2026-11-03T00:00:00.000Z');

function parseLine(line) {
  assert.equal(line.endsWith('\n'), true, `line is newline terminated: ${line}`);
  const parsed = JSON.parse(line);
  assert.equal(typeof parsed, 'object');
  assert.notEqual(parsed, null);
  assert.equal(Array.isArray(parsed), false);
  return parsed;
}

function createLogger(overrides = {}) {
  const lines = [];
  const logger = new StructuredLogger({
    service: 'api',
    level: 'debug',
    now: () => FIXED_NOW,
    write: (line) => lines.push(line),
    ...overrides,
  });

  return {
    logger,
    lines,
    records: () => lines.map(parseLine),
  };
}

function onlyRecord(harness) {
  assert.equal(harness.lines.length, 1, harness.lines.join(''));
  return harness.records()[0];
}

describe('structured logger envelope', () => {
  test('emits one JSON line per call with ts, level, service, event, and fields', () => {
    const harness = createLogger();

    harness.logger.info('request.completed', {
      requestId: 'req-abc_123',
      status: 200,
      durationMs: 1.5,
      method: 'GET',
      route: '/health',
    });

    const record = onlyRecord(harness);

    assert.equal(record.ts, '2026-11-03T00:00:00.000Z');
    assert.equal(record.level, 'info');
    assert.equal(record.service, 'api');
    assert.equal(record.event, 'request.completed');
    assert.equal(record.requestId, 'req-abc_123');
    assert.equal(record.status, 200);
    assert.equal(record.durationMs, 1.5);
    assert.equal(record.route, '/health');
  });

  test('respects the configured level threshold', () => {
    const harness = createLogger({ level: 'warn' });

    harness.logger.debug('test.debug');
    harness.logger.info('test.info');
    harness.logger.warn('test.warn');
    harness.logger.error('test.error');

    assert.deepEqual(
      harness.records().map((record) => record.level),
      ['warn', 'error'],
    );
    assert.equal(harness.logger.isEnabled('info'), false);
    assert.equal(harness.logger.isEnabled('error'), true);
  });

  test('the default sink writes parseable JSON lines to stdout only', () => {
    const originalWrite = process.stdout.write;
    const captured = [];

    process.stdout.write = (chunk) => {
      captured.push(String(chunk));
      return true;
    };

    try {
      // No `write` override: exercise the real stdout sink.
      const logger = new StructuredLogger({ service: 'api', level: 'debug' });
      logger.info('test.stdout', { ok: true });
      logger.error('test.stdout', { error: new Error('stdout failure') });
    } finally {
      process.stdout.write = originalWrite;
    }

    const lines = captured.join('').split('\n').filter((line) => line !== '');

    assert.equal(lines.length, 2);

    for (const line of lines) {
      const record = parseLine(`${line}\n`);

      assert.equal(record.service, 'api');
      assert.equal(record.event, 'test.stdout');
    }
  });

  test('reserved envelope keys cannot be spoofed by fields', () => {
    const harness = createLogger();

    harness.logger.info('request.completed', {
      ts: '1999-01-01T00:00:00.000Z',
      level: 'debug',
      service: 'other',
      event: 'spoofed.event',
      status: 201,
    });

    const record = onlyRecord(harness);

    assert.equal(record.ts, '2026-11-03T00:00:00.000Z');
    assert.equal(record.level, 'info');
    assert.equal(record.service, 'api');
    assert.equal(record.event, 'request.completed');
    assert.equal(record.status, 201);
  });

  test('an invalid event name is replaced without echoing the raw value', () => {
    const harness = createLogger();

    harness.logger.info('has spaces and PROMPT TEXT', { ok: true });

    const record = onlyRecord(harness);

    assert.equal(record.event, 'log.invalid_event');
    assert.equal(harness.lines.join('').includes('PROMPT TEXT'), false);
  });

  test('a line larger than the bound keeps the envelope and drops the fields', () => {
    const harness = createLogger();
    const fields = {};

    for (let index = 0; index < 40; index += 1) {
      fields[`field${index}`] = 'x'.repeat(1024);
    }

    harness.logger.info('test.oversized', fields);

    const waterfall = harness.lines.join('');

    assert.ok(waterfall.length < 20000, `line length ${waterfall.length}`);
    const record = harness.records()[0];
    assert.equal(record.event, 'test.oversized');
    assert.equal(record.logTruncated, true);
    assert.equal('field0' in record, false);
  });
});

describe('redaction', () => {
  test('drops credentials, headers, prompts, and payloads at any depth', () => {
    const harness = createLogger();

    harness.logger.info('test.secrets', {
      authorization: 'Bearer LIVE_TOKEN_SENTINEL',
      cookie: 'habi_session=COOKIE_SENTINEL',
      'set-cookie': 'habi_session=SET_COOKIE_SENTINEL; HttpOnly',
      password: 'PASSWORD_SENTINEL',
      nested: {
        token: 'TOKEN_SENTINEL',
        apiKey: 'API_KEY_SENTINEL',
        apikey: 'APIKEY_SENTINEL',
        clientSecret: 'SECRET_SENTINEL',
        credentialRef: 'CREDENTIAL_SENTINEL',
        headers: {
          Authorization: 'Bearer HEADER_TOKEN_SENTINEL',
          'X-Api-Key': 'HEADER_API_KEY_SENTINEL',
        },
      },
      prompt: 'PROMPT_SENTINEL',
      messages: [{ role: 'user', content: 'MESSAGE_SENTINEL' }],
      body: { text: 'BODY_SENTINEL' },
      requestId: 'req-abc_123',
    });

    const record = onlyRecord(harness);
    const serialized = harness.lines.join('');

    for (const sentinel of [
      'LIVE_TOKEN_SENTINEL',
      'COOKIE_SENTINEL',
      'SET_COOKIE_SENTINEL',
      'PASSWORD_SENTINEL',
      'TOKEN_SENTINEL',
      'API_KEY_SENTINEL',
      'APIKEY_SENTINEL',
      'SECRET_SENTINEL',
      'CREDENTIAL_SENTINEL',
      'HEADER_TOKEN_SENTINEL',
      'HEADER_API_KEY_SENTINEL',
      'PROMPT_SENTINEL',
      'MESSAGE_SENTINEL',
      'BODY_SENTINEL',
    ]) {
      assert.equal(serialized.includes(sentinel), false, sentinel);
    }

    assert.equal(record.authorization, REDACTED);
    assert.equal(record.cookie, REDACTED);
    assert.equal(record['set-cookie'], REDACTED);
    assert.equal(record.nested.token, REDACTED);
    assert.equal(record.nested.apiKey, REDACTED);
    assert.equal(record.nested.apikey, REDACTED);
    assert.equal(record.nested.clientSecret, REDACTED);
    assert.equal(record.nested.credentialRef, REDACTED);
    assert.equal(record.nested.headers.Authorization, REDACTED);
    assert.equal(record.prompt, REDACTED);
    assert.equal(record.messages, REDACTED);
    assert.equal(record.body, REDACTED);
    // A safe, low-cardinality correlation id survives in the clear.
    assert.equal(record.requestId, 'req-abc_123');
  });

  test('redacts filename and email keys without touching safe handles', () => {
    const harness = createLogger();

    harness.logger.info('test.pii_keys', {
      fileName: 'my-divorce-papers.pdf',
      file_name: 'secret-plan.docx',
      filePath: '/home/user/secret.txt',
      email: 'someone@example.com',
      userEmail: 'other@example.org',
      emailAddress: 'third@example.net',
      runId: 'run-123',
      requestId: 'req-abc_123',
      conversationId: 'conv-456',
    });

    const record = onlyRecord(harness);
    const serialized = harness.lines.join('');

    for (const sentinel of [
      'my-divorce-papers.pdf',
      'secret-plan.docx',
      '/home/user/secret.txt',
      'someone@example.com',
      'other@example.org',
      'third@example.net',
    ]) {
      assert.equal(serialized.includes(sentinel), false, sentinel);
    }

    assert.equal(record.fileName, REDACTED);
    assert.equal(record.file_name, REDACTED);
    assert.equal(record.filePath, REDACTED);
    assert.equal(record.email, REDACTED);
    assert.equal(record.userEmail, REDACTED);
    assert.equal(record.emailAddress, REDACTED);
    // Safe correlation handles stay in the clear.
    assert.equal(record.runId, 'run-123');
    assert.equal(record.requestId, 'req-abc_123');
    assert.equal(record.conversationId, 'conv-456');

    assert.ok(EMAIL_KEY_PATTERN.test('email'), 'email pattern matches');
    assert.ok(EMAIL_KEY_PATTERN.test('user_email'), 'user_email matches');
    assert.ok(FILE_KEY_PATTERN.test('fileName'), 'filename matches');
    assert.ok(FILE_KEY_PATTERN.test('file_path'), 'file_path matches');
    assert.equal(FILE_KEY_PATTERN.test('file'), false, 'bare file stays content-keyed');
    assert.equal(FILE_KEY_PATTERN.test('path'), false, 'bare path is not a filename');
  });

  test('scrubs inline email addresses from error messages', () => {
    assert.equal(
      sanitizeErrorMessage('notify someone@example.com about failure'),
      'notify [redacted] about failure',
    );
    assert.equal(
      sanitizeErrorMessage('contact a@b.co and c.d@e-f.gov.uk now'),
      'contact [redacted] and [redacted] now',
    );
  });

  test('is cycle-safe for objects and arrays', () => {
    const harness = createLogger();
    const cyclic = { name: 'loop', count: 1 };
    cyclic.self = cyclic;
    const cyclicArray = [];
    cyclicArray.push(cyclicArray);

    harness.logger.info('test.cycles', { cyclic, cyclicArray });

    const record = onlyRecord(harness);

    assert.equal(record.cyclic.name, 'loop');
    assert.equal(record.cyclic.self, CIRCULAR);
    assert.deepEqual(record.cyclicArray, [CIRCULAR]);
  });

  test('does not mark a shared but acyclic reference as circular', () => {
    const harness = createLogger();
    const shared = { value: 7 };

    harness.logger.info('test.shared', { first: shared, second: shared });

    const record = onlyRecord(harness);

    assert.deepEqual(record.first, { value: 7 });
    assert.deepEqual(record.second, { value: 7 });
  });

  test('logs errors as name/code and a sanitized message, never a stack', () => {
    const harness = createLogger();
    const error = new Error(
      'upstream failed Bearer abc.def token=supersecret\nsecond line',
    );
    error.name = 'ProviderError';
    error.code = 'E_PROVIDER_TIMEOUT';

    harness.logger.error('test.error', { error, attempt: 2 });

    const record = onlyRecord(harness);

    assert.deepEqual(Object.keys(record.error).sort(), [
      'code',
      'message',
      'name',
    ]);
    assert.equal(record.error.name, 'ProviderError');
    assert.equal(record.error.code, 'E_PROVIDER_TIMEOUT');
    assert.equal(record.error.message.includes('abc.def'), false);
    assert.equal(record.error.message.includes('supersecret'), false);
    assert.equal(record.error.message.includes('\n'), false);
    assert.match(record.error.message, /Bearer \[redacted\]/);
    assert.doesNotMatch(harness.lines.join(''), /at .*structured-logger/);
  });

  test('sanitizes error messages without throwing on odd values', () => {
    assert.equal(
      sanitizeErrorMessage('password=hunter2 and token=abc'),
      'password=[redacted] and token=[redacted]',
    );
    assert.equal(sanitizeErrorMessage('line\u0000break\u001b[31m'), 'line break [31m');
    assert.equal(sanitizeErrorMessage('x'.repeat(1000)).length, 500 + '[truncated]'.length);
    assert.deepEqual(safeError('plain failure'), {
      name: 'Error',
      message: 'plain failure',
    });
    assert.deepEqual(safeError(undefined), {
      name: 'Error',
      message: 'non-error value thrown',
    });
  });

  test('stringifies values JSON cannot represent instead of throwing', () => {
    const harness = createLogger();
    const payload = {
      big: 10n,
      when: new Date('2026-11-03T00:00:00.000Z'),
      set: new Set(['a', 'b']),
      map: new Map([['k', 'v']]),
      unsupportedValue: () => 'fn',
      symbol: Symbol('s'),
      notANumber: Number.NaN,
      missing: undefined,
      invalidDate: new Date('nope'),
    };

    assert.doesNotThrow(() => {
      harness.logger.info('test.types', payload);
    });

    const record = onlyRecord(harness);

    assert.equal(record.big, '10n');
    assert.equal(record.when, '2026-11-03T00:00:00.000Z');
    assert.deepEqual(record.set, ['a', 'b']);
    assert.deepEqual(record.map, { k: 'v' });
    assert.equal(record.unsupportedValue, UNSUPPORTED);
    assert.equal(record.symbol, UNSUPPORTED);
    assert.equal(record.notANumber, 'NaN');
    assert.equal('missing' in record, false);
    assert.equal(record.invalidDate, '[invalid-date]');
  });

  test('never invokes getters', () => {
    const harness = createLogger();
    const payload = {};

    Object.defineProperty(payload, 'secretish', {
      enumerable: true,
      get() {
        throw new Error('getter must not run');
      },
    });
    Object.defineProperty(payload, 'lazy', {
      enumerable: true,
      get() {
        return 'not read';
      },
    });

    harness.logger.info('test.getters', { values: payload });

    const record = onlyRecord(harness);

    assert.equal(record.values.lazy, UNREADABLE);
    assert.equal(harness.lines.join('').includes('not read'), false);
    assert.equal(harness.lines.join('').includes('getter must not run'), false);
  });

  test('tolerates a non-object fields argument', () => {
    const harness = createLogger();

    harness.logger.info('test.null_fields', null);
    harness.logger.info('test.string_fields', 'ignored');

    const records = harness.records();

    assert.equal(records.length, 2);
    assert.equal(records[0].event, 'test.null_fields');
    assert.equal(records[1].event, 'test.string_fields');
  });
});

describe('request id validation and correlation', () => {
  test('accepts only the bounded safe alphabet', () => {
    for (const valid of [
      'a',
      'ABC.123_456-789',
      '0'.repeat(MAX_REQUEST_ID_LENGTH),
      'f47ac10b-58cc-4372-a567-0e02b2c3d479',
    ]) {
      assert.equal(isValidRequestId(valid), true, valid);
    }

    for (const invalid of [
      '',
      'a'.repeat(MAX_REQUEST_ID_LENGTH + 1),
      'has space',
      'semi;colon',
      'line\nbreak',
      'quote"',
      'ümlaut',
      '../../etc/passwd',
      42,
      null,
      undefined,
      ['abc'],
      { id: 'abc' },
    ]) {
      assert.equal(isValidRequestId(invalid), false, JSON.stringify(invalid));
    }
  });

  test('keeps a valid inbound id and replaces anything else', () => {
    assert.equal(normalizeRequestId('req.ok-1'), 'req.ok-1');
    assert.equal(normalizeRequestId(['req.array', 'ignored']), 'req.array');
    assert.equal(normalizeRequestId(['bad id']), undefined);
    assert.equal(normalizeRequestId(undefined), undefined);
    assert.equal(resolveRequestId('req.valid', () => 'generated'), 'req.valid');
    assert.equal(resolveRequestId('bad id', () => 'generated'), 'generated');

    const generated = resolveRequestId(undefined);
    assert.match(generated, /^[A-Za-z0-9._-]{1,128}$/);
    assert.notEqual(generated, resolveRequestId(undefined));
  });

  test('propagates the id through sync and async work only', async () => {
    assert.equal(currentRequestId(), undefined);
    assert.equal(runWithRequestId('req-1', () => currentRequestId()), 'req-1');

    await new Promise((resolve) => {
      runWithRequestId('req-2', () => {
        setImmediate(() => {
          assert.equal(currentRequestId(), 'req-2');
          resolve();
        });
      });
    });

    assert.equal(currentRequestId(), undefined);
  });

  test('echoes the header without ever failing the response', () => {
    const headers = {};
    const response = {
      setHeader(name, value) {
        headers[name] = value;
      },
    };

    echoRequestId('req-echo', response);
    assert.equal(headers[REQUEST_ID_HEADER], 'req-echo');

    const sent = {
      headersSent: true,
      setHeader() {
        assert.fail('must not set a header after the response started');
      },
    };
    assert.doesNotThrow(() => echoRequestId('req-late', sent));

    const broken = {
      setHeader() {
        throw new Error('immutable headers');
      },
    };
    assert.doesNotThrow(() => echoRequestId('req-broken', broken));
  });
});

describe('observability config', () => {
  test('defaults the level to info and trims the service name', () => {
    const previous = process.env.HABI_LOG_LEVEL;
    delete process.env.HABI_LOG_LEVEL;

    try {
      const config = normalizeObservabilityConfig({ service: '  api  ' });

      assert.equal(config.service, 'api');
      assert.equal(config.level, 'info');
      assert.equal(config.write, undefined);
      assert.equal(config.now, undefined);
    } finally {
      if (previous === undefined) {
        delete process.env.HABI_LOG_LEVEL;
      } else {
        process.env.HABI_LOG_LEVEL = previous;
      }
    }
  });

  test('honours HABI_LOG_LEVEL and ignores invalid values', () => {
    const previous = process.env.HABI_LOG_LEVEL;

    try {
      process.env.HABI_LOG_LEVEL = 'debug';
      assert.equal(normalizeObservabilityConfig({ service: 'api' }).level, 'debug');

      process.env.HABI_LOG_LEVEL = 'verbose';
      assert.equal(normalizeObservabilityConfig({ service: 'api' }).level, 'info');

      assert.equal(
        normalizeObservabilityConfig({ service: 'api', level: 'WARN' }).level,
        'warn',
      );
    } finally {
      if (previous === undefined) {
        delete process.env.HABI_LOG_LEVEL;
      } else {
        process.env.HABI_LOG_LEVEL = previous;
      }
    }
  });

  test('rejects missing or unusable service names', () => {
    assert.throws(() => normalizeObservabilityConfig({}), TypeError);
    assert.throws(() => normalizeObservabilityConfig({ service: 'api v1' }), TypeError);
    assert.throws(() => normalizeObservabilityConfig({ service: 'api'.repeat(40) }), TypeError);
    assert.equal(parseLogLevel('debug'), 'debug');
    assert.equal(parseLogLevel('nope'), undefined);
    assert.equal(parseLogLevel(3), undefined);
  });
});
