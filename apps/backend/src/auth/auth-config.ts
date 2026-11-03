/**
 * Auth-slice configuration.
 *
 * The HTTP surface is gated behind `HABI_AUTH_SPIKE=1`, matching the
 * H-005/H-017 spike discipline: unset means the routes are not part of the app.
 * The module also enforces the flag per request so an accidental unconditional
 * import cannot expose password handling.
 *
 * Registration is invite-only by default. `HABI_REGISTRATION_MODE=closed`
 * refuses new signups while leaving login and recovery unchanged. There is no
 * public-registration mode in this slice; choosing that is a separate owner
 * decision.
 */

export const AUTH_SPIKE_ENV = 'HABI_AUTH_SPIKE';
export const REGISTRATION_MODE_ENV = 'HABI_REGISTRATION_MODE';

export type RegistrationMode = 'invite' | 'closed';

export function isAuthSpikeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[AUTH_SPIKE_ENV] === '1';
}

export function readRegistrationMode(
  env: NodeJS.ProcessEnv = process.env,
): RegistrationMode {
  return env[REGISTRATION_MODE_ENV] === 'closed' ? 'closed' : 'invite';
}
