/**
 * Configuration for the P1 chat composition surface (H-018).
 *
 * This is a composition gate, not product authentication. When
 * `HABI_P1_API` is not exactly `1`, `AppModule` does not import the module and
 * none of these routes exist. The surface still authenticates with the H-017
 * session contract, which is an in-memory contract slice: a process restart
 * drops every session. There is no provider credential, model call, or durable
 * session store here.
 */

/** Only this exact value enables the surface. */
export const P1_API_FLAG = 'HABI_P1_API';

/**
 * Test/composition knob for the SSE heartbeat. Kept as an environment value so
 * the smoke suite can observe a heartbeat without waiting fifteen seconds.
 */
export const SSE_HEARTBEAT_ENV = 'HABI_P1_API_SSE_HEARTBEAT_MS';

export const DEFAULT_SSE_HEARTBEAT_MS = 15_000;
export const MIN_SSE_HEARTBEAT_MS = 250;
export const MAX_SSE_HEARTBEAT_MS = 60_000;

/**
 * Safety bound for one SSE connection. A client reconnects with
 * `Last-Event-ID`; there is no infinite, unbounded response.
 */
export const SSE_MAX_CONNECTION_MS = 60_000;

export function isP1ApiEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[P1_API_FLAG] === '1';
}

export function readSseHeartbeatMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[SSE_HEARTBEAT_ENV]?.trim();

  if (raw === undefined || raw.length === 0 || !/^\d+$/.test(raw)) {
    return DEFAULT_SSE_HEARTBEAT_MS;
  }

  const value = Number(raw);

  if (!Number.isSafeInteger(value)) {
    return DEFAULT_SSE_HEARTBEAT_MS;
  }

  return Math.min(Math.max(value, MIN_SSE_HEARTBEAT_MS), MAX_SSE_HEARTBEAT_MS);
}
