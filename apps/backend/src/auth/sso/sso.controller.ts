/**
 * HTTP surface for the SSO slice.
 *
 * Routes are created per enabled provider, so a provider whose configuration is
 * absent has no controller, no route, and no advertisement. There is no shared
 * `:provider` route, which means an unknown provider cannot fall through to a
 * generic handler.
 *
 *   POST /auth/sso/:provider/start        begin login/signup (invite optional)
 *   GET  /auth/sso/:provider/callback     provider redirect (GET-only exception)
 *   POST /auth/sso/:provider/link/start   begin explicit linking
 *   POST /auth/sso/:provider/unlink       revoke this user's link
 *   GET  /auth/sso/providers              enabled providers (no secrets)
 *   GET  /auth/sso/identities             this user's linked identities
 *
 * Callback origin rule: a browser does not send `Origin` on the provider's
 * top-level cross-site GET redirect, and the `Referer` names the provider, not
 * this app. The callback therefore does not treat Origin/Referer as proof; the
 * controls that actually bind it are the single-use `state` and the independent
 * browser-binding cookie (H-008 §5.1, §5.3). Origin validation stays on the
 * POST routes, including `link/start`.
 *
 * Response rules:
 * - `cache-control: no-store` on every route.
 * - The session secret appears only in `Set-Cookie`; the CSRF token only in
 *   `X-CSRF-Token`. Neither appears in a URL, a JSON body, or a log line.
 * - The authorization URL carries `state`, `nonce`, and the PKCE challenge, which
 *   are not secrets and are required by the protocol. It never carries a code,
 *   token, verifier, or client secret.
 * - Errors are closed codes; provider error text is never forwarded.
 */
import {
  Body,
  Controller,
  Get,
  Inject,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Type } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthSpikeGuard } from '../auth-spike.guard.js';
import {
  readSessionCookie,
  serializeSessionCookie,
} from '../../session/session-cookie.js';
import { isSameOrigin } from '../../session/session-request.js';
import { SsoError, ssoErrorBody } from './sso-errors.js';
import {
  clearSsoBindingCookie,
  readSsoBindingCookie,
  serializeSsoBindingCookie,
} from './sso-cookies.js';
import type { SsoProviderId } from './sso-config.js';
import { SsoRuntime } from './sso-runtime.js';
import type { SsoCallbackResult, SsoStartResult } from './sso-types.js';
import { SsoCsrfGuard, SsoSessionGuard } from './sso-guards.js';
import type { SsoSessionRequest } from './sso-guards.js';

function readBodyField(body: unknown, name: string): string | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return undefined;
  }

  const value = (body as Record<string, unknown>)[name];

  return typeof value === 'string' ? value : undefined;
}

function readQueryField(query: Record<string, unknown>, name: string): string | undefined {
  const value = query[name];

  return typeof value === 'string' ? value : undefined;
}

function readClientKey(request: Request): string {
  return typeof request.ip === 'string' && request.ip.length > 0
    ? request.ip.slice(0, 128)
    : 'unknown';
}

function requestContext(request: Request): {
  clientKey: string;
  userAgent?: string;
  ip?: string;
} {
  const value = request.headers['user-agent'];
  const ip =
    typeof request.ip === 'string' && request.ip.length > 0 ? request.ip : undefined;

  return {
    clientKey: readClientKey(request),
    ...(typeof value === 'string' ? { userAgent: value } : {}),
    ...(ip === undefined ? {} : { ip }),
  };
}

function bindingCookie(request: Request): string | undefined {
  return readSsoBindingCookie(request.headers.cookie);
}

/**
 * Writes the response explicitly (no passthrough) because the callback returns
 * 302 for a login and 200 for a link; that status is part of the contract.
 */
abstract class SsoResponseWriter {
  protected prepare(response: Response): void {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('referrer-policy', 'no-referrer');
  }

  protected async run(response: Response, action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      if (error instanceof SsoError) {
        if (error.retryAfterSeconds !== undefined) {
          response.setHeader('retry-after', String(error.retryAfterSeconds));
        }

        response.status(error.status).json(ssoErrorBody(error.code));
        return;
      }

      throw error;
    }
  }

  protected writeRedirect(response: Response, result: SsoStartResult): void {
    response.setHeader(
      'set-cookie',
      serializeSsoBindingCookie(result.bindingSecret, result.bindingMaxAgeSeconds),
    );
    response.status(302);
    response.setHeader('location', result.authorizeUrl);
    response.end();
  }

  protected writeCallback(
    response: Response,
    result: SsoCallbackResult,
  ): void {
    if (result.kind === 'link') {
      response.setHeader('set-cookie', clearSsoBindingCookie());
      response.status(200).json({ ok: true, provider: result.provider });
      return;
    }

    response.setHeader('set-cookie', [
      serializeSessionCookie(result.session.sessionSecret, result.session.maxAgeSeconds),
      clearSsoBindingCookie(),
    ]);
    response.setHeader('x-csrf-token', result.session.csrfToken);
    response.status(302);
    response.setHeader('location', result.returnTo);
    response.end();
  }
}

