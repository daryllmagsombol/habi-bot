/**
 * Conditional module list for `AppModule`.
 *
 * Keeping the flag decision in one exported function makes the gate obvious and
 * testable without editing the root module. `HABI_AUTH_SPIKE=1` is the only
 * value that enables the surface; any other value, including unset, yields an
 * empty list.
 *
 * The H-015 SSO module is nested under the same flag and is added only when at
 * least one provider is fully configured (`HABI_SSO_<PROVIDER>_CLIENT_ID`,
 * `_CLIENT_SECRET`, `_REDIRECT_URI`; Microsoft also needs `_ISSUER`). SSO is part
 * of the auth surface, not a second gate: disabling the auth spike disables SSO,
 * and absent provider configuration means the provider's routes are never
 * registered.
 */
import type { DynamicModule, Type } from '@nestjs/common';
import { isAuthSpikeEnabled } from './auth-config.js';
import { AuthModule } from './auth.module.js';
import { ssoSpikeModules } from './sso/sso.module.js';

export function authSpikeModules(
  env: NodeJS.ProcessEnv = process.env,
): Array<Type<unknown> | DynamicModule> {
  if (!isAuthSpikeEnabled(env)) {
    return [];
  }

  return [AuthModule, ...ssoSpikeModules(env)];
}
