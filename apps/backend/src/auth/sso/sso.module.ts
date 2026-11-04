/**
 * SSO feature module (H-015), registered by `authSpikeModules`.
 *
 * `forRoot(env)` returns `undefined` when no provider is fully configured. The
 * caller then registers no SSO module at all, so the routes genuinely do not
 * exist rather than existing and refusing.
 *
 * The module imports `AuthModule` for two reasons: sessions issued here must be
 * the same records `GET /auth/me` validates, and the H-014 invite/credential
 * tables and services are the registration gate this slice reuses. It does not
 * extend or modify the H-014 controller or service.
 *
 * `AuthSpikeGuard` is declared here (it is stateless) so every SSO route keeps
 * the per-request flag check even though the module is only registered when the
 * flag is on.
 */
import { Module } from '@nestjs/common';
import type { DynamicModule, Type } from '@nestjs/common';
import { AuthModule } from '../auth.module.js';
import { AuthSpikeGuard } from '../auth-spike.guard.js';
import { readSsoConfig } from './sso-config.js';
import { buildSsoProviders } from './sso-providers.js';
import { SSO_CONFIG, SSO_PROVIDERS, SSO_SESSION_PORT, SsoRuntime } from './sso-runtime.js';
import { SsoSessionBridge } from './sso-session-bridge.js';
import { SsoCsrfGuard, SsoSessionGuard } from './sso-guards.js';
import {
  createSsoIdentitiesController,
  createSsoProviderController,
} from './sso.controller.js';

@Module({})
export class SsoModule {
  /**
   * Builds the module for the given environment. Configuration is read once, at
   * composition time, so a provider cannot be half-enabled between requests.
   */
  static forRoot(env: NodeJS.ProcessEnv = process.env): DynamicModule | undefined {
    const config = readSsoConfig(env);

    if (config.providers.length === 0) {
      return undefined;
    }

    const providers = buildSsoProviders(config);
    const controllers: Type<unknown>[] = [
      createSsoIdentitiesController(),
      ...config.providers.map((provider) => createSsoProviderController(provider.id)),
    ];

    return {
      module: SsoModule,
      imports: [AuthModule],
      controllers,
      providers: [
        { provide: SSO_CONFIG, useValue: config },
        { provide: SSO_PROVIDERS, useValue: providers },
        SsoSessionBridge,
        { provide: SSO_SESSION_PORT, useExisting: SsoSessionBridge },
        SsoRuntime,
        AuthSpikeGuard,
        SsoSessionGuard,
        SsoCsrfGuard,
      ],
    };
  }
}

/** `authSpikeModules` helper: zero or one gated SSO module. */
export function ssoSpikeModules(env: NodeJS.ProcessEnv = process.env): DynamicModule[] {
  const module = SsoModule.forRoot(env);

  return module === undefined ? [] : [module];
}
