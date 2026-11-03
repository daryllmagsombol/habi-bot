/**
 * Configuration for the H-013 (#13) observability slice.
 *
 * The logger, metrics counter, middleware, and exception filter all resolve
 * one injected config object so a process has exactly one service name and
 * log level. `write` and `now` are narrow test seams: production code never
 * passes them, so the default sink stays stdout and the default clock stays
 * `Date.now`.
 *
 * Nothing here reads prompt text, credentials, or request payloads. The
 * service name is a short static identifier chosen at wiring time.
 */

/** Injection token shared by the logger, metrics, middleware, and filter. */
export const OBSERVABILITY_CONFIG = Symbol('HABI_OBSERVABILITY_CONFIG');

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export const LOG_LEVELS: readonly LogLevel[] = Object.freeze([
  'debug',
  'info',
  'warn',
  'error',
]);

export const DEFAULT_LOG_LEVEL: LogLevel = 'info';

export interface ObservabilityConfig {
  /** Static, low-cardinality process identity, e.g. `api` or `worker`. */
  readonly service: string;
  /** Minimum level emitted; lower levels are dropped. */
  readonly level: LogLevel;
  /** Sink for one serialized JSON line, including its trailing newline. */
  readonly write?: (line: string) => void;
  /** Milliseconds since the epoch; injectable for deterministic tests. */
  readonly now?: () => number;
}

export interface ObservabilityModuleOptions {
  readonly service: string;
  /** Defaults to `HABI_LOG_LEVEL` when valid, otherwise `info`. */
  readonly level?: LogLevel | string;
  readonly write?: (line: string) => void;
  readonly now?: () => number;
}

/** Bounded, label-safe: no spaces, quotes, or newlines reach a log line. */
const SERVICE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function parseLogLevel(raw: unknown): LogLevel | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }

  const normalized = raw.trim().toLowerCase();
  return LOG_LEVELS.find((level) => level === normalized);
}

/**
 * Validates wiring-time options and fills defaults. Invalid input throws so a
 * misconfigured process fails at bootstrap instead of emitting unusable logs.
 */
export function normalizeObservabilityConfig(
  options: ObservabilityModuleOptions,
): ObservabilityConfig {
  const service = readService(options.service);
  const level =
    parseLogLevel(options.level) ??
    parseLogLevel(process.env.HABI_LOG_LEVEL) ??
    DEFAULT_LOG_LEVEL;

  return {
    service,
    level,
    ...(options.write === undefined ? {} : { write: options.write }),
    ...(options.now === undefined ? {} : { now: options.now }),
  };
}

function readService(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new TypeError(
      'ObservabilityModule.forRoot requires a service name string, e.g. { service: "api" }.',
    );
  }

  const service = raw.trim();

  if (!SERVICE_PATTERN.test(service)) {
    throw new TypeError(
      'Observability service must be 1-64 characters of A-Z a-z 0-9 . _ - and start alphanumeric.',
    );
  }

  return service;
}
