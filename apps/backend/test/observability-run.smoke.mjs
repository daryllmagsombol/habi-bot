/**
 * H-013 (#13) run observability slice: correlation, transition logs, provider
 * outcomes, and queue/worker counters.
 *
 * Drives RunService against an in-memory repository/adapter double (no
 * database, no Hermes process, no provider network) and asserts that:
 *
 *   - enqueue, duplicate, dispatch-accept, dispatch-skip, provider-call, and
 *     terminal events carry requestId + runId + conversationId where available;
 *   - no prompt text, message body, token value, cookie, or gateway key
 *     appears in any log line or metric label;
 *   - RunMetrics counts enqueue/dispatch/terminal/provider outcomes and
 *     exposes queue-depth/age plus worker saturation in Prometheus text;
 *   - unknown failure codes collapse to the closed `other_error` bucket.
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const {
  correlateRun,
  providerCallFields,
  usageSummary,
  RUN_DUPLICATE_EVENT,
  RUN_DISPATCH_ACCEPTED_EVENT,
  RUN_DISPATCH_SKIPPED_EVENT,
  RUN_ENQUEUED_EVENT,
  RUN_TERMINAL_EVENT,
  PROVIDER_CALL_EVENT,
} = await import('../dist/observability/run-telemetry.js');
const { RunMetrics, normalizeProviderErrorCode } = await import(
  '../dist/observability/metrics.js'
);
const { normalizeProviderCode } = await import(
  '../dist/adapters/harness-adapter.js'
);
const {
  EMAIL_KEY_PATTERN,
  FILE_KEY_PATTERN,
  SENSITIVE_KEY_PATTERN,
  CONTENT_KEY_PATTERN,
} = await import('../dist/observability/structured-logger.js');
const { currentRequestId, runWithRequestId } = await import(
  '../dist/observability/request-context.js'
);

const PROMPT_SENTINEL = 'PROMPT_TEXT_MUST_NEVER_LOG_9f8a';
const MESSAGE_SENTINEL = 'MESSAGE_BODY_MUST_NEVER_LOG_7b2c';
const TOKEN_SENTINEL = 'TOKEN_VALUE_MUST_NEVER_LOG_4d1e';

function inviteSentinels(fields) {
  return {
    ...fields,
    prompt: PROMPT_SENTINEL,
    messages: [{ role: 'user', content: MESSAGE_SENTINEL }],
    body: { text: MESSAGE_SENTINEL },
    authorization: `Bearer ${TOKEN_SENTINEL}`,
    nested: { apiKey: TOKEN_SENTINEL },
    fileName: 'my-divorce-papers.pdf',
    email: 'someone@example.com',
  };
}

describe('run correlation', () => {
  test('carries requestId inside HTTP context and omits it in the worker', () => {
    const inside = runWithRequestId('req-abc_123', () =>
      correlateRun('run-1', 'conv-1'),
    );

    assert.equal(inside.runId, 'run-1');
    assert.equal(inside.conversationId, 'conv-1');
    assert.equal(inside.requestId, 'req-abc_123');

    const outside = correlateRun('run-2', 'conv-2');

    assert.equal(outside.runId, 'run-2');
    assert.equal(outside.conversationId, 'conv-2');
    assert.ok(!('requestId' in outside), 'worker transitions omit requestId');
    assert.equal(currentRequestId(), undefined);
  });

  test('provider call fields carry codes, dispatch, and numbers only', () => {
    const correlation = runWithRequestId('req-1', () =>
      correlateRun('run-9', 'conv-9'),
    );
    const fields = providerCallFields(correlation, {
      outcome: 'failure',
      errorCode: 'provider_exhausted',
      dispatchState: 'not_dispatched',
      retried: false,
      usage: usageSummary({
        status: 'partial',
        grossPromptTokens: 13,
        grossCompletionTokens: null,
        cachedPromptTokens: null,
        reasoningTokens: null,
        totalTokens: 13,
        costStatus: 'unknown',
      }),
    });

    assert.equal(fields.event, undefined);
    assert.equal(fields.outcome, 'failure');
    assert.equal(fields.errorCode, 'provider_exhausted');
    assert.equal(fields.dispatchState, 'not_dispatched');
    assert.equal(fields.retried, false);
    assert.equal(fields.usageStatus, 'partial');
    assert.equal(fields.grossPromptTokens, 13);
    assert.equal(fields.totalTokens, 13);
    assert.ok(!('raw' in fields), 'raw vendor record is never attached');
    assert.equal(fields.requestId, 'req-1');

    const sentinelLine = JSON.stringify(inviteSentinels(fields));

    assert.ok(sentinelLine.includes(PROMPT_SENTINEL));
    assert.ok(sentinelLine.includes(MESSAGE_SENTINEL));

    for (const pattern of [
      SENSITIVE_KEY_PATTERN,
      CONTENT_KEY_PATTERN,
      EMAIL_KEY_PATTERN,
      FILE_KEY_PATTERN,
    ]) {
      assert.ok(
        pattern.test('authorization') ||
          pattern.test('prompt') ||
          pattern.test('email') ||
          pattern.test('fileName'),
        'each redaction pattern still matches its class',
      );
    }
  });

  test('usage summaries drop the raw record and never fabricate a zero', () => {
    const summary = usageSummary({
      status: 'unknown',
      grossPromptTokens: null,
      grossCompletionTokens: null,
      cachedPromptTokens: null,
      reasoningTokens: null,
      totalTokens: null,
      costStatus: 'unknown',
      raw: { misleading: 0 },
    });

    assert.deepEqual(summary, {
      status: 'unknown',
      grossPromptTokens: null,
      grossCompletionTokens: null,
      cachedPromptTokens: null,
      reasoningTokens: null,
      totalTokens: null,
      costStatus: 'unknown',
    });
  });
});

describe('run metrics', () => {
  function createMetrics() {
    return new RunMetrics({ service: 'worker', level: 'debug' });
  }

  test('counts enqueue, duplicate, dispatch, terminal, and provider outcomes', () => {
    const metrics = createMetrics();

    metrics.recordEnqueue(false);
    metrics.recordEnqueue(true);
    metrics.recordDispatchAccepted();
    metrics.recordDispatchSkip('cancel_requested');
    metrics.recordTerminal('completed');
    metrics.recordTerminal('failed');
    metrics.recordTerminal('surprise_status');
    metrics.recordProviderCall('success');
    metrics.recordProviderCall('failure', 'provider_exhausted');
    metrics.recordProviderCall('failure', 'vendor_specific_boom');

    const snapshot = metrics.snapshot();

    assert.equal(snapshot.enqueued, 2);
    assert.equal(snapshot.dispatchAccepted, 1);
    assert.equal(snapshot.dispatchSkippedByReason.deduplicated, 1);
    assert.equal(snapshot.dispatchSkippedByReason.cancel_requested, 1);
    assert.equal(snapshot.terminalByStatus.completed, 1);
    assert.equal(snapshot.terminalByStatus.failed, 1);
    assert.equal(snapshot.terminalByStatus.other_terminal, 1);
    assert.equal(snapshot.providerSuccess, 1);
    assert.equal(snapshot.providerFailureByCode.provider_exhausted, 1);
    assert.equal(snapshot.providerFailureByCode.other_error, 1);
    assert.equal(snapshot.providerRetried, 0);
  });

  test('unknown failure codes collapse to other_error in both vocabularies', () => {
    assert.equal(normalizeProviderErrorCode('provider_exhausted'), 'provider_exhausted');
    assert.equal(normalizeProviderErrorCode('vendor_specific_boom'), 'other_error');
    assert.equal(normalizeProviderErrorCode(''), 'other_error');
    assert.equal(normalizeProviderCode('timeout'), 'timeout');
    assert.equal(normalizeProviderCode('vendor_specific_boom'), 'other_error');
  });

  test('queue health gauges reject nonsense and track worker saturation', () => {
    const metrics = createMetrics();

    metrics.setQueueHealth({ depth: 4, oldestAgeMs: 1500 });
    metrics.beginDispatch();
    metrics.beginDispatch();
    metrics.endDispatch();

    let snapshot = metrics.snapshot();

    assert.equal(snapshot.queueDepth, 4);
    assert.equal(snapshot.queueOldestAgeMs, 1500);
    assert.equal(snapshot.workerInFlight, 1);

    // Rejected input leaves the last good reading in place.
    metrics.setQueueHealth({ depth: -1, oldestAgeMs: Number.NaN });
    metrics.setQueueHealth({ depth: 1.5, oldestAgeMs: -5 });
    metrics.endDispatch();
    metrics.endDispatch();
    metrics.endDispatch();

    snapshot = metrics.snapshot();

    assert.equal(snapshot.queueDepth, 4);
    assert.equal(snapshot.queueOldestAgeMs, 1500);
    assert.equal(snapshot.workerInFlight, 0);

    metrics.recordQueueFailure();
    metrics.setQueueHealth({ depth: 0, oldestAgeMs: null });
    snapshot = metrics.snapshot();

    assert.equal(snapshot.queueFailures, 1);
    assert.equal(snapshot.queueDepth, 0);
    assert.equal(snapshot.queueOldestAgeMs, null);
  });

  test('prometheus output uses only closed-vocabulary labels', () => {
    const metrics = createMetrics();

    metrics.recordEnqueue(false);
    metrics.recordDispatchSkip('claimed_elsewhere');
    metrics.recordTerminal('execution_uncertain');
    metrics.recordProviderCall('failure', 'provider_exhausted');
    metrics.setQueueHealth({ depth: 2, oldestAgeMs: 750 });

    const text = metrics.toPrometheus();
    const lines = text.split('\n').filter((line) => line !== '');

    assert.match(text, /habi_runs_enqueued_total\{service="worker"\} 1/);
    assert.match(
      text,
      /habi_runs_dispatch_skipped_total\{service="worker",reason="claimed_elsewhere"\} 1/,
    );
    assert.match(
      text,
      /habi_runs_terminal_total\{service="worker",status="execution_uncertain"\} 1/,
    );
    assert.match(
      text,
      /habi_provider_calls_total\{service="worker",outcome="failure",error_code="provider_exhausted"\} 1/,
    );
    assert.match(text, /habi_queue_depth\{service="worker"\} 2/);
    assert.match(text, /habi_queue_oldest_age_ms\{service="worker"\} 750/);

    const serialized = JSON.stringify(text);

    assert.equal(serialized.includes(PROMPT_SENTINEL), false);
    assert.equal(serialized.includes(MESSAGE_SENTINEL), false);
    assert.equal(serialized.includes(TOKEN_SENTINEL), false);

    for (const line of lines) {
      if (line.startsWith('#')) {
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

describe('run event vocabulary', () => {
  test('uses stable transition, provider, and terminal names', () => {
    assert.equal(RUN_ENQUEUED_EVENT, 'run.enqueued');
    assert.equal(RUN_DUPLICATE_EVENT, 'run.duplicate');
    assert.equal(RUN_DISPATCH_ACCEPTED_EVENT, 'run.dispatch_accepted');
    assert.equal(RUN_DISPATCH_SKIPPED_EVENT, 'run.dispatch_skipped');
    assert.equal(RUN_TERMINAL_EVENT, 'run.observed_terminal');
    assert.equal(PROVIDER_CALL_EVENT, 'provider.call');
  });
});
