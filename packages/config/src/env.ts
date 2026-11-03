/**
 * Dependency-free environment validation shared by Habi processes.
 *
 * This module is pure: it never reads `process.env`, the filesystem, or the
 * network. Callers pass the environment they want validated, which keeps the
 * package entry point safe to import from any runtime (including the browser)
 * without exposing server-only resources.
 *
 * Error messages list keys and static rule descriptions only. Supplied values
 * are never echoed, so a malformed secret cannot leak through a thrown error.
 */

/** Accepted `NODE_ENV` values, in documentation order. */
export const NODE_ENV_VALUES = ['development', 'test', 'production'] as const;

export type NodeEnv = (typeof NODE_ENV_VALUES)[number];

/** A single validation failure. Never carries the offending value. */
export interface EnvIssue {
  readonly key: string;
  readonly reason: string;
}

/**
 * Validated environment for Habi processes.
 *
 * `NODE_ENV`, `HOST`, and `PORT` always have a value. The PostgreSQL keys are
 * Compose/database-only: they stay absent unless the caller supplied them, and
 * they are validated only for shape because application runtime does not
 * require a database yet.
 */
export interface Env {
  readonly NODE_ENV: NodeEnv;
  readonly HOST: string;
  readonly PORT: number;
  readonly API_PORT?: number;
  readonly POSTGRES_DB?: string;
  readonly POSTGRES_USER?: string;
  readonly POSTGRES_PASSWORD?: string;
  readonly POSTGRES_PORT?: number;
}

/** Aggregated validation failure for every invalid key at once. */
export class EnvValidationError extends Error {
  /** Invalid keys, in the order they were validated. */
  readonly keys: readonly string[];

  /** Invalid keys with their static rule descriptions. */
  readonly issues: readonly EnvIssue[];

  constructor(issues: readonly EnvIssue[]) {
    super(
      `Invalid environment configuration: ${issues
        .map((issue) => `${issue.key} (${issue.reason})`)
        .join('; ')}`,
    );

    this.name = 'EnvValidationError';
    this.keys = issues.map((issue) => issue.key);
    this.issues = issues.map((issue) => ({ ...issue }));
  }
}

type Source = Record<string, string | undefined>;

const DEFAULT_NODE_ENV: NodeEnv = 'development';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3001;
const MIN_PORT = 1;
const MAX_PORT = 65535;

const PORT_RULE = `must be an integer between ${MIN_PORT} and ${MAX_PORT}`;
const HOST_RULE = 'must be a non-empty hostname or IP address';
const NAME_RULE = 'must be a non-empty value without whitespace';

/** Letters, digits, dots, dashes, underscores, and colons (bare IPv6). */
const HOST_PATTERN = /^[A-Za-z0-9:](?:[A-Za-z0-9._:-]*[A-Za-z0-9])?$/;

const DIGITS = /^\d+$/;
const WHITESPACE = /\s/;

function isNodeEnv(value: string): value is NodeEnv {
  return (NODE_ENV_VALUES as readonly string[]).includes(value);
}

/** An absent or empty value is unset; anything else is supplied. */
function readRaw(source: Source, key: string): string | undefined {
  const raw = source[key];

  return raw === undefined || raw === '' ? undefined : raw;
}

function readTrimmed(
  source: Source,
  key: string,
  issues: EnvIssue[],
): string | undefined {
  const raw = readRaw(source, key);

  if (raw === undefined) {
    return undefined;
  }

  const value = raw.trim();

  if (value === '') {
    issues.push({ key, reason: 'must not be blank' });
    return undefined;
  }

  return value;
}

function readPort(
  source: Source,
  key: string,
  issues: EnvIssue[],
): number | undefined {
  const value = readTrimmed(source, key, issues);

  if (value === undefined) {
    return undefined;
  }

  const port = DIGITS.test(value) ? Number(value) : Number.NaN;

  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    issues.push({ key, reason: PORT_RULE });
    return undefined;
  }

  return port;
}

/** Database names and roles: supplied values must not contain whitespace. */
function readName(
  source: Source,
  key: string,
  issues: EnvIssue[],
): string | undefined {
  const raw = readRaw(source, key);

  if (raw === undefined) {
    return undefined;
  }

  if (WHITESPACE.test(raw)) {
    issues.push({ key, reason: NAME_RULE });
    return undefined;
  }

  return raw;
}

function readNodeEnv(source: Source, issues: EnvIssue[]): NodeEnv {
  const value = readTrimmed(source, 'NODE_ENV', issues);

  if (value === undefined) {
    return DEFAULT_NODE_ENV;
  }

  if (!isNodeEnv(value)) {
    issues.push({
      key: 'NODE_ENV',
      reason: `must be one of ${NODE_ENV_VALUES.join(', ')}`,
    });
    return DEFAULT_NODE_ENV;
  }

  return value;
}

function readHost(source: Source, issues: EnvIssue[]): string {
  const value = readTrimmed(source, 'HOST', issues);

  if (value === undefined) {
    return DEFAULT_HOST;
  }

  if (!HOST_PATTERN.test(value)) {
    issues.push({ key: 'HOST', reason: HOST_RULE });
    return DEFAULT_HOST;
  }

  return value;
}

/**
 * Validate a process environment.
 *
 * @param source Key/value pairs, typically `process.env`. Keys that are absent
 *   or empty fall back to defaults where one exists.
 * @returns The validated environment with `PORT` defaulted to 3001.
 * @throws {EnvValidationError} Aggregated failure listing every invalid key
 *   without echoing any supplied value.
 */
export function parseEnv(source: Source): Env {
  const issues: EnvIssue[] = [];

  const nodeEnv = readNodeEnv(source, issues);
  const host = readHost(source, issues);
  const port = readPort(source, 'PORT', issues) ?? DEFAULT_PORT;
  const apiPort = readPort(source, 'API_PORT', issues);
  const postgresDb = readName(source, 'POSTGRES_DB', issues);
  const postgresUser = readName(source, 'POSTGRES_USER', issues);
  const postgresPassword = readName(source, 'POSTGRES_PASSWORD', issues);
  const postgresPort = readPort(source, 'POSTGRES_PORT', issues);

  if (issues.length > 0) {
    throw new EnvValidationError(issues);
  }

  return {
    NODE_ENV: nodeEnv,
    HOST: host,
    PORT: port,
    ...(apiPort === undefined ? {} : { API_PORT: apiPort }),
    ...(postgresDb === undefined ? {} : { POSTGRES_DB: postgresDb }),
    ...(postgresUser === undefined ? {} : { POSTGRES_USER: postgresUser }),
    ...(postgresPassword === undefined
      ? {}
      : { POSTGRES_PASSWORD: postgresPassword }),
    ...(postgresPort === undefined ? {} : { POSTGRES_PORT: postgresPort }),
  };
}
