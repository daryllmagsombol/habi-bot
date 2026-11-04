/**
 * H-025 acceptance-report helper tests.
 *
 * Pure report logic only: no Docker, database, API, or provider. Ensures a
 * secret cannot reach the written report, that failure outranks blocked, and
 * that a blocked-only run exits 0 while saying it is not acceptance.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const reportModule = await import(
  pathToFileURL(
    fileURLToPath(new URL('../../../scripts/acceptance/lib/report.mjs', import.meta.url)),
  ).href
);

const {
  buildReport,
  createCheck,
  createScenario,
  parseScenarioFilter,
  redact,
  renderMarkdown,
  summarize,
  worstStatus,
} = reportModule;

test('redact removes structural and textual credentials', () => {
  const redacted = redact({
    token: 'abc',
    cookie: 'habi_session=secret',
    nested: {
      authorization: 'Bearer abc.def',
      databaseUrl: 'postgres://habi:hunter2@127.0.0.1:5432/habi',
      note: 'cookie: habi_session=abcdef',
      tokensAdded: 2,
      newSession: true,
      setCookie: true,
    },
  });

  assert.equal(redacted.token, '[redacted]');
  assert.equal(redacted.cookie, '[redacted]');
  assert.equal(redacted.nested.authorization, '[redacted]');
  assert.equal(
    redacted.nested.databaseUrl,
    'postgres://[redacted]@127.0.0.1:5432/habi',
  );
  assert.equal(redacted.nested.note, 'cookie: habi_session=[redacted]');
  assert.equal(redacted.nested.tokensAdded, 2);
  assert.equal(redacted.nested.newSession, true);
  assert.equal(redacted.nested.setCookie, true);
  assert.ok(!JSON.stringify(redacted).includes('hunter2'));
});

test('status precedence is fail over blocked over pass', () => {
  assert.equal(worstStatus(['pass', 'blocked']), 'blocked');
  assert.equal(worstStatus(['blocked', 'fail', 'pass']), 'fail');
  assert.equal(worstStatus(['pass']), 'pass');
  assert.throws(() => worstStatus(['skipped']), /Unknown acceptance status/);
});

test('a scenario with no checks is blocked, not a pass', () => {
  const scenario = createScenario({
    id: 'empty',
    title: 'Empty',
    checks: [],
  });

  assert.equal(scenario.status, 'blocked');
  assert.equal(scenario.checks[0].status, 'blocked');
});

test('only a real failure makes the run exit non-zero', () => {
  const blocked = createScenario({
    id: 'blocked',
    title: 'Blocked',
    checks: [createCheck({ name: 'host', status: 'blocked', detail: 'no host' })],
  });
  const failed = createScenario({
    id: 'failed',
    title: 'Failed',
    checks: [createCheck({ name: 'assertion', status: 'fail', detail: 'no' })],
  });

  assert.equal(summarize([blocked]).exitCode, 0);
  assert.match(summarize([blocked]).line, /NOT acceptance/);
  assert.equal(summarize([blocked, failed]).exitCode, 1);
  assert.match(summarize([blocked, failed]).line, /FAILED/);
});

test('the report keeps blocked reasons and never writes a secret', () => {
  const scenario = createScenario({
    id: 'auth',
    title: 'Auth',
    checks: [
      createCheck({
        name: 'login',
        status: 'fail',
        detail: 'login returned 401',
        evidence: { request: 'POST /auth/login', password: 'hunter2' },
      }),
      createCheck({ name: 'sso', status: 'blocked', detail: 'missing registration' }),
    ],
    blockers: ['SSO: missing HABI_SSO_GOOGLE_CLIENT_ID'],
    residualRisks: ['session store is in-memory'],
  });
  const report = buildReport({
    scenarios: [scenario],
    environment: {
      repoCommit: 'abc',
      databaseUrl: 'postgres://habi:hunter2@127.0.0.1/habi',
      configKeys: {
        DATABASE_URL: 'present (value not recorded)',
        HABI_HERMES_GATEWAY_KEY: 'absent',
      },
    },
    harness: { name: 'test', version: 1, command: 'node run.mjs' },
  });
  const markdown = renderMarkdown(report);
  const json = JSON.stringify(report);

  assert.match(markdown, /auth/);
  assert.match(markdown, /\*\*fail\*\*/);
  assert.match(markdown, /missing registration/);
  assert.match(markdown, /SSO: missing HABI_SSO_GOOGLE_CLIENT_ID/);
  assert.ok(!markdown.includes('hunter2'));
  assert.ok(!json.includes('hunter2'));
  assert.equal(report.environment.configKeys.HABI_HERMES_GATEWAY_KEY, 'absent');
  assert.equal(
    report.environment.configKeys.DATABASE_URL,
    'present (value not recorded)',
  );
  assert.match(report.environment.databaseUrl, /^postgres:\/\/\[redacted\]@/);
  assert.equal(report.summary.exitCode, 1);
});

test('scenario filtering rejects unknown ids and de-duplicates', () => {
  assert.deepEqual(parseScenarioFilter('auth, isolation,auth', ['auth', 'isolation']), [
    'auth',
    'isolation',
  ]);
  assert.throws(
    () => parseScenarioFilter('nope', ['auth']),
    /Unknown scenario "nope"/,
  );
  assert.deepEqual(parseScenarioFilter(undefined, ['auth']), []);
});
