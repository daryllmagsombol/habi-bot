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

const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi;
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
      .replace(URL_CREDENTIALS, '$1[redacted]@')
      .replace(SESSION_COOKIE, 'habi_session=[redacted]')
      .replace(BEARER, 'Bearer [redacted]');
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
    .replaceAll('|', '\\|')
    .replaceAll('\n', ' ');
}

export function renderMarkdown(report) {
  const summary = summarize(report.scenarios);
  const lines = [];

  lines.push('# P1 acceptance report');
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push('');
  lines.push('## Result');
  lines.push('');
  lines.push('```');
  lines.push(summary.line);
  lines.push('```');
  lines.push('');
  lines.push(
    'The harness never declares a P1 go. A run with zero failures and some ' +
      'blocked scenarios is incomplete evidence; the exit decision belongs to ' +
      'the owner.',
  );
  lines.push('');
  lines.push('## Matrix');
  lines.push('');
  lines.push('| Scenario | Status | Checks (pass/fail/blocked) | Blockers |');
  lines.push('| --- | --- | --- | --- |');

  for (const scenario of report.scenarios) {
    const counts = { pass: 0, fail: 0, blocked: 0 };

    for (const check of scenario.checks) {
      counts[check.status] += 1;
    }

    lines.push(
      `| ${escapeCell(scenario.id)} — ${escapeCell(scenario.title)} | ` +
        `**${scenario.status}** | ${counts.pass}/${counts.fail}/${counts.blocked} | ` +
        `${scenario.blockers === undefined ? '' : escapeCell(scenario.blockers.join('; '))} |`,
    );
  }

  lines.push('');
  lines.push('## Scenario detail');
  lines.push('');

  for (const scenario of report.scenarios) {
    lines.push(`### ${scenario.id} — ${scenario.title}`);
    lines.push('');
    lines.push(`Status: **${scenario.status}**`);
    lines.push('');
    lines.push('| Check | Status | Detail |');
    lines.push('| --- | --- | --- |');

    for (const check of scenario.checks) {
      lines.push(
        `| ${escapeCell(check.name)} | ${check.status} | ${escapeCell(check.detail ?? '')} |`,
      );
    }

    if (scenario.blockers !== undefined) {
      lines.push('');
      lines.push('Blockers:');

      for (const blocker of scenario.blockers) {
        lines.push(`- ${blocker}`);
      }
    }

    if (scenario.residualRisks !== undefined) {
      lines.push('');
      lines.push('Residual risks:');

      for (const risk of scenario.residualRisks) {
        lines.push(`- ${risk}`);
      }
    }

    lines.push('');
  }

  lines.push('## Frozen environment');
  lines.push('');
  lines.push('| Key | Value |');
  lines.push('| --- | --- |');

  for (const [key, value] of Object.entries(report.environment)) {
    if (key === 'configKeys') {
      continue;
    }

    lines.push(`| ${escapeCell(key)} | ${escapeCell(value)} |`);
  }

  lines.push('');
  lines.push('Configuration keys (presence only; values are never recorded):');
  lines.push('');

  for (const [key, presence] of Object.entries(report.environment.configKeys ?? {})) {
    lines.push(`- \`${key}\`: ${presence}`);
  }

  lines.push('');
  lines.push('## Evidence handling');
  lines.push('');
  lines.push(
    'Evidence records request/response status, error codes, ids, and counts. ' +
      'Passwords, session cookies, CSRF tokens, provider keys, and connection ' +
      'string credentials are redacted before the report is written. The ' +
      'report lives outside the repository tree.',
  );
  lines.push('');
  lines.push('## What this run does not prove');
  lines.push('');
  lines.push(
    'This harness runs against a disposable local PostgreSQL container and ' +
      'local stub harness, not a deployed staging VM. Deployed-stack behavior, ' +
      'real provider throughput, real SSO registrations, and host resource ' +
      'impact remain unverified unless their scenarios are marked pass with ' +
      'that environment configured.',
  );
  lines.push('');

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
