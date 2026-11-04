/**
 * Acceptance report model, redaction, and rendering.
 *
 * Pure functions only: no database, network, or filesystem. The CLI writes the
 * two artifacts; this module decides the status roll-up and the exit code so
 * the rules are testable without Docker.
 *
 * Status precedence is deliberate:
 *   fail    a check ran and the product did not meet the requirement
 *   blocked a check could not run (missing host, provider registration, tool)
 *   pass    every check ran and passed
 *
 * A scenario with one failed check is `fail` even when other checks passed.
 * A scenario with a blocked check and no failures is `blocked`, never `pass`.
 */

export const STATUSES = ['pass', 'blocked', 'fail'];

const STATUS_RANK = { pass: 0, blocked: 1, fail: 2 };

/** Keys whose values are credentials or credential-adjacent. */
const SENSITIVE_KEY =
  /(?:password|passwd|secret|token|cookie|authorization|api[_-]?key|gateway[_-]?key|session(?:id|secret)?$)/i;

// Anchored to a token boundary on purpose. Without the leading delimiter the
// scheme repetition can restart at every character of a long alphanumeric run,
// which is quadratic: measured 6.0 s for 100 kB of letters, versus 1 ms here.
// Evidence strings are ours, but a provider or upstream error can reach a
// report, so the scanner must stay linear on hostile input.
const URL_CREDENTIALS = /(^|[\s"'(\[<=,;])([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi;
const SESSION_COOKIE = /\b(?:__Host-)?habi_session=[^;\s]+/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/g;

export function worstStatus(statuses) {
  let worst = 'pass';

  for (const status of statuses) {
    if (!(status in STATUS_RANK)) {
      throw new TypeError(`Unknown acceptance status: ${status}`);
    }

    if (STATUS_RANK[status] > STATUS_RANK[worst]) {
      worst = status;
    }
  }

  return worst;
}

/**
 * Redacts credentials from a value that will be written to the report.
 *
 * Two layers: structural (a key named `token` never carries its value, even a
 * harmless one) and textual (connection strings, cookies, bearer headers).
 * The structured layer is intentionally blunt; evidence should be built from
 * statuses and ids, not from credential values.
 */
export function redact(value, key = '') {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    if (SENSITIVE_KEY.test(key)) {
      return '[redacted]';
    }

    return value
      .replaceAll(URL_CREDENTIALS, '$1$2[redacted]@')
      .replaceAll(SESSION_COOKIE, 'habi_session=[redacted]')
      .replaceAll(BEARER, 'Bearer [redacted]');
  }

  // Counts and booleans are evidence, never credentials, even when their key
  // contains a sensitive word (`tokensAdded`, `newSession`, `setCookie`).
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, key));
  }

  if (typeof value === 'object') {
    const result = {};

    for (const [childKey, childValue] of Object.entries(value)) {
      result[childKey] = redact(childValue, childKey);
    }

    return result;
  }

  return String(value);
}

export function createCheck({ name, status, detail, evidence }) {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new TypeError('A check needs a name.');
  }

  if (!(status in STATUS_RANK)) {
    throw new TypeError(`Unknown check status: ${status}`);
  }

  return {
    name,
    status,
    ...(detail === undefined ? {} : { detail }),
    ...(evidence === undefined ? {} : { evidence: redact(evidence) }),
  };
}

export function createScenario({
  id,
  title,
  checks,
  evidence,
  blockers,
  residualRisks,
  startedAt,
  finishedAt,
}) {
  const normalizedChecks = checks.map((check) => ({ ...check }));

  if (normalizedChecks.length === 0) {
    normalizedChecks.push(
      createCheck({
        name: 'scenario executed',
        status: 'blocked',
        detail: 'The scenario produced no checks, so it proves nothing.',
      }),
    );
  }

  const status = worstStatus(normalizedChecks.map((check) => check.status));
  const start = startedAt ?? new Date().toISOString();
  const finish = finishedAt ?? new Date().toISOString();

  return {
    id,
    title,
    status,
    startedAt: start,
    finishedAt: finish,
    durationMs: Math.max(0, Date.parse(finish) - Date.parse(start)),
    checks: normalizedChecks,
    ...(evidence === undefined ? {} : { evidence: redact(evidence) }),
    ...(blockers === undefined || blockers.length === 0
      ? {}
      : { blockers: blockers.map((blocker) => redact(blocker)) }),
    ...(residualRisks === undefined || residualRisks.length === 0
      ? {}
      : { residualRisks: residualRisks.map((risk) => redact(risk)) }),
  };
}

export function summarize(scenarios) {
  const counts = { pass: 0, fail: 0, blocked: 0, total: scenarios.length };

  for (const scenario of scenarios) {
    if (scenario.status in counts) {
      counts[scenario.status] += 1;
    }
  }

  // Any real failure is a non-zero exit. Blockers alone are an incomplete run,
  // not a pass: the caller must not read exit 0 as acceptance.
  const exitCode = counts.fail > 0 ? 1 : 0;
  const parts = [
    `${counts.pass} passed`,
    `${counts.fail} failed`,
    `${counts.blocked} blocked`,
  ];

  const line =
    exitCode === 0
      ? `acceptance: ${parts.join(', ')} — no failures; blocked scenarios are NOT acceptance and P1 exit is not declared`
      : `acceptance: ${parts.join(', ')} — FAILED; do not treat this run as a P1 go`;

  return { ...counts, exitCode, line };
}

