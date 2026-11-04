/**
 * Builds the provider registry from configuration.
 *
 * The registry contains exactly the providers that passed configuration
 * validation. Nothing else in the slice branches on a provider id except this
 * factory, so a new provider is an implementation of `SsoProvider` plus a config
 * reader.
 */
import type { SsoProvider, SsoProviderId } from './sso-types.js';
import type { SsoConfig, SsoProviderConfig } from './sso-config.js';
import { FacebookSsoProvider } from './facebook-provider.js';
import { OidcSsoProvider } from './oidc-provider.js';
import { OidcVerifier } from './oidc-verifier.js';

function createProvider(config: SsoProviderConfig, fetchImpl: typeof fetch): SsoProvider {
  if (config.id === 'facebook') {
    return new FacebookSsoProvider(config, fetchImpl);
  }

  if (
    config.issuer === undefined ||
    config.jwksUri === undefined
  ) {
    throw new Error(`provider ${config.id} is missing OIDC metadata`);
  }

  return new OidcSsoProvider(
    config,
    new OidcVerifier({
      issuer: config.issuer,
      audience: config.clientId,
      jwksUri: config.jwksUri,
      fetchImpl,
    }),
    fetchImpl,
  );
}

export function buildSsoProviders(
  config: SsoConfig,
  fetchImpl: typeof fetch = fetch,
): Map<SsoProviderId, SsoProvider> {
  const providers = new Map<SsoProviderId, SsoProvider>();

  for (const providerConfig of config.providers) {
    providers.set(providerConfig.id, createProvider(providerConfig, fetchImpl));
  }

  return providers;
}