/**
 * Builds the controller for one configured provider. A provider that is not
 * configured never gets an instance, so its paths are absent from the router.
 */
export function createSsoProviderController(providerId: SsoProviderId): Type<unknown> {
  @Controller(`auth/sso/${providerId}`)
  class SsoProviderController extends SsoResponseWriter {
    constructor(@Inject(SsoRuntime) private readonly runtime: SsoRuntime) {
      super();
    }

    @Post('start')
    @UseGuards(AuthSpikeGuard)
    async start(
      @Body() body: unknown,
      @Req() request: Request,
      @Res() response: Response,
    ): Promise<void> {
      this.prepare(response);

      await this.run(response, async () => {
        if (!isSameOrigin(request)) {
          throw new SsoError('invalid_request');
        }

        const inviteToken = readBodyField(body, 'inviteToken');
        const returnTo = readBodyField(body, 'returnTo');

        const result = await this.runtime.getService().start({
          providerId,
          ...requestContext(request),
          ...(inviteToken === undefined ? {} : { inviteToken }),
          ...(returnTo === undefined ? {} : { returnTo }),
        });

        this.writeRedirect(response, result);
      });
    }

    @Get('callback')
    @UseGuards(AuthSpikeGuard)
    async callback(
      @Query() query: Record<string, unknown>,
      @Req() request: Request,
      @Res() response: Response,
    ): Promise<void> {
      this.prepare(response);

      await this.run(response, async () => {
        // A cross-site callback POST is not a supported response mode (H-008
        // §5.3); the route is GET-only, and the binding cookie is not sent on a
        // cross-site POST. Origin is not consulted here: the provider's redirect
        // is cross-site by nature.
        const state = readQueryField(query, 'state');
        const code = readQueryField(query, 'code');
        const providerError = readQueryField(query, 'error');
        const bindingSecret = bindingCookie(request);
        const sessionSecret = readSessionCookieSecret(request);

        const result = await this.runtime.getService().callback({
          providerId,
          ...requestContext(request),
          ...(state === undefined ? {} : { state }),
          ...(code === undefined ? {} : { code }),
          ...(providerError === undefined ? {} : { providerError }),
          ...(bindingSecret === undefined ? {} : { bindingSecret }),
          ...(sessionSecret === undefined ? {} : { sessionSecret }),
        });

        this.writeCallback(response, result);
      });
    }

    @Post('link/start')
    @UseGuards(AuthSpikeGuard, SsoSessionGuard, SsoCsrfGuard)
    async linkStart(
      @Body() body: unknown,
      @Req() request: SsoSessionRequest,
      @Res() response: Response,
    ): Promise<void> {
      this.prepare(response);

      await this.run(response, async () => {
        const session = request.ssoSession;

        if (session === undefined) {
          throw new SsoError('unauthenticated');
        }

        const returnTo = readBodyField(body, 'returnTo');
        const result = await this.runtime.getService().linkStart({
          providerId,
          ...requestContext(request),
          userId: session.userId,
          sessionSecret: session.sessionSecret,
          ...(returnTo === undefined ? {} : { returnTo }),
        });

        this.writeRedirect(response, result);
      });
    }

    @Post('unlink')
    @UseGuards(AuthSpikeGuard, SsoSessionGuard, SsoCsrfGuard)
    async unlink(
      @Req() request: SsoSessionRequest,
      @Res() response: Response,
    ): Promise<void> {
      this.prepare(response);

      await this.run(response, async () => {
        const session = request.ssoSession;

        if (session === undefined) {
          throw new SsoError('unauthenticated');
        }

        await this.runtime.getService().unlink({
          providerId,
          userId: session.userId,
        });

        response.status(200).json({ ok: true });
      });
    }
  }

  return SsoProviderController;
}

function readSessionCookieSecret(request: Request): string | undefined {
  // Delegated to the shared reader so cookie naming stays in one place.
  return readSessionCookie(request.headers.cookie);
}

/**
 * Advertisement and linked-identity listing. Both routes exist only when at
 * least one provider is configured, which is the same condition that creates the
 * SSO module at all.
 */
export function createSsoIdentitiesController(): Type<unknown> {
  @Controller('auth/sso')
  class SsoIdentitiesController extends SsoResponseWriter {
    constructor(@Inject(SsoRuntime) private readonly runtime: SsoRuntime) {
      super();
    }

    @Get('providers')
    @UseGuards(AuthSpikeGuard)
    providers(@Res() response: Response): void {
      this.prepare(response);
      response.status(200).json({ providers: this.runtime.advertisedProviders() });
    }

    @Get('identities')
    @UseGuards(AuthSpikeGuard, SsoSessionGuard)
    async identities(
      @Req() request: SsoSessionRequest,
      @Res() response: Response,
    ): Promise<void> {
      this.prepare(response);

      await this.run(response, async () => {
        const session = request.ssoSession;

        if (session === undefined) {
          throw new SsoError('unauthenticated');
        }

        const identities = await this.runtime.getService().listIdentities(session.userId);

        response.status(200).json({ identities });
      });
    }
  }

  return SsoIdentitiesController;
}
