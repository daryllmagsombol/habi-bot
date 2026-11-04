/**
 * Session + CSRF guards for the SSO linking and unlinking surfaces.
 *
 * These are thin wrappers over the H-017 rules (`SessionService.validate`,
 * `csrfTokenMatches`, `isSameOrigin`) because the H-017 guard classes inject
 * `SessionService` directly and would create a second instance if declared here.
 * The validation logic is not re-implemented: a failure is the same uniform
 * `401 unauthenticated` / `403 csrf_invalid` the rest of the auth surface returns.
 *
 * Order matters: the session guard runs first and attaches the validated record;
 * the CSRF guard only reads that attachment.
 */
import { ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { readRequestSessionCookie } from '../../session/session-cookie.js';
import { isSameOrigin } from '../../session/session-request.js';
import { csrfTokenMatches } from '../../session/session.service.js';
import { SsoRuntime } from './sso-runtime.js';

export interface SsoSessionAttachment {
  readonly userId: string;
  readonly sessionSecret: string;
  readonly csrfToken: string;
}

export interface SsoSessionRequest extends Request {
  ssoSession?: SsoSessionAttachment;
}

function requireSsoSession(request: SsoSessionRequest): SsoSessionAttachment {
  const session = request.ssoSession;

  if (session === undefined) {
    throw new UnauthorizedException({ error: { code: 'unauthenticated' } });
  }

  return session;
}

@Injectable()
export class SsoSessionGuard implements CanActivate {
  constructor(@Inject(SsoRuntime) private readonly runtime: SsoRuntime) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<SsoSessionRequest>();
    const sessionSecret = readRequestSessionCookie(request);
    const session =
      sessionSecret === undefined
        ? undefined
        : this.runtime.getSessions().validate(sessionSecret, Date.now());

    if (sessionSecret === undefined || session === undefined) {
      throw new UnauthorizedException({ error: { code: 'unauthenticated' } });
    }

    request.ssoSession = {
      userId: session.userId,
      sessionSecret,
      csrfToken: session.csrfToken,
    };

    return true;
  }
}

@Injectable()
export class SsoCsrfGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<SsoSessionRequest>();
    const session = requireSsoSession(request);
    const header = request.headers['x-csrf-token'];

    if (
      !csrfTokenMatches(session.csrfToken, typeof header === 'string' ? header : undefined) ||
      !isSameOrigin(request)
    ) {
      throw new ForbiddenException({ error: { code: 'csrf_invalid' } });
    }

    return true;
  }
}
