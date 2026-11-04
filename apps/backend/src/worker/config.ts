/**
 * Worker configuration read from the process environment.
 *
 * The worker is network- and database-inert unless `HABI_P1_WORKER=1`. Nothing
 * in this module opens a connection, and no value here is ever logged: the
 * gateway key is returned to the adapter constructor only.
 *
 * Numeric bounds are small on purpose. The worker is a single-process claim
 * loop in this slice; a durable multi-replica queue is not implemented.
 */

export interface WorkerLoopConfig {
  /** Maximum Runs dispatched concurrently by one worker process. */
  readonly concurrency: number;
  /** Maximum rows claimed per statement. Never larger than `concurrency`. */
  readonly batchSize: number;
  /** First idle wait; doubles up to `maxIdleBackoffMs`. */
  readonly idleBackoffMs: number;
  readonly maxIdleBackoffMs: number;
  /**
   * How long a claim/heartbeat timestamp stays fresh. A row older than this is
   * considered abandoned by a dead process and is handed to reconciliation.
   * It is never re-dispatched: a possibly-sent provider call is not retried.
   */
  readonly leaseMs: number;
  /** Grace period for in-flight dispatch during SIGTERM/SIGINT. */
  readonly drainMs: number;
  /** Bound on the stale-Run reconciliation scan. */
  readonly recoveryLimit: number;
  /** How often an idle worker looks for abandoned claims. */
  readonly sweepIntervalMs: number;
}

export interface HermesWorkerConfig {
  readonly baseUrl: string;
  readonly gatewayKey: string;
  readonly requestTimeoutMs?: number;
  readonly eventIdleTimeoutMs?: number;
}

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_IDLE_BACKOFF_MS = 500;
const DEFAULT_MAX_IDLE_BACKOFF_MS = 5_000;
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_DRAIN_MS = 5_000;
const DEFAULT_RECOVERY_LIMIT = 100;
const MAX_CONCURRENCY = 32;
const MAX_BATCH_SIZE = 32;
const MAX_LEASE_MS = 10 * 60_000;
const MAX_DRAIN_MS = 60_000;

function readPositiveInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  maximum: number,
): number {
  const raw = env[name];

  if (raw === undefined || raw.trim().length === 0) {
    return fallback;
  }

  const value = Number(raw);

  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}.`);
  }

  return value;
}

export function isWorkerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HABI_P1_WORKER === '1';
}

export function readWorkerLoopConfig(
  env: NodeJS.ProcessEnv = process.env,
): WorkerLoopConfig {
  const concurrency = readPositiveInteger(
    env,
    'HABI_WORKER_CONCURRENCY',
    DEFAULT_CONCURRENCY,
    MAX_CONCURRENCY,
  );
  const batchSize = Math.min(
    concurrency,
    readPositiveInteger(
      env,
      'HABI_WORKER_BATCH_SIZE',
      concurrency,
      MAX_BATCH_SIZE,
    ),
  );
  const idleBackoffMs = readPositiveInteger(
    env,
    'HABI_WORKER_IDLE_BACKOFF_MS',
    DEFAULT_IDLE_BACKOFF_MS,
    60_000,
  );
  const maxIdleBackoffMs = Math.max(
    idleBackoffMs,
    readPositiveInteger(
      env,
      'HABI_WORKER_MAX_IDLE_BACKOFF_MS',
      DEFAULT_MAX_IDLE_BACKOFF_MS,
      300_000,
    ),
  );
  const leaseMs = readPositiveInteger(
    env,
    'HABI_WORKER_LEASE_MS',
    DEFAULT_LEASE_MS,
    MAX_LEASE_MS,
  );
  const drainMs = readPositiveInteger(
    env,
    'HABI_WORKER_DRAIN_MS',
    DEFAULT_DRAIN_MS,
    MAX_DRAIN_MS,
  );
  const recoveryLimit = readPositiveInteger(
    env,
    'HABI_WORKER_RECOVERY_LIMIT',
    DEFAULT_RECOVERY_LIMIT,
    1_000,
  );

  return {
    concurrency,
    batchSize,
    idleBackoffMs,
    maxIdleBackoffMs,
    leaseMs,
    drainMs,
    recoveryLimit,
    sweepIntervalMs: Math.max(250, Math.floor(leaseMs / 2)),
  };
}

/**
 * Returns the connection string for the worker pool, or throws. The message
 * names the variable and never the value.
 */
export function readDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.DATABASE_URL?.trim();

  if (value === undefined || value.length === 0) {
    throw new Error('DATABASE_URL is required when HABI_P1_WORKER=1.');
  }

  return value;
}

/**
 * Hermes is the only provider boundary wired into the worker. Missing
 * configuration is not an error: the worker starts, logs that no adapter is
 * configured, and claims nothing, so queued Runs are never failed merely
 * because a credential is absent in this environment.
 */
export function readHermesConfig(
  env: NodeJS.ProcessEnv = process.env,
): HermesWorkerConfig | null {
  const baseUrl = env.HABI_HERMES_BASE_URL?.trim() ?? '';
  const gatewayKey = env.HABI_HERMES_GATEWAY_KEY?.trim() ?? '';

  if (baseUrl.length === 0 && gatewayKey.length === 0) {
    return null;
  }

  if (baseUrl.length === 0 || gatewayKey.length === 0) {
    throw new Error(
      'HABI_HERMES_BASE_URL and HABI_HERMES_GATEWAY_KEY must be set together.',
    );
  }

  return {
    baseUrl,
    gatewayKey,
    ...readOptionalPositiveInteger(env, 'HABI_HERMES_REQUEST_TIMEOUT_MS'),
    ...readOptionalPositiveInteger(env, 'HABI_HERMES_EVENT_IDLE_TIMEOUT_MS'),
  };
}

function readOptionalPositiveInteger(
  env: NodeJS.ProcessEnv,
  name: string,
): { requestTimeoutMs?: number } | { eventIdleTimeoutMs?: number } {
  const raw = env[name];

  if (raw === undefined || raw.trim().length === 0) {
    return {};
  }

  const value = Number(raw);

  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return name === 'HABI_HERMES_REQUEST_TIMEOUT_MS'
    ? { requestTimeoutMs: value }
    : { eventIdleTimeoutMs: value };
}
