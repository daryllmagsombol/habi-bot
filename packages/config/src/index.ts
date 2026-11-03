/**
 * Runtime-agnostic shared configuration.
 *
 * Everything exported here is pure: no Node built-ins, no filesystem, no
 * network, and no environment reads at import time. Server-only entry points
 * stay in the applications that own them, so importing this package from the
 * browser cannot leak secrets or privileged code.
 */
export { EnvValidationError, NODE_ENV_VALUES, parseEnv } from './env.js';
export type { Env, EnvIssue, NodeEnv } from './env.js';
