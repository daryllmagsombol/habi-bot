/**
 * H-025 scenario: SSO providers.
 *
 * There is no way to complete a real Google, Microsoft, or Facebook sign-in
 * without registered client credentials and a reachable provider. The harness
 * reports each provider separately and names the exact missing registration
 * keys. A provider that is configured is still only "routing verified"; the
 * callback is blocked unless a real registration and stub IdP are supplied.
 */
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { BACKEND_ROOT } from '../lib/process.mjs';
import { createClient, startApiChild } from '../lib/http.mjs';
import { blocked, runCheck } from './_check.mjs';

const PROVIDERS = ['google', 'microsoft', 'facebook'];

async function ssoEnvVars() {
  const module = await import(
    pathToFileURL(join(BACKEND_ROOT, 'dist/auth/sso/sso-config.js')).href
  );

  return module.SSO_ENV_VARS;
}

export const ssoScenario = {
  id: 'sso',
  title: 'SSO per-provider registration and sign-in',
  async run(ctx) {
    const checks = [];
    const envVars = await ssoEnvVars();
    const api = await startApiChild({
      HABI_AUTH_SPIKE: '1',
      DATABASE_URL: ctx.postgres.url,
    });
    const blockers = [];

    try {
      const request = createClient(api.base);
      const advertised = await request('/auth/sso/providers');
      const advertisedIds =
        advertised.status === 200
          ? advertised.body.providers.map((provider) => provider.id)
          : [];

      for (const providerId of PROVIDERS) {
        const vars = envVars[providerId];
        const required = [
          vars.clientId,
          vars.clientSecret,
          vars.redirectUri,
          ...(providerId === 'microsoft' ? [vars.issuer] : []),
        ];
        const missing = required.filter((name) => {
          const value = process.env[name];

          return value === undefined || value.trim() === '';
        });

        if (missing.length > 0) {
          const start = await request(`/auth/sso/${providerId}/start`, {
            method: 'POST',
            body: {},
          });

          checks.push(
            blocked(
              `${providerId}: real registration is available`,
              `Missing registration keys: ${missing.join(', ')}`,
              {
                provider: providerId,
                advertised: advertisedIds.includes(providerId),
                startRouteStatus: start.status,
                missingKeys: missing,
              },
            ),
          );

          await runCheck(
            checks,
            `${providerId}: unconfigured provider exposes no start route`,
            async () => {
              if (start.status !== 404) {
                throw new Error(
                  `unconfigured ${providerId} start returned ${start.status}, expected 404`,
                );
              }

              return { status: start.status };
            },
          );

          blockers.push(
            `${providerId}: missing ${missing.join(', ')}`,
          );
          continue;
        }

        await runCheck(checks, `${providerId}: configured provider is advertised`, async () => {
          if (!advertisedIds.includes(providerId)) {
            throw new Error(`${providerId} is configured but not advertised`);
          }

          return { advertisedIds };
        });

        await runCheck(checks, `${providerId}: configured provider start routes to the IdP`, async () => {
          const result = await request(`/auth/sso/${providerId}/start`, {
            method: 'POST',
            body: {},
            headers: { origin: api.base },
          });

          if (result.status < 300 || result.status >= 400) {
            throw new Error(`expected a redirect to the provider, got ${result.status}`);
          }

          return {
            startStatus: result.status,
            redirectHost: new URL(result.headers.get('location')).host,
          };
        });

        checks.push(
          blocked(
            `${providerId}: callback completes a real sign-in`,
            'Provider registration is present, but this harness has no stub IdP or real user consent flow; the callback is not exercised.',
            { provider: providerId },
          ),
        );
        blockers.push(
          `${providerId}: callback/sign-in needs a registered redirect URI and a reachable IdP`,
        );
      }

      return {
        checks,
        evidence: {
          providersRouteStatus: advertised.status,
          advertisedIds,
        },
        blockers,
        residualRisks: [
          'Routing a start request is not a sign-in. Token exchange, nonce/state binding, JWKS rotation, and account linking are covered by the existing SSO smoke suite, not by a live provider here.',
        ],
      };
    } finally {
      await api.stop();
    }
  },
};