export function parseScenarioFilter(raw, knownIds) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return [];
  }

  const requested = String(raw)
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  for (const id of requested) {
    if (!knownIds.includes(id)) {
      throw new Error(
        `Unknown scenario "${id}". Known scenarios: ${knownIds.join(', ')}`,
      );
    }
  }

  return [...new Set(requested)];
}

export function selectScenarios(scenarios, filter) {
  if (filter.length === 0) {
    return scenarios;
  }

  return scenarios.filter((scenario) => filter.includes(scenario.id));
}

function escapeCell(value) {
  return String(value ?? '')
    .replaceAll('|', String.raw`\|`)
    .replaceAll('\n', ' ');
}

function scenarioCounts(checks) {
  const counts = { pass: 0, fail: 0, blocked: 0 };

  for (const check of checks) {
    counts[check.status] += 1;
  }

  return counts;
}

function renderMatrixRow(scenario) {
  const counts = scenarioCounts(scenario.checks);
  const blockers =
    scenario.blockers === undefined ? '' : escapeCell(scenario.blockers.join('; '));

  return (
    `| ${escapeCell(scenario.id)} — ${escapeCell(scenario.title)} | ` +
    `**${scenario.status}** | ${counts.pass}/${counts.fail}/${counts.blocked} | ` +
    `${blockers} |`
  );
}

function renderMatrix(scenarios) {
  return [
    '## Matrix',
    '',
    '| Scenario | Status | Checks (pass/fail/blocked) | Blockers |',
    '| --- | --- | --- | --- |',
    ...scenarios.map(renderMatrixRow),
    '',
  ];
}

function renderCheckRow(check) {
  return `| ${escapeCell(check.name)} | ${check.status} | ${escapeCell(check.detail ?? '')} |`;
}

/** A labelled bullet list, prefixed by the blank line that separates it. */
function renderBulletSection(label, items) {
  return ['', label, ...items.map((item) => `- ${item}`)];
}

function renderScenarioDetail(scenario) {
  return [
    `### ${scenario.id} — ${scenario.title}`,
    '',
    `Status: **${scenario.status}**`,
    '',
    '| Check | Status | Detail |',
    '| --- | --- | --- |',
    ...scenario.checks.map(renderCheckRow),
    ...(scenario.blockers === undefined
      ? []
      : renderBulletSection('Blockers:', scenario.blockers)),
    ...(scenario.residualRisks === undefined
      ? []
      : renderBulletSection('Residual risks:', scenario.residualRisks)),
    '',
  ];
}

function renderEnvironment(environment) {
  const rows = Object.entries(environment)
    .filter(([key]) => key !== 'configKeys')
    .map(([key, value]) => `| ${escapeCell(key)} | ${escapeCell(value)} |`);
  const configKeys = Object.entries(environment.configKeys ?? {}).map(
    ([key, presence]) => `- \`${key}\`: ${presence}`,
  );

  return [
    '## Frozen environment',
    '',
    '| Key | Value |',
    '| --- | --- |',
    ...rows,
    '',
    'Configuration keys (presence only; values are never recorded):',
    '',
    ...configKeys,
    '',
  ];
}

export function renderMarkdown(report) {
  const summary = summarize(report.scenarios);
  const lines = [
    '# P1 acceptance report',
    '',
    `Generated: ${report.generatedAt}`,
    '',
    '## Result',
    '',
    '```',
    summary.line,
    '```',
    '',
    'The harness never declares a P1 go. A run with zero failures and some ' +
      'blocked scenarios is incomplete evidence; the exit decision belongs to ' +
      'the owner.',
    '',
    ...renderMatrix(report.scenarios),
    '## Scenario detail',
    '',
    ...report.scenarios.flatMap(renderScenarioDetail),
    ...renderEnvironment(report.environment),
    '## Evidence handling',
    '',
    'Evidence records request/response status, error codes, ids, and counts. ' +
      'Passwords, session cookies, CSRF tokens, provider keys, and connection ' +
      'string credentials are redacted before the report is written. The ' +
      'report lives outside the repository tree.',
    '',
    '## What this run does not prove',
    '',
    'This harness runs against a disposable local PostgreSQL container and ' +
      'local stub harness, not a deployed staging VM. Deployed-stack behavior, ' +
      'real provider throughput, real SSO registrations, and host resource ' +
      'impact remain unverified unless their scenarios are marked pass with ' +
      'that environment configured.',
    '',
  ];

  return `${lines.join('\n')}\n`;
}

export function buildReport({
  scenarios,
  environment,
  generatedAt = new Date().toISOString(),
  harness,
}) {
  const redactedEnvironment = redact(environment);

  // Presence strings are not credentials. Keep them readable so the frozen
  // environment actually records which keys were absent; every other value
  // still passes through redaction.
  if (environment?.configKeys !== undefined) {
    redactedEnvironment.configKeys = { ...environment.configKeys };
  }

  const report = {
    schemaVersion: 1,
    generatedAt,
    harness,
    environment: redactedEnvironment,
    scenarios,
  };

  return { ...report, summary: summarize(scenarios) };
}
