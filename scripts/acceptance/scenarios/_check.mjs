/**
 * Small check-runner helpers. A thrown assertion becomes a recorded `fail`,
 * never an abandoned scenario: acceptance evidence must retain the failure.
 */
import { createCheck } from '../lib/report.mjs';

export function pass(name, detail, evidence) {
  return createCheck({ name, status: 'pass', detail, evidence });
}

export function fail(name, error, evidence) {
  return createCheck({
    name,
    status: 'fail',
    detail: error instanceof Error ? error.message : String(error),
    evidence,
  });
}

export function blocked(name, detail, evidence) {
  return createCheck({ name, status: 'blocked', detail, evidence });
}

export async function runCheck(checks, name, fn) {
  try {
    const evidence = await fn();
    checks.push(pass(name, undefined, evidence));
  } catch (error) {
    checks.push(fail(name, error));
  }

  return checks;
}
