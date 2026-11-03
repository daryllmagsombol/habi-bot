/**
 * HTTP surface for the H-014 identity slice.
 *
 * Enabled only with `HABI_AUTH_SPIKE=1` (see `authSpikeModules` and
 * `AuthSpikeGuard`). Routes:
 *
 *   POST /auth/signup
 *   POST /auth/login
 *   POST /auth/logout
 *   POST /auth/recovery/request
 *   GET  /auth/me
 *
 * The session cookie is serialized by the H-017 cookie module and the CSRF
 * checks on logout are the H-017 guards. This controller does not reimplement
 * either; it only forwards the raw session secret into `Set-Cookie`.
 *
 * Error bodies are closed codes, never stack traces, emails, or invite/token
 * detail. `Retry-After` accompanies a 429.
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { authErrorBody, AuthError } from './auth-errors.js';
import type { AuthRequestContext, AuthService } from './auth-service.js';
import { AuthRuntime } from './auth-runtime.js';
import { AuthSpikeGuard } from './auth-spike.guard.js';
import type { AuthSessionResult } from './auth-types.js';
import {
  clearSessionCookie,
  readRequestSessionCookie,
  serializeSessionCookie,
} from '../session/session-cookie.js';
import { SessionAuthGuard } from '../session/session-auth.guard.js';
import { SessionCsrfGuard } from '../session/session-csrf.guard.js';
import { requireSession } from '../session/session-request.js';
import type { SessionRequest } from '../session/session-request.js';

interface AuthSessionBody {
  user: { userId: string; email: string };
  csrfToken: string;
}

function readField(body: unknown, name: string): string | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return undefined;
  }

  const value = (body as Record<string, unknown>)[name];

  return typeof value === 'string' ? value : undefined;
}

function requireField(body: unknown, name: string): string {
  const value = readField(body, name);

  if (value === undefined) {
    throw new HttpException(
      authErrorBody('invalid_request'),
      HttpStatus.BAD_REQUEST,
    );
  }

  return value;
}

function readUserAgent(request: Request): string | undefined {
  const value = request.headers['user-agent'];

  return typeof value === 'string' ? value : undefined;
}

function readClientIp(request: Request): string | undefined {
  const value = request.ip;

  return typeof value === 'string' && value.length > 0 ? value.slice(0, 128) : undefined;
}

function requestContext(request: Request): AuthRequestContext {
  const ip = readClientIp(request);
  const userAgent = readUserAgent(request);

  return {
    clientKey: ip ?? 'unknown',
    ...(userAgent === undefined ? {} : { userAgent }),
    ...(ip === undefined ? {} : { ip }),
  };
}

function writeIssuedSession(response: Response, result: AuthSessionResult): void {
  response.setHeader(
    'set-cookie',
    serializeSessionCookie(result.sessionSecret, result.maxAgeSeconds),
  );
  response.setHeader('x-csrf-token', result.csrfToken);
}

@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthRuntime) private readonly runtime: AuthRuntime) {}

  @Post('signup')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(AuthSpikeGuard)
  async signup(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthSessionBody> {
    response.setHeader('cache-control', 'no-store');

    const email = requireField(body, 'email');
    const password = requireField(body, 'password');
    const inviteToken = requireField(body, 'inviteToken');

    return this.execute(response, async () => {
      const result = await this.service().signup({
        ...requestContext(request),
        email,
        password,
        inviteToken,
      });

      writeIssuedSession(response, result);

      return { user: result.user, csrfToken: result.csrfToken };
    });
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthSpikeGuard)
  async login(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthSessionBody> {
    response.setHeader('cache-control', 'no-store');

    const email = requireField(body, 'email');
    const password = requireField(body, 'password');

    return this.execute(response, async () => {
      const result = await this.service().login({
        ...requestContext(request),
        email,
        password,
      });

      writeIssuedSession(response, result);

      return { user: result.user, csrfToken: result.csrfToken };
    });
  }

  /**
   * CSRF and Origin checks stay in the H-017 guards. A missing session is 401
   * before the handler; a missing/wrong token is 403 `csrf_invalid`.
   */
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthSpikeGuard, SessionAuthGuard, SessionCsrfGuard)
  logout(
    @Req() request: SessionRequest,
    @Res({ passthrough: true }) response: Response,
  ): { ok: true } {
    response.setHeader('cache-control', 'no-store');

    const sessionSecret = readRequestSessionCookie(request);

    if (sessionSecret !== undefined) {
      this.service().logout(sessionSecret);
    }

    response.setHeader('set-cookie', clearSessionCookie());

    return { ok: true };
  }

  /**
   * Always the same acknowledgement. A known account with a password records a
   * hashed token; an unknown address changes nothing visible.
   */
  @Post('recovery/request')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AuthSpikeGuard)
  async requestRecovery(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ ok: true }> {
    response.setHeader('cache-control', 'no-store');

    const email = requireField(body, 'email');

    return this.execute(response, async () => {
      await this.service().requestRecovery({
        ...requestContext(request),
        email,
      });

      return { ok: true };
    });
  }

  @Get('me')
  @UseGuards(AuthSpikeGuard, SessionAuthGuard)
  async me(
    @Req() request: SessionRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ user: { userId: string; email: string } }> {
    response.setHeader('cache-control', 'no-store');

    const session = requireSession(request);

    return this.execute(response, async () => {
      const identity = await this.service().getIdentity(session.userId);

      return { user: { userId: identity.userId, email: identity.email } };
    });
  }

  private service(): AuthService {
    return this.runtime.getService();
  }

  private async execute<T>(
    response: Response,
    action: () => Promise<T>,
  ): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof AuthError) {
        if (error.retryAfterSeconds !== undefined) {
          response.setHeader('retry-after', String(error.retryAfterSeconds));
        }

        throw new HttpException(authErrorBody(error.code), error.status);
      }

      throw error;
    }
  }
}
