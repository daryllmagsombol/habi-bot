/**
 * Conditional module list for `AppModule`.
 *
 * Keeping the flag decision in one exported function makes the gate obvious and
 * testable without editing the root module. `HABI_AUTH_SPIKE=1` is the only
 * value that enables the surface; any other value, including unset, yields an
 * empty list.
 */
import type { DynamicModule, Type } from '@nestjs/common';
import { isAuthSpikeEnabled } from './auth-config.js';
import { AuthModule } from './auth.module.js';

export function authSpikeModules(
  env: NodeJS.ProcessEnv = process.env,
): Array<Type<unknown> | DynamicModule> {
  return isAuthSpikeEnabled(env) ? [AuthModule] : [];
}
